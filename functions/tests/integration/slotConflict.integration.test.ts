// 予約スロット競合検出の integration test（createReservation の核心ロジック）
//
// 2026-05-05 新設。
// createReservation 全体は onRequest でテスト困難なので、その中核である
// 「Firestore トランザクションで slot 競合を検出」する部分を直接検証する。

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
}
const db = admin.firestore();

/**
 * createReservation 内のトランザクションロジックを抽出した最小再現関数。
 * 旧 index.ts → handlers/createReservation.ts の通常プランブランチと同じロジック。
 */
async function reserveSlotsWithConflictCheck(slotKeys: string[]): Promise<{ ok: true; reservationId: string } | { ok: false; conflicts: string[] }> {
  try {
    const result = await db.runTransaction(async tx => {
      const slotRefs = slotKeys.map(key => db.collection('slots').doc(key));
      const slotDocs = await Promise.all(slotRefs.map(ref => tx.get(ref)));
      const conflicts = slotDocs
        .map((d, i) => (d.exists ? slotKeys[i] : null))
        .filter((x): x is string => x !== null);
      if (conflicts.length > 0) {
        throw { code: 'slot_conflict', conflicts };
      }
      const resRef = db.collection('reservations').doc();
      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.set(resRef, { status: 'confirmed', slots: slotKeys, createdAt: now });
      slotKeys.forEach((key, i) => {
        const [roomId, date, hourStr] = key.split('|');
        tx.set(slotRefs[i], {
          slotKey: key, roomId, date,
          hour: parseInt(hourStr, 10),
          reservationId: resRef.id,
          createdAt: now,
        });
      });
      return resRef.id;
    });
    return { ok: true, reservationId: result };
  } catch (e: any) {
    if (e?.code === 'slot_conflict') return { ok: false, conflicts: e.conflicts };
    throw e;
  }
}

describe('slot conflict detection integration (emulator)', () => {
  beforeEach(async () => {
    await fetch(
      'http://127.0.0.1:8080/emulator/v1/projects/futami-yoyaku-492607/databases/(default)/documents',
      { method: 'DELETE' }
    ).catch(() => { /* noop */ });
  });

  it('競合なしの予約は正常に成立し、slots / reservations 両方が書き込まれる', async () => {
    const slots = ['room_27|2026-06-01|10', 'room_27|2026-06-01|11'];
    const result = await reserveSlotsWithConflictCheck(slots);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const slotsSnap = await db.collection('slots').get();
    expect(slotsSnap.size).toBe(2);
    const resSnap = await db.collection('reservations').doc(result.reservationId).get();
    expect(resSnap.exists).toBe(true);
    expect((resSnap.data() as any)?.status).toBe('confirmed');
  }, 15000);

  it('既に予約された slot に2件目をかぶせると slot_conflict で拒否', async () => {
    const slots = ['room_27|2026-06-02|10'];
    const first = await reserveSlotsWithConflictCheck(slots);
    expect(first.ok).toBe(true);

    const second = await reserveSlotsWithConflictCheck(slots);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflicts).toContain('room_27|2026-06-02|10');

    // 2回目で reservations が増えていない（トランザクションが atomic）
    const resSnap = await db.collection('reservations').get();
    expect(resSnap.size).toBe(1);
  }, 15000);

  it('複数 slot のうち1つでも競合すれば全体を拒否（atomicity）', async () => {
    await reserveSlotsWithConflictCheck(['room_27|2026-06-03|10']);
    const second = await reserveSlotsWithConflictCheck([
      'room_27|2026-06-03|10',  // 競合
      'room_27|2026-06-03|11',  // 競合なし
      'room_27|2026-06-03|12',  // 競合なし
    ]);
    expect(second.ok).toBe(false);
    // 残り 2 つは書き込まれていない（atomicity）
    const slotsSnap = await db.collection('slots').get();
    expect(slotsSnap.size).toBe(1); // 最初の予約の 1 件のみ
  }, 15000);

  it('別日付・別時間帯なら競合せず両方成立', async () => {
    const r1 = await reserveSlotsWithConflictCheck(['room_27|2026-06-04|10']);
    const r2 = await reserveSlotsWithConflictCheck(['room_27|2026-06-04|11']);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const slotsSnap = await db.collection('slots').get();
    expect(slotsSnap.size).toBe(2);
  }, 15000);
});

afterAll(async () => {
  await admin.app().delete();
});
