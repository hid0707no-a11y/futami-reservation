#!/usr/bin/env node
/**
 * displayId backfill スクリプト（2026-05-13・要望#8 関連）
 *
 * 2026-05-13 リリースの commit 94f9045 で displayId（人間可読 8文字予約番号）を導入したが、
 * それ以前に作成された予約には displayId フィールドが存在しない。staff画面側で fallback
 * 表示はできるが、Firestore where 検索（運営が「F-XXXXXX」と聞いて検索する場面）でヒット
 * しないため、過去全件に displayId を一括書込みする。
 *
 * 使い方:
 *   node scripts/backfill_display_id_20260513.js          # dry run（書込なし）
 *   node scripts/backfill_display_id_20260513.js --apply  # 実書込
 *
 * 動作:
 *   1. reservations コレクション全件取得
 *   2. displayId フィールド未設定のドキュメントを対象に generateDisplayId(doc.id) を生成
 *   3. --apply 指定時のみ batch.update で書込（500件単位）
 *
 * 安全装置:
 *   - dry run がデフォルト
 *   - 既に displayId がある予約はスキップ（冪等性）
 *   - 誤プロジェクト防止（FIREBASE_PROJECT_ID チェック）
 */

const admin = require('../functions/node_modules/firebase-admin');

const EXPECTED_PROJECT = 'futami-yoyaku-492607';
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== EXPECTED_PROJECT) {
  console.error(`[abort] FIREBASE_PROJECT_ID mismatch: expected ${EXPECTED_PROJECT}, got ${process.env.FIREBASE_PROJECT_ID}`);
  process.exit(1);
}

const apply = process.argv.includes('--apply');

admin.initializeApp({ projectId: EXPECTED_PROJECT });
const db = admin.firestore();

// functions/src/lib/format.ts の generateDisplayId と同じロジック
function generateDisplayId(autoId) {
  if (!autoId) return '';
  return 'F-' + autoId.substring(0, 6).toUpperCase();
}

async function main() {
  console.log(`[backfill] mode=${apply ? 'APPLY' : 'dry-run'}, project=${EXPECTED_PROJECT}`);
  const snap = await db.collection('reservations').get();
  console.log(`[backfill] total reservations: ${snap.size}`);

  const targets = [];
  const collisions = new Map(); // displayId → [docIds]
  let alreadyHas = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.displayId) { alreadyHas++; continue; }
    const displayId = generateDisplayId(doc.id);
    targets.push({ id: doc.id, displayId });
    if (!collisions.has(displayId)) collisions.set(displayId, []);
    collisions.get(displayId).push(doc.id);
  }

  console.log(`[backfill] already has displayId: ${alreadyHas}`);
  console.log(`[backfill] to backfill: ${targets.length}`);

  // 衝突レポート（同じ displayId に紐づく内部 ID が複数ある場合）
  const dups = [...collisions.entries()].filter(([, ids]) => ids.length > 1);
  if (dups.length > 0) {
    console.warn(`[backfill] ⚠️ displayId COLLISIONS detected: ${dups.length} 件`);
    for (const [displayId, ids] of dups) {
      console.warn(`  ${displayId}: ${ids.join(', ')}`);
    }
    console.warn('  → 衝突した予約はスキップ（後で人手対応）。一意な分のみ backfill。');
  }

  // 衝突ドキュメントは backfill 対象から除外
  const collidingIds = new Set(dups.flatMap(([, ids]) => ids));
  const safeTargets = targets.filter(t => !collidingIds.has(t.id));
  console.log(`[backfill] safe to write (no collision): ${safeTargets.length}`);

  if (!apply) {
    console.log('[backfill] dry-run: showing first 10 samples');
    safeTargets.slice(0, 10).forEach(t => console.log(`  ${t.id} -> ${t.displayId}`));
    console.log('\n[backfill] re-run with --apply to actually write');
    return;
  }

  // batch update（500件単位）
  const BATCH_SIZE = 400;
  let written = 0;
  for (let i = 0; i < safeTargets.length; i += BATCH_SIZE) {
    const chunk = safeTargets.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(t => {
      batch.update(db.collection('reservations').doc(t.id), { displayId: t.displayId });
    });
    await batch.commit();
    written += chunk.length;
    console.log(`[backfill] wrote ${written}/${safeTargets.length}`);
  }
  console.log(`[backfill] ✅ done. wrote ${written} displayId fields`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
