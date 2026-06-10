// 予約ハンドラ（updateReservation / cancelReservation）の integration test（emulator）
//
// 2026-06-11 新設（code-review backlog #4/#5/#9/#8、部分的に #36）。
// onRequest ハンドラ本体を **実コードのまま** 呼び出し（auth/cors/rateLimit/mail のみモック）、
// Firestore Emulator に対してトランザクション・status遷移ガード・slot所有権・audit_log を検証する。

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';

// --- 認可・CORS・レート制限・メールはモック（DB ロジックのみ検証） ---
jest.mock('../../src/lib/auth', () => ({
  requireStaffAuth: jest.fn(async (req: any) => { req.auth = { email: 'staff@test' }; return true; }),
}));
jest.mock('../../src/lib/cors', () => ({
  setCors: jest.fn(() => false),
  checkOrigin: jest.fn(() => true),
}));
jest.mock('../../src/lib/rateLimit', () => ({
  checkRateLimit: jest.fn(() => true),
}));
jest.mock('../../src/lib/mail', () => ({
  sendCancellationEmail: jest.fn(async () => {}),
  sendStaffNotification: jest.fn(async () => {}),
  sendConfirmationEmail: jest.fn(async () => {}),
  sendMonitorAlert: jest.fn(async () => {}),
  STAFF_EMAIL: 'staff@test',
  MONITOR_NOTIFY_EMAILS: ['staff@test'],
  transporter: null,
}));

import * as admin from 'firebase-admin';
import { updateReservation, cancelReservation } from '../../src/handlers/reservation';
import { createReservation } from '../../src/handlers/createReservation';

const db = admin.firestore();

/** onRequest ハンドラを実行し、res に書かれた結果を待つ。 */
function invoke(handler: any, req: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      headersSent: false,
      // v2 onRequest ラッパが触る EventEmitter 系・ヘッダ系を no-op で満たす
      on: () => res, once: () => res, emit: () => false, removeListener: () => res, removeAllListeners: () => res,
      set: () => res, setHeader: () => res, getHeader: () => undefined, removeHeader: () => res,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ statusCode: this.statusCode, body: b }); return this; },
      send(b: any) { resolve({ statusCode: this.statusCode, body: b }); return this; },
      end() { resolve({ statusCode: this.statusCode, body: undefined }); return this; },
    };
    if (!req.get) req.get = (h: string) => req.headers?.[String(h).toLowerCase()];
    if (!req.header) req.header = req.get;
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function clearDb() {
  await fetch(
    'http://127.0.0.1:8080/emulator/v1/projects/futami-yoyaku-492607/databases/(default)/documents',
    { method: 'DELETE' }
  ).catch(() => { /* noop */ });
}

beforeEach(clearDb);
afterAll(async () => { await admin.app().delete(); });

describe('updateReservation（#2/#5/#9）', () => {
  it('存在しない予約は 404', async () => {
    const r = await invoke(updateReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'nope', note: 'x' } });
    expect(r.statusCode).toBe(404);
  });

  it('更新フィールドが無いと 400 no_updatable_fields', async () => {
    await db.collection('reservations').doc('r1').set({ status: 'confirmed' });
    const r = await invoke(updateReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'r1' } });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('no_updatable_fields');
  });

  it('status=cancelled での更新は 400 use_cancel_endpoint（slot 不整合を防ぐ）', async () => {
    await db.collection('reservations').doc('r2').set({ status: 'confirmed' });
    const r = await invoke(updateReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'r2', status: 'cancelled' } });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('use_cancel_endpoint');
    // status は書き換わっていない
    const after = await db.collection('reservations').doc('r2').get();
    expect((after.data() as any).status).toBe('confirmed');
  });

  it('cancelled 予約の復活（→confirmed）は 400 revival_not_supported', async () => {
    await db.collection('reservations').doc('r3').set({ status: 'cancelled' });
    const r = await invoke(updateReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'r3', status: 'confirmed' } });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('revival_not_supported');
  });

  it('正常更新：note/customer をマージ保存し audit_log を tx 内で残す', async () => {
    await db.collection('reservations').doc('r4').set({
      status: 'confirmed', note: 'old', customer: { name: '旧名', phone: '090-0000' },
    });
    const r = await invoke(updateReservation, {
      method: 'POST', query: {}, headers: {},
      body: { id: 'r4', note: '新メモ', customer: { name: '新名' } },
    });
    expect(r.statusCode).toBe(200);
    const after = (await db.collection('reservations').doc('r4').get()).data() as any;
    expect(after.note).toBe('新メモ');
    // customer はマージ（phone が消えない＝#2 データ消失防止）
    expect(after.customer).toEqual({ name: '新名', phone: '090-0000' });
    // audit_log サブコレクションに記録（#9 ★3 準拠）
    const logs = await db.collection('reservations').doc('r4').collection('audit_log').get();
    expect(logs.size).toBe(1);
    expect((logs.docs[0].data() as any).before.customer.name).toBe('旧名');
  });
});

