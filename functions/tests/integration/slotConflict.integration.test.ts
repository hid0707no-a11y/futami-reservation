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

  // 2026-05-13 追加：要望#7+#9 の複数 roomIds 選択（allowMultiSelect）の slot 競合保護
  // 旧 integration test は全て roomId=room_27 単一だったため、複数選択 UI で
  // 「一部だけ満室」のケースが未保護だった。Evaluator 不足1への対応。
  it('複数 roomIds の一部が既予約 → 全 roomIds の予約が拒否される（atomic）', async () => {
    // 先に room_6_1 を取る
    const first = await reserveSlotsWithConflictCheck(['room_6_1|2026-06-05|18']);
    expect(first.ok).toBe(true);

    // 6畳複数選択で room_6_1 と room_6_2 を同時申請（room_6_1 だけ既に埋まっている）
    const second = await reserveSlotsWithConflictCheck([
      'room_6_1|2026-06-05|18', // 競合
      'room_6_2|2026-06-05|18', // 空き
    ]);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflicts).toContain('room_6_1|2026-06-05|18');

    // 空いていた room_6_2 にも書き込まれていない（atomicity）
    const slotsSnap = await db.collection('slots').get();
    expect(slotsSnap.size).toBe(1); // 最初の room_6_1 のみ
    const room62 = await db.collection('slots').doc('room_6_2|2026-06-05|18').get();
    expect(room62.exists).toBe(false);
  }, 15000);

  it('複数 roomIds 全てが空きなら全件成立して slots に複数 docs が書かれる', async () => {
    // 6畳3部屋・1泊2時間枠の同時予約（複数選択 UI から発火する典型ペイロード）
    const result = await reserveSlotsWithConflictCheck([
      'room_6_1|2026-06-06|18',
      'room_6_1|2026-06-06|19',
      'room_6_2|2026-06-06|18',
      'room_6_2|2026-06-06|19',
      'room_6_3|2026-06-06|18',
      'room_6_3|2026-06-06|19',
    ]);
    expect(result.ok).toBe(true);
    const slotsSnap = await db.collection('slots').get();
    expect(slotsSnap.size).toBe(6);
    // 全 slots が同一 reservationId を持つ（複数選択は1予約）
    const reservationIds = new Set<string>();
    slotsSnap.forEach(d => reservationIds.add((d.data() as any).reservationId));
    expect(reservationIds.size).toBe(1);
  }, 15000);
});

afterAll(async () => {
  await admin.app().delete();
});
