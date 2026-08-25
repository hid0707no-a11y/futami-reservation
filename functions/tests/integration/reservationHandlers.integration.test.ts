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
  isVerifiedStaffRequest: jest.fn(async () => false),
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
import { updateReservation, cancelReservation, changeCampSites } from '../../src/handlers/reservation';
import { availability, businessCalendar, futamiDays } from '../../src/handlers/availability';
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
const STAY_HOURS = [16,17,18,19,20,21,22,23,0,1,2,3,4,5,6,7,8,9];
const CAMP_HOURS = [14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5,6,7,8,9,10,11,12];

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextWeekday(dayOfWeek: number): string {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const d = new Date(today + 'T00:00:00Z');
  let delta = (dayOfWeek - d.getUTCDay() + 7) % 7;
  if (delta < 7) delta += 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const CLOSED_TUESDAY = nextWeekday(2);
const OPEN_MONDAY = addDays(CLOSED_TUESDAY, -1);
const OPEN_WEDNESDAY = addDays(CLOSED_TUESDAY, 1);
const OPEN_THURSDAY = addDays(CLOSED_TUESDAY, 2);

function fixedSlots(roomId: string, date: string, hours: number[]): string[] {
  return hours.map(hour => roomId + '|' + date + '|' + hour);
}

function overnightSlots(roomIds: string[], start: string, nights: number, hours: number[]): string[] {
  const checkinHour = hours[0];
  return roomIds.flatMap(roomId =>
    Array.from({ length: nights }, (_, night) =>
      hours.map(hour => roomId + '|' + addDays(start, night + (hour < checkinHour ? 1 : 0)) + '|' + hour),
    ).flat(),
  );
}

describe('createReservation 実コード（#36 real-path / #3 突合）', () => {
  const base = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'day_27_am', roomIds: ['room_27'],
      slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8,9,10,11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: { name: '山田', phone: '090-0000-0000' },
      ...over,
    },
  });

  it('競合なしの通常予約が成立し slots/reservations に書かれる', async () => {
    const r = await invoke(createReservation, base());
    expect(r.statusCode).toBe(201);
    expect(r.body.status).toBe('confirmed');
    const slot = await db.collection('slots').doc('room_27|' + OPEN_WEDNESDAY + '|8').get();
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
      slots: ['court_1|' + OPEN_WEDNESDAY + '|1000', 'camp_1|' + OPEN_WEDNESDAY + '|14'],
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_roomIds');
  });

  it('#3 slot の roomId が roomIds 外なら 400 slot_room_mismatch', async () => {
    const r = await invoke(createReservation, base({
      roomIds: ['room_27'], slots: ['court_1|' + OPEN_WEDNESDAY + '|10'],
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('slot_room_mismatch');
  });
});

// 2026-07-19 セキュリティバッチ：定休日ガード・キャンプ泊数バイパス・サウナ roomIds 強制
describe('createReservation セキュリティバッチ（2026-07-19・real-path）', () => {
  const base = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'day_27_am', roomIds: ['room_27'],
      slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8,9,10,11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: { name: '山田', phone: '090-0000-0000' },
      ...over,
    },
  });

  // サウナは公開経路ではメール必須（2026-08-16 運営要望③）。ここで省くと 400
  // email_required_for_sauna が先に返り、ふたみの日ガードや slot 競合の検証に到達しない。
  const SAUNA_CUSTOMER = { name: '山田', phone: '090-0000-0000', email: 'sauna@test.example' };

  it('定休日（火曜）は 400 closed_day で拒否（config 未設定＝既定 defaultClosedDays=[2]）', async () => {
    const r = await invoke(createReservation, base({
      slots: fixedSlots('room_27', CLOSED_TUESDAY, [8,9,10,11]),
      startDate: CLOSED_TUESDAY, endDate: CLOSED_TUESDAY,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('closed_day');
    expect(r.body.detail).toBe(CLOSED_TUESDAY);
  });

  it('非定休日（水曜）は通常どおり 201 成立', async () => {
    const r = await invoke(createReservation, base());
    expect(r.statusCode).toBe(201);
    expect(r.body.status).toBe('confirmed');
  });

  it('単日予約でendDateをずらす改ざんはcanonical日程不一致で拒否', async () => {
    const r = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + CLOSED_TUESDAY + '|0800', 'court_1|' + CLOSED_TUESDAY + '|0830'],
      startDate: OPEN_MONDAY, endDate: CLOSED_TUESDAY,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('plan_date_mismatch');
  });

  it('宿泊にダミーslotを足して定休日枠を紛れ込ませても完全一致検査で拒否', async () => {
    const r = await invoke(createReservation, base({
      planId: 'stay_27', roomIds: ['room_27'], nights: 1,
      slots: ['room_27|' + OPEN_MONDAY + '|18', 'room_27|' + CLOSED_TUESDAY + '|13'],
      startDate: OPEN_MONDAY, endDate: CLOSED_TUESDAY,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('plan_slot_mismatch');
  });

  it('正当な連泊で endDate（チェックアウト翌朝 slot）が定休日でも 201（本物の連泊は endDate 免除）', async () => {
    const r = await invoke(createReservation, base({
      planId: 'stay_27', roomIds: ['room_27'], nights: 1,
      slots: overnightSlots(['room_27'], OPEN_MONDAY, 1, STAY_HOURS),
      startDate: OPEN_MONDAY, endDate: CLOSED_TUESDAY,
    }));
    expect(r.statusCode).toBe(201);
  });

  it('キャンプ4泊はinvalid_nightsで拒否', async () => {
    const r = await invoke(createReservation, base({
      planId: 'camp_stay', roomIds: ['camp_1'], nights: 4,
      slots: overnightSlots(['camp_1'], OPEN_WEDNESDAY, 4, CAMP_HOURS),
      startDate: OPEN_WEDNESDAY, endDate: addDays(OPEN_WEDNESDAY, 4),
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_nights');
  });

  it('キャンプ 3泊（正当）は 201 成立', async () => {
    const r = await invoke(createReservation, base({
      planId: 'camp_stay', roomIds: ['camp_1'], nights: 3,
      slots: overnightSlots(['camp_1'], OPEN_WEDNESDAY, 3, CAMP_HOURS),
      startDate: OPEN_WEDNESDAY, endDate: addDays(OPEN_WEDNESDAY, 3),
    }));
    expect(r.statusCode).toBe(201);
  });

  it('サウナ planId にcamp roomIdsを混ぜるとplan_room_mismatch', async () => {
    const r = await invoke(createReservation, base({
      planId: 'plan_sauna_futami', roomIds: ['camp_1'],
      slots: ['camp_1|' + OPEN_WEDNESDAY + '|18'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY,
      guestCount: 4,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('plan_room_mismatch');
  });

  it('悪意あるguests文字列は保存前に拒否しreservation/slotを作らない', async () => {
    const r = await invoke(createReservation, base({
      guests: { adult: '<img src=x onerror=alert(1)>', elementary: 0, child: 0 },
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_guest_count');
    expect((await db.collection('reservations').get()).size).toBe(0);
    expect((await db.collection('slots').get()).size).toBe(0);
  });

  it('ロッジ旧画面は更新要求、新v2は選択時間だけ保存', async () => {
    const lodge = {
      planId: 'lodge_day', roomIds: ['lodge_a'],
      slots: fixedSlots('lodge_a', OPEN_WEDNESDAY, [10,12]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    };
    const oldResult = await invoke(createReservation, base(lodge));
    expect(oldResult.statusCode).toBe(400);
    expect(oldResult.body.error).toBe('client_update_required');

    const currentResult = await invoke(createReservation, base({ ...lodge, inventoryVersion: 2 }));
    expect(currentResult.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(currentResult.body.internalId).get()).data() as any;
    expect(stored.slots).toEqual(lodge.slots);
  });

  it('通常サウナはふたみの日に通常inventoryで予約できない', async () => {
    await db.doc('config/special_days').set({ sauna_capacity_days: [OPEN_WEDNESDAY] });
    const r = await invoke(createReservation, base({
      planId: 'sauna_1', roomIds: ['sauna'],
      slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10,11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: SAUNA_CUSTOMER,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('futami_day_requires_shared_sauna');
  });

  it('ふたみの日専用プランは通常日に予約できない', async () => {
    const r = await invoke(createReservation, base({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots('sauna_share', OPEN_THURSDAY, [10,11]),
      startDate: OPEN_THURSDAY, endDate: OPEN_THURSDAY, nights: 0,
      guestCount: 4,
      customer: SAUNA_CUSTOMER,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('not_futami_day');
  });

  it('ふたみの日設定追加前の通常sauna slotがあれば共有saunaは409', async () => {
    await db.doc('config/special_days').set({ sauna_capacity_days: [OPEN_WEDNESDAY] });
    await db.collection('slots').doc('sauna|' + OPEN_WEDNESDAY + '|10').set({
      roomId: 'sauna', date: OPEN_WEDNESDAY, reservationId: 'legacy-regular',
    });
    const r = await invoke(createReservation, base({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots('sauna_share', OPEN_WEDNESDAY, [10,11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      guestCount: 4,
      customer: SAUNA_CUSTOMER,
    }));
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('slot_conflict');
  });

  it('ふたみの日設定解除後も既存共有sauna slotがあれば通常saunaは409', async () => {
    await db.collection('slots').doc('sauna_share|' + OPEN_WEDNESDAY + '|10').set({
      roomId: 'sauna_share', date: OPEN_WEDNESDAY, reservationId: 'legacy-special',
    });
    const r = await invoke(createReservation, base({
      planId: 'sauna_1', roomIds: ['sauna'],
      slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10,11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: SAUNA_CUSTOMER,
    }));
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('slot_conflict');
  });

  // ★2026-08-25 要望⑦で 8:00 開始は受理されなくなったので、旧コロン形式との競合検証は
  //   9:00 起点で行う（旧 08:00 doc 自体は本番に残るが、新規予約がそこへ入る経路は消えた）。
  it('旧テニスdocのコロン形式ともcanonical HHMMが競合する', async () => {
    await db.collection('tennis_slots').doc('court_1|' + OPEN_WEDNESDAY + '|09:00').set({
      roomId: 'court_1', date: OPEN_WEDNESDAY, reservationId: 'legacy-tennis',
    });
    const r = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|0900', 'court_1|' + OPEN_WEDNESDAY + '|0930'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('slot_conflict');
  });

  it('旧staff tennis入力をtennis_full/HHMMへcanonical保存する', async () => {
    const r = await invoke(createReservation, base({
      planId: 'tennis', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|9'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(r.body.internalId).get()).data() as any;
    expect(stored.planId).toBe('tennis_full');
    expect(stored.slots).toEqual([
      'court_1|' + OPEN_WEDNESDAY + '|0900',
      'court_1|' + OPEN_WEDNESDAY + '|0930',
    ]);
    expect((await db.collection('tennis_slots').doc('court_1|' + OPEN_WEDNESDAY + '|0900').get()).exists)
      .toBe(true);
  });

  // 2026-08-25 要望⑦：公開画面・職員画面だけでなく API 直叩きでも 8:00 を受け付けない
  it('テニスの8:00開始は real-path でも 400 になる', async () => {
    const r = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|0800', 'court_1|' + OPEN_WEDNESDAY + '|0830'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('plan_slot_mismatch');
  });

  it('canonical移行前payloadでも成立済みidempotency応答を先に返す', async () => {
    const key = 'legacy_retry_001';
    await db.collection('idempotency_keys').doc(key).set({
      response: { reservationId: 'F-EXISTING', status: 'confirmed' },
    });
    const req: any = base({
      planId: 'normal_27',
      roomIds: ['room_27'],
      slots: ['room_27|' + OPEN_WEDNESDAY + '|10'],
    });
    req.headers['x-idempotency-key'] = key;
    const r = await invoke(createReservation, req);
    expect(r.statusCode).toBe(200);
    expect(r.body.reservationId).toBe('F-EXISTING');
  });
});

describe('availability 旧テニスslot正規化', () => {
  it('整数・ゼロ埋め・colon・canonicalをHHMMへ統合し重複排除する', async () => {
    const ids = [
      'court_1|' + OPEN_WEDNESDAY + '|8',
      'court_1|' + OPEN_WEDNESDAY + '|08',
      'court_1|' + OPEN_WEDNESDAY + '|08:30',
      'court_1|' + OPEN_WEDNESDAY + '|0900',
    ];
    await Promise.all(ids.map(id => db.collection('tennis_slots').doc(id).set({
      roomId: 'court_1', date: OPEN_WEDNESDAY,
    })));
    const r = await invoke(availability, {
      method: 'GET', query: { from: OPEN_WEDNESDAY, to: OPEN_WEDNESDAY }, headers: {},
    });
    expect(r.statusCode).toBe(200);
    expect(new Set(r.body.tennisSlots)).toEqual(new Set([
      'court_1|' + OPEN_WEDNESDAY + '|0800',
      'court_1|' + OPEN_WEDNESDAY + '|0830',
      'court_1|' + OPEN_WEDNESDAY + '|0900',
    ]));
  });
});

describe('営業日・特別日config境界', () => {
  it('businessCalendar GETは手動破損データも安全な形へ正規化する', async () => {
    await db.doc('config/business_calendar').set({
      defaultClosedDays: [2, 1.5],
      forceOpen: ['2026-02-30', OPEN_WEDNESDAY],
      forceClosed: ['broken', OPEN_THURSDAY],
      // 2026-08-02 追加：施設単位の停止。契約外の要素は GET でも落とす
      facilityClosed: ['sauna|2026-02-30', `sauna|${OPEN_WEDNESDAY}`, 'nonexistent|2026-09-20'],
    });
    const r = await invoke(businessCalendar, { method: 'GET', query: {}, headers: {}, body: {} });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      defaultClosedDays: [2],
      forceOpen: [OPEN_WEDNESDAY],
      forceClosed: [OPEN_THURSDAY],
      facilityClosed: [`sauna|${OPEN_WEDNESDAY}`],
    });
  });

  it('businessCalendar POSTは小数曜日と存在しない日付を拒否する', async () => {
    const badDay = await invoke(businessCalendar, {
      method: 'POST', query: {}, headers: {}, body: { defaultClosedDays: [1.5] },
    });
    expect(badDay.statusCode).toBe(400);
    expect(badDay.body.error).toBe('invalid_defaultClosedDays');

    const badDate = await invoke(businessCalendar, {
      method: 'POST', query: {}, headers: {}, body: { forceOpen: ['2026-02-30'] },
    });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.body.error).toBe('invalid_forceOpen');
  });

  it('futamiDays POSTは存在しない日付を書き込まない', async () => {
    const r = await invoke(futamiDays, {
      method: 'POST', query: {}, headers: {}, body: { dates: ['2026-02-30'] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_dates');
    expect((await db.doc('config/special_days').get()).exists).toBe(false);
  });
});


// 2026-07-22 テニス半面（壁打ちコート court_wall）復活の real-path 統合テスト
// 仕様根拠: 2026-07-21 上村さん回答（半面=独立施設・同時間1組まで・1枠240円定額）
describe('tennis_half 復活（court_wall・real-path）', () => {
  const halfBase = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'tennis_half', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1800', 'court_wall|' + OPEN_WEDNESDAY + '|1830'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: { name: '半面 太郎', phone: '090-1111-2222', isMember: true },
      ...over,
    },
  });
  const fullBase = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|1800', 'court_1|' + OPEN_WEDNESDAY + '|1830'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: { name: '全面 花子', phone: '090-3333-4444', isMember: true },
      ...over,
    },
  });

  it('半面予約が201で成立し、court_wall の tennis_slots とサーバ定額240円が保存される', async () => {
    const r = await invoke(createReservation, halfBase());
    expect(r.statusCode).toBe(201);
    expect(r.body.status).toBe('confirmed');
    expect(r.body.isTennis).toBe(true);
    expect((await db.collection('tennis_slots').doc('court_wall|' + OPEN_WEDNESDAY + '|1800').get()).exists).toBe(true);
    expect((await db.collection('tennis_slots').doc('court_wall|' + OPEN_WEDNESDAY + '|1830').get()).exists).toBe(true);
    const snap = await db.collection('reservations').get();
    expect(snap.size).toBe(1);
    const stored = snap.docs[0].data();
    expect(stored.planId).toBe('tennis_half');
    expect(stored.roomIds).toEqual(['court_wall']);
    // 18時枠＝平日割(8:30-17:00)対象外 → 市民1枠定額240円（人数に依存しない）
    expect(stored.pricing.total).toBe(240);
    expect(stored.pricing.tennis.courtType).toBe('half');
  });

  it('半面と全面(コートA)は同時間帯に併存できる（半面はコートAを塞がない）', async () => {
    const half = await invoke(createReservation, halfBase());
    expect(half.statusCode).toBe(201);
    const full = await invoke(createReservation, fullBase());
    expect(full.statusCode).toBe(201);
    const snap = await db.collection('reservations').get();
    expect(snap.size).toBe(2);
  });

  it('同時間の半面2件目は409 slot_conflict（半面コートは1つしかない）', async () => {
    const first = await invoke(createReservation, halfBase());
    expect(first.statusCode).toBe(201);
    const second = await invoke(createReservation, halfBase({
      customer: { name: '半面 次郎', phone: '090-5555-6666', isMember: false },
    }));
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('slot_conflict');
    const snap = await db.collection('reservations').get();
    expect(snap.size).toBe(1);
  });

  it('半面をコートA〜Eへ直送すると400 plan_room_mismatch（誤案内・在庫毀損の防止）', async () => {
    for (const court of ['court_1', 'court_3', 'court_5']) {
      const r = await invoke(createReservation, halfBase({
        roomIds: [court],
        slots: [court + '|' + OPEN_WEDNESDAY + '|1800', court + '|' + OPEN_WEDNESDAY + '|1830'],
      }));
      expect(r.statusCode).toBe(400);
      expect(r.body.error).toBe('plan_room_mismatch');
    }
  });

  it('半面キャンセルで court_wall の tennis_slots が解放され、再予約できる', async () => {
    const created = await invoke(createReservation, halfBase());
    expect(created.statusCode).toBe(201);
    const internalId = created.body.internalId;
    const cancelled = await invoke(cancelReservation, {
      method: 'POST', query: {}, headers: {}, body: { id: internalId },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((await db.collection('tennis_slots').doc('court_wall|' + OPEN_WEDNESDAY + '|1800').get()).exists).toBe(false);
    const again = await invoke(createReservation, halfBase({
      customer: { name: '半面 三郎', phone: '090-7777-8888', isMember: true },
    }));
    expect(again.statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────
// サウナはメールアドレス必須（2026-08-16 運営要望③・real-path）
//
// 運営は当日のご案内をメールで送る運用なので、メール無しのサウナ予約が入ると連絡が付かない。
// 画面側（index.html の requireEmail）でも止めているが、API 直叩きでも通らないことをここで担保する。
//
// ★職員入力（staff.html＝電話受付）は対象外。職員画面にメール欄が無く、電話で受けた
//   お客様はメールを持たないことがある。ここまで必須にすると運営が代理入力できなくなる。
// ─────────────────────────────────────────────
describe('createReservation — サウナのメール必須（2026-08-16 運営要望③）', () => {
  const authMock = jest.requireMock('../../src/lib/auth') as { isVerifiedStaffRequest: jest.Mock };
  const asStaff = () => authMock.isVerifiedStaffRequest.mockImplementation(async () => true);
  const asWeb = () => authMock.isVerifiedStaffRequest.mockImplementation(async () => false);
  // 他 describe は web 前提なので、この describe を出るときに必ず戻す
  afterEach(asWeb);

  const saunaBody = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'sauna_1', roomIds: ['sauna'],
      slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10, 11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: { name: 'サウナ 太郎', phone: '090-1111-2222' },
      ...over,
    },
  });

  it('公開経路：メール無しのサウナは 400 email_required_for_sauna（在庫も予約も作らない）', async () => {
    const r = await invoke(createReservation, saunaBody());
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('email_required_for_sauna');
    expect((await db.collection('slots').get()).size).toBe(0);
    expect((await db.collection('reservations').get()).size).toBe(0);
  });

  it('公開経路：メール有りのサウナは従来どおり 201', async () => {
    const r = await invoke(createReservation, saunaBody({
      customer: { name: 'サウナ 太郎', phone: '090-1111-2222', email: 'sauna@test.example' },
    }));
    expect(r.statusCode).toBe(201);
  });

  it('公開経路：ふたみの日（plan_sauna_futami / sauna_share）もメール無しは 400', async () => {
    await db.doc('config/special_days').set({ sauna_capacity_days: [OPEN_WEDNESDAY] });
    const r = await invoke(createReservation, saunaBody({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots('sauna_share', OPEN_WEDNESDAY, [10, 11]),
      guestCount: 4,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('email_required_for_sauna');
  });

  it('職員入力（電話受付）はメール無しでも 201＝既存の受付導線を壊さない', async () => {
    asStaff();
    const req = saunaBody({ pricing: null, createdBy: 'staff' });
    req.headers = { authorization: 'Bearer staff' };
    const r = await invoke(createReservation, req);
    expect(r.statusCode).toBe(201);
  });

  it('回帰：サウナ以外はメール無しでも従来どおり 201', async () => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'day_27_am', roomIds: ['room_27'],
        slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田', phone: '090-0000-0000' },
      },
    });
    expect(r.statusCode).toBe(201);
  });
});

// =====================================================================
// 2026-08-25 運営要望 ③④⑩ の real-path 検証
// =====================================================================
describe('運営要望 2026-08-25（③キャンプ8区画 / ④職員の期間制限免除 / ⑩フリガナ）', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authMod = require('../../src/lib/auth');
  const asStaff = () => (authMod.isVerifiedStaffRequest as jest.Mock).mockImplementation(async () => true);
  const asWeb = () => (authMod.isVerifiedStaffRequest as jest.Mock).mockImplementation(async () => false);
  afterEach(asWeb);

  const campBody = (sites: string[], nights: number, over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'camp_stay',
      roomIds: sites,
      slots: overnightSlots(sites, OPEN_WEDNESDAY, nights, CAMP_HOURS),
      startDate: OPEN_WEDNESDAY,
      endDate: addDays(OPEN_WEDNESDAY, nights),
      nights,
      customer: { name: '山田', phone: '090-0000-0000' },
      ...over,
    },
  });

  // ③ 旧上限は3区画。運営要望で全8区画まで解放した。
  it('③ キャンプ8区画1泊が成立し、8区画ぶんの slot が書かれる', async () => {
    const sites = ['camp_1','camp_2','camp_3','camp_4','camp_5','camp_6','camp_7','camp_8'];
    const r = await invoke(createReservation, campBody(sites, 1));
    expect(r.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(r.body.internalId).get()).data() as any;
    expect(stored.roomIds).toHaveLength(8);
    // 1区画1泊 = 23 slot
    expect(stored.slots).toHaveLength(8 * 23);
    expect((await db.collection('slots').doc('camp_8|' + OPEN_WEDNESDAY + '|14').get()).exists).toBe(true);
  });

  it('③ 4区画（旧上限の外側）も成立する', async () => {
    const r = await invoke(createReservation, campBody(['camp_1','camp_2','camp_3','camp_4'], 1));
    expect(r.statusCode).toBe(201);
  });

  it('③ 7区画3泊は成立する（483 slot・トランザクション上限の内側）', async () => {
    const sites = ['camp_1','camp_2','camp_3','camp_4','camp_5','camp_6','camp_7'];
    const r = await invoke(createReservation, campBody(sites, 3));
    expect(r.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(r.body.internalId).get()).data() as any;
    expect(stored.slots).toHaveLength(7 * 23 * 3);
  });

  it('③ 8区画3泊(552 slot)は slots 上限で 400 になる（黙って壊れない）', async () => {
    const sites = ['camp_1','camp_2','camp_3','camp_4','camp_5','camp_6','camp_7','camp_8'];
    const r = await invoke(createReservation, campBody(sites, 3));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_slots');
  });

  // ④ 職員だけ受付期間の上限を免除する
  const farFuture = addDays(OPEN_WEDNESDAY, 200); // 90日先の上限を超える
  const tennisFar = () => ({
    method: 'POST', query: {}, headers: { authorization: 'Bearer staff' },
    body: {
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + farFuture + '|0900', 'court_1|' + farFuture + '|0930'],
      startDate: farFuture, endDate: farFuture, nights: 0,
      customer: { name: '山田', phone: '090-0000-0000' },
    },
  });

  it('④ 公開経路は90日より先を booking_too_far で拒否する', async () => {
    const r = await invoke(createReservation, tennisFar());
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('booking_too_far');
  });

  it('④ 職員（検証済みBearer）は90日より先でも予約できる', async () => {
    asStaff();
    const r = await invoke(createReservation, tennisFar());
    expect(r.statusCode).toBe(201);
  });

  it('④ createdBy 申告だけでは免除されない（Bearer の実検証が必要）', async () => {
    const req: any = tennisFar();
    req.body.createdBy = 'staff';
    const r = await invoke(createReservation, req);
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('booking_too_far');
  });

  // ⑩ フリガナ
  it('⑩ customer.kana が Firestore に保存される', async () => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'day_27_am', roomIds: ['room_27'],
        slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田 太郎', kana: 'ヤマダ タロウ', phone: '090-0000-0000' },
      },
    });
    expect(r.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(r.body.internalId).get()).data() as any;
    expect(stored.customer.kana).toBe('ヤマダ タロウ');
  });

  it('⑩ フリガナ未入力でも従来どおり予約できる', async () => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'day_27_am', roomIds: ['room_27'],
        slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田 太郎', phone: '090-0000-0000' },
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it('⑩ 改行入りフリガナは 400（メールヘッダ汚染の封じ込め）', async () => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'day_27_am', roomIds: ['room_27'],
        slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田', kana: 'ヤマダ\nBcc: evil@example.com', phone: '090-0000-0000' },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_customer_kana');
  });

  // ⑧ 職員の予約修正（updateReservation は既存だが画面から初めて叩く経路になる）
  it('⑧ 備考・フリガナ・入金ステータスを更新でき audit_log が残る', async () => {
    const created = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'day_27_am', roomIds: ['room_27'],
        slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田', phone: '090-0000-0000' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.body.internalId;

    const r = await invoke(updateReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        id,
        note: '当日は15時到着',
        customer: { kana: 'ヤマダ', evil: 'x' },
        payment: { status: 'paid', amount: 99999 },
      },
    });
    expect(r.statusCode).toBe(200);

    const stored = (await db.collection('reservations').doc(id).get()).data() as any;
    expect(stored.note).toBe('当日は15時到着');
    expect(stored.customer.kana).toBe('ヤマダ');
    expect(stored.customer.name).toBe('山田');      // 部分送信でも既存値が残る
    expect(stored.customer.evil).toBeUndefined();   // 検証していないキーは通さない
    expect(stored.payment.status).toBe('paid');
    expect(stored.payment.amount).toBeUndefined();

    const logs = await db.collection('reservations').doc(id).collection('audit_log').get();
    expect(logs.docs.some(d => d.data().action === 'update')).toBe(true);
  });
});

// =====================================================================
// changeCampSites の書込み件数ガード（2026-08-25 要望③のレビュー指摘）
// =====================================================================
describe('changeCampSites：区画の総入れ替えでトランザクション上限を超えない', () => {
  const CAMP_H = [14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5,6,7,8,9,10,11,12];

  const createCamp = async (sites: string[], nights: number) => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'camp_stay', roomIds: sites,
        slots: overnightSlots(sites, OPEN_WEDNESDAY, nights, CAMP_H),
        startDate: OPEN_WEDNESDAY, endDate: addDays(OPEN_WEDNESDAY, nights), nights,
        customer: { name: '山田', phone: '090-0000-0000' },
      },
    });
    expect(r.statusCode).toBe(201);
    return r.body.internalId as string;
  };

  // ★これがレビューで見つかった穴。新規slotだけを数えるガードでは 276 ≦ 499 で通ってしまい、
  //   実際には 276削除 + 276新規 + 2 = 554 writes で Firestore が commit ごと失敗し、
  //   職員には原因の分からない internal_error が出ていた。
  it('3泊4区画 → 排他の別4区画は、理由の分かる 400 で止まる（500にしない）', async () => {
    const id = await createCamp(['camp_1','camp_2','camp_3','camp_4'], 3);
    const r = await invoke(changeCampSites, {
      method: 'POST', query: {}, headers: {},
      body: { id, newCampSites: ['camp_5','camp_6','camp_7','camp_8'] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('camp_sites_too_many_slots');

    // 元の予約は1件も壊れていない
    const stored = (await db.collection('reservations').doc(id).get()).data() as any;
    expect(stored.roomIds).toEqual(['camp_1','camp_2','camp_3','camp_4']);
    expect(stored.slots).toHaveLength(4 * 23 * 3);
  });

  it('3泊4区画 → 2区画だけ付け替え（重なりあり）は通る', async () => {
    const id = await createCamp(['camp_1','camp_2','camp_3','camp_4'], 3);
    const r = await invoke(changeCampSites, {
      method: 'POST', query: {}, headers: {},
      body: { id, newCampSites: ['camp_1','camp_2','camp_5','camp_6'] },
    });
    expect(r.statusCode).toBe(200);
    const stored = (await db.collection('reservations').doc(id).get()).data() as any;
    expect(stored.roomIds.slice().sort()).toEqual(['camp_1','camp_2','camp_5','camp_6']);
  });

  it('1泊なら8区画の総入れ替えでも通る（368+2 writes）', async () => {
    const id = await createCamp(['camp_1','camp_2','camp_3','camp_4'], 1);
    const r = await invoke(changeCampSites, {
      method: 'POST', query: {}, headers: {},
      body: { id, newCampSites: ['camp_5','camp_6','camp_7','camp_8'] },
    });
    expect(r.statusCode).toBe(200);
  });

  it('9区画以上は入口で 400（区画IDのホワイトリスト前に件数で弾く）', async () => {
    const id = await createCamp(['camp_1'], 1);
    const r = await invoke(changeCampSites, {
      method: 'POST', query: {}, headers: {},
      body: { id, newCampSites: ['camp_1','camp_2','camp_3','camp_4','camp_5','camp_6','camp_7','camp_8','camp_9'] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_camp_sites_count');
  });
});
