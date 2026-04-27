#!/usr/bin/env node
/**
 * Legacy camp shared_slots クリーンアップスクリプト
 *
 * 2026-04-28: キャンプ場が「容量8の単一shared_slots」方式から
 * 「camp_1〜camp_8 個別slots」方式に移行したため、旧 shared_slots/camp|...
 * のドキュメントを削除する。
 *
 * 既存のキャンプ予約レコード（reservations コレクション）は historical reference
 * として残し、cancel API の互換ルートで対応する（今後新規発生はしない）。
 *
 * 使い方:
 *   node clear_legacy_camp_shared_slots_20260428.js          # DRY-RUN
 *   node clear_legacy_camp_shared_slots_20260428.js --apply  # 実削除
 */

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--apply');
console.log('Mode:', DRY_RUN ? 'DRY-RUN' : 'APPLY');
console.log('');

(async () => {
  // shared_slots/camp|YYYY-MM-DD|HH 形式のドキュメントを検索
  const snap = await db.collection('shared_slots')
    .where('roomId', '==', 'camp')
    .get();

  console.log(`Found legacy camp shared_slots: ${snap.size}`);
  let deleted = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    console.log(`  ${doc.id} | used=${data.used}/${data.capacity} | reservations=${(data.reservationIds || []).length}`);
    if (!DRY_RUN) {
      await doc.ref.delete();
      deleted++;
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log('legacy shared_slots/camp scanned:', snap.size);
  if (!DRY_RUN) console.log('deleted:', deleted);
  else console.log('(DRY-RUN: no changes applied)');

  // 既存のキャンプreservationsは残す（cancel API の isLegacySharedCamp ルートで対応）
  const resSnap = await db.collection('reservations')
    .where('isCamp', '==', true)
    .get();
  console.log('');
  console.log(`Existing legacy camp reservations (kept as historical reference): ${resSnap.size}`);
  for (const d of resSnap.docs) {
    const x = d.data();
    console.log(`  ${d.id} | ${x.startDate} -> ${x.endDate} | customer=${x.customer && x.customer.name}`);
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