describe('cancelReservation（#4）', () => {
  it('confirmed 予約をキャンセル：status=cancelled・自分の slot を削除', async () => {
    await db.collection('reservations').doc('c1').set({
      status: 'confirmed', slots: ['room_27|2026-07-01|10'], customer: { name: 'A' },
    });
    await db.collection('slots').doc('room_27|2026-07-01|10').set({ reservationId: 'c1' });
    const r = await invoke(cancelReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'c1' } });
    expect(r.statusCode).toBe(200);
    expect(r.body.status).toBe('cancelled');
    const slot = await db.collection('slots').doc('room_27|2026-07-01|10').get();
    expect(slot.exists).toBe(false);
  });

  it('所有権チェック：他予約が再取得した slot は削除しない（#4 二重予約事故防止）', async () => {
    await db.collection('reservations').doc('cA').set({
      status: 'confirmed', slots: ['room_27|2026-07-02|10'], customer: { name: 'A' },
    });
    // slot は既に B が取得し直した状態（reservationId=cB）
    await db.collection('slots').doc('room_27|2026-07-02|10').set({ reservationId: 'cB' });
    const r = await invoke(cancelReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'cA' } });
    expect(r.statusCode).toBe(200);
    // B の slot は消されていない
    const slot = await db.collection('slots').doc('room_27|2026-07-02|10').get();
    expect(slot.exists).toBe(true);
    expect((slot.data() as any).reservationId).toBe('cB');
  });

  it('再キャンセルは冪等（alreadyCancelled=true・slot を触らない）', async () => {
    await db.collection('reservations').doc('c2').set({
      status: 'cancelled', slots: ['room_27|2026-07-03|10'], customer: { name: 'A' },
    });
    // 既に他予約が使っている slot
    await db.collection('slots').doc('room_27|2026-07-03|10').set({ reservationId: 'other' });
    const r = await invoke(cancelReservation, { method: 'POST', query: {}, headers: {}, body: { id: 'c2' } });
    expect(r.statusCode).toBe(200);
    expect(r.body.alreadyCancelled).toBe(true);
    const slot = await db.collection('slots').doc('room_27|2026-07-03|10').get();
    expect(slot.exists).toBe(true); // 触っていない
  });
});

// #36 createReservation の実コードを emulator で叩く（テスト内コピーでなく本物のトランザクションを検証）
describe('createReservation 実コード（#36 real-path / #3 突合）', () => {
  const base = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'normal_27', roomIds: ['room_27'],
      slots: ['room_27|2026-07-10|10'],
      startDate: '2026-07-10', endDate: '2026-07-10',
      customer: { name: '山田', phone: '090-0000-0000' },
      ...over,
    },
  });

  it('競合なしの通常予約が成立し slots/reservations に書かれる', async () => {
    const r = await invoke(createReservation, base());
    expect(r.statusCode).toBe(201);
    expect(r.body.status).toBe('confirmed');
    const slot = await db.collection('slots').doc('room_27|2026-07-10|10').get();
    expect(slot.exists).toBe(true);
  });

  it('同一 slot の2件目は 409 slot_conflict（実トランザクション）', async () => {
    const first = await invoke(createReservation, base());
    expect(first.statusCode).toBe(201);
    const second = await invoke(createReservation, base());
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('slot_conflict');
    // 2件目で reservations が増えていない（atomic）
    const snap = await db.collection('reservations').get();
    expect(snap.size).toBe(1);
  });

  it('#3 court_* と他カテゴリ混在ペイロードは 400 invalid_roomIds', async () => {
    const r = await invoke(createReservation, base({
      roomIds: ['court_1', 'camp_1'],
      slots: ['court_1|2026-07-10|10:00', 'camp_1|2026-07-10|14'],
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_roomIds');
  });

  it('#3 slot の roomId が roomIds 外なら 400 slot_room_mismatch', async () => {
    const r = await invoke(createReservation, base({ roomIds: ['room_27'], slots: ['court_1|2026-07-10|10'] }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('slot_room_mismatch');
  });
});
