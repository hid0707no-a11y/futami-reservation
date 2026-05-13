// migration 004 (displayId backfill) の up/down 動作検証 integration test
//
// 2026-05-13 新設（ハーネスエンジニアリング監査・migration down() の信頼性検証）。
// `reversible: true` を META 宣言しているが本番未検証だった。Firestore Emulator で
// up → down → 再 up の往復が問題なく動くことを保証する。

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';

import * as admin from 'firebase-admin';
import { up, down, META } from '../../migrations/004_backfill_display_id_20260513';

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
}
const db = admin.firestore();

async function clearReservations() {
  // Emulator 全消去（reservations コレクションのみ対象）
  const snap = await db.collection('reservations').get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  if (snap.size > 0) await batch.commit();
}

async function seedReservations(count: number, withDisplayId: boolean = false) {
  for (let i = 0; i < count; i++) {
    const ref = db.collection('reservations').doc(`seed_${i}_${Date.now()}`);
    const data: any = {
      planId: 'normal_27',
      roomIds: ['room_27'],
      startDate: '2026-06-01',
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (withDisplayId) data.displayId = 'F-PREEXIST';
    await ref.set(data);
  }
}

describe('migration 004_backfill_display_id_20260513', () => {
  beforeEach(async () => {
    await clearReservations();
  });

  it('META が想定通りの ID/reversible で宣言されている', () => {
    expect(META.id).toBe('004_backfill_display_id_20260513');
    expect(META.reversible).toBe(true);
    expect(META.appliedDate).toBe('2026-05-13');
  });

  it('dry-run では書込みが発生しない', async () => {
    await seedReservations(3, false);
    const before = await db.collection('reservations').get();
    const beforeIds = before.docs.map(d => ({ id: d.id, hasDisplayId: !!d.data().displayId }));
    expect(beforeIds.every(b => !b.hasDisplayId)).toBe(true);

    const result = await up(db, { dryRun: true });
    expect(result.toBackfill).toBe(3);
    expect(result.alreadyHas).toBe(0);

    const after = await db.collection('reservations').get();
    expect(after.docs.every(d => !d.data().displayId)).toBe(true);
  }, 15000);

  it('apply で全ドキュメントに displayId が設定される（F- prefix + 6文字大文字）', async () => {
    await seedReservations(5, false);
    await up(db, { dryRun: false });

    const snap = await db.collection('reservations').get();
    expect(snap.size).toBe(5);
    snap.forEach(d => {
      const data = d.data();
      expect(data.displayId).toMatch(/^F-[A-Z0-9]{6}$/);
    });
  }, 15000);

  it('再 apply（冪等性）：既に displayId 設定済みは skip', async () => {
    await seedReservations(3, false);
    const first = await up(db, { dryRun: false });
    expect(first.toBackfill).toBe(3);

    const second = await up(db, { dryRun: false });
    expect(second.toBackfill).toBe(0);
    expect(second.alreadyHas).toBe(3);
  }, 15000);

  it('down() で全 displayId が削除される（reversible: true の実装契約）', async () => {
    await seedReservations(4, false);
    await up(db, { dryRun: false });

    // 念のため up 後に displayId が入っていることを確認
    const after = await db.collection('reservations').get();
    expect(after.docs.every(d => !!d.data().displayId)).toBe(true);

    const result = await down(db, { dryRun: false });
    expect((result as { removed: number }).removed).toBe(4);

    const final = await db.collection('reservations').get();
    final.forEach(d => {
      expect(d.data().displayId).toBeUndefined();
    });
  }, 15000);

  it('down() dry-run は実書込みなし（wouldRemove で件数のみ返す）', async () => {
    await seedReservations(2, false);
    await up(db, { dryRun: false });

    const result = await down(db, { dryRun: true });
    // 2026-05-13: dry-run は wouldRemove フィールドで返す（旧版の removed と誤読を防止）
    expect((result as { wouldRemove: number }).wouldRemove).toBe(2);
    expect((result as any).removed).toBeUndefined();

    const final = await db.collection('reservations').get();
    expect(final.docs.every(d => !!d.data().displayId)).toBe(true);
  }, 15000);

  it('up → down → up の往復で同じ displayId が復元される（決定論的生成）', async () => {
    await seedReservations(3, false);
    await up(db, { dryRun: false });
    const firstSnap = await db.collection('reservations').get();
    const firstIds = new Map(firstSnap.docs.map(d => [d.id, d.data().displayId]));

    await down(db, { dryRun: false });
    await up(db, { dryRun: false });

    const secondSnap = await db.collection('reservations').get();
    secondSnap.forEach(d => {
      expect(d.data().displayId).toBe(firstIds.get(d.id));
    });
  }, 15000);
});

afterAll(async () => {
  await admin.app().delete();
});
