// migrations/004_backfill_display_id_20260513.ts
//
// 2026-05-13 適用済（scripts/backfill_display_id_20260513.js --apply で 209件書込み完了）。
// このファイルは migration 履歴の管理用 record。実行ロジックは scripts/ の同名 .js が SSOT。
//
// 関連コミット: 7a5adc5（旧端コードレビュー対応） / 直後の sheet schema change commit
// 関連要望: スプシ「予約システム改修要望」#8（予約番号が複雑で長い）

import * as admin from 'firebase-admin';

export const META = {
  id: '004_backfill_display_id_20260513',
  description: '全 reservations ドキュメントに displayId (F-XXXXXX) を backfill',
  appliedDate: '2026-05-13',
  reversible: true, // displayId フィールド削除で undo 可能だが、現状運営側 SoT に組み込まれるため実質片道
};

/**
 * Firestore reservations 全件に displayId フィールドを追加する。
 *
 * 適用済記録：
 *   - 実行日時: 2026-05-13
 *   - 対象件数: 209件（全件）
 *   - 衝突: なし（全 displayId ユニーク）
 *   - 実行スクリプト: scripts/backfill_display_id_20260513.js --apply
 */
export async function up(db: admin.firestore.Firestore, opts: { dryRun: boolean }) {
  const snap = await db.collection('reservations').get();
  let toBackfill = 0;
  let alreadyHas = 0;
  for (const doc of snap.docs) {
    if (doc.data().displayId) { alreadyHas++; continue; }
    toBackfill++;
    if (!opts.dryRun) {
      const displayId = 'F-' + doc.id.substring(0, 6).toUpperCase();
      await doc.ref.update({ displayId });
    }
  }
  return { total: snap.size, alreadyHas, toBackfill };
}

/** displayId フィールドを全 reservations から削除（FieldValue.delete）。基本的に実行不要。 */
export async function down(db: admin.firestore.Firestore, opts: { dryRun: boolean }) {
  const snap = await db.collection('reservations').get();
  let removed = 0;
  for (const doc of snap.docs) {
    if (!doc.data().displayId) continue;
    if (!opts.dryRun) {
      await doc.ref.update({ displayId: admin.firestore.FieldValue.delete() });
    }
    removed++;
  }
  return { removed };
}
