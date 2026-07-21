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
import { updateReservation, cancelReservation } from '../../src/handlers/reservation';
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
    }));
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('slot_conflict');
  });

  it('旧テニスdocの08:00形式ともcanonical HHMMが競合する', async () => {
    await db.collection('tennis_slots').doc('court_1|' + OPEN_WEDNESDAY + '|08:00').set({
      roomId: 'court_1', date: OPEN_WEDNESDAY, reservationId: 'legacy-tennis',
    });
    const r = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|0800', 'court_1|' + OPEN_WEDNESDAY + '|0830'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('slot_conflict');
  });

  // 2026-07-20: 半面プラン復活。
  // 2026-07-21: 在庫是正。半面の実体は court_wall（壁打ち練習用の半面コート）＝A〜Eの5面とは
  //   別に1つだけ存在する独立施設。よって旧期待値「半面が全面(コートA)を塞ぐ」は誤りだった。
  //   根拠：公式サイト施設案内／公式料金表【R8】の「半面（練習用）」別行／
  //         運営 上村さん 2026-07-21 回答（①半面コートは一面しかない ②1組まででOK）。
  it('tennis_half は court_wall で 201 成立し tennis_slots に書かれる', async () => {
    const r = await invoke(createReservation, base({
      planId: 'tennis_half', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1000', 'court_wall|' + OPEN_WEDNESDAY + '|1030'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(r.body.internalId).get()).data() as any;
    expect(stored.planId).toBe('tennis_half');
    expect((await db.collection('tennis_slots').doc('court_wall|' + OPEN_WEDNESDAY + '|1000').get()).exists)
      .toBe(true);
    // 半面を入れてもコートAの在庫は消費されない（別施設なので当然だが回帰の要）。
    expect((await db.collection('tennis_slots').doc('court_1|' + OPEN_WEDNESDAY + '|1000').get()).exists)
      .toBe(false);
  });

  it('半面(court_wall)と全面(court_1)は同一時間帯に併存できる', async () => {
    const half = await invoke(createReservation, base({
      planId: 'tennis_half', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1100', 'court_wall|' + OPEN_WEDNESDAY + '|1130'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(half.statusCode).toBe(201);

    // 同じ時間帯にコートAの一面貸切を入れても衝突しない（旧実装では 409 だった＝実害）。
    const full = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|1100', 'court_1|' + OPEN_WEDNESDAY + '|1130'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(full.statusCode).toBe(201);

    // 逆順も同様：先に全面が入っていても半面は取れる。
    const full2 = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_2'],
      slots: ['court_2|' + OPEN_WEDNESDAY + '|1200', 'court_2|' + OPEN_WEDNESDAY + '|1230'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(full2.statusCode).toBe(201);
    const half2 = await invoke(createReservation, base({
      planId: 'tennis_half', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1200', 'court_wall|' + OPEN_WEDNESDAY + '|1230'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(half2.statusCode).toBe(201);
  });

  it('同一時間帯の半面2件目は409（半面コートは1つ＝1組まで）', async () => {
    const first = await invoke(createReservation, base({
      planId: 'tennis_half', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1300', 'court_wall|' + OPEN_WEDNESDAY + '|1330'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(first.statusCode).toBe(201);

    const second = await invoke(createReservation, base({
      planId: 'tennis_half', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1300', 'court_wall|' + OPEN_WEDNESDAY + '|1330'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toBe('slot_conflict');
  });

  it('tennis_half に court_1〜court_5 を直送すると 400 で拒否される（許可roomの反転）', async () => {
    for (const room of ['court_1', 'court_2', 'court_3', 'court_4', 'court_5']) {
      const r = await invoke(createReservation, base({
        planId: 'tennis_half', roomIds: [room],
        slots: [room + '|' + OPEN_WEDNESDAY + '|1400', room + '|' + OPEN_WEDNESDAY + '|1430'],
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      }));
      expect(r.statusCode).toBe(400);
      expect(r.body.error).toBe('plan_room_mismatch');
    }
  });

  it('tennis_full に court_wall を直送すると 400 で拒否される', async () => {
    const r = await invoke(createReservation, base({
      planId: 'tennis_full', roomIds: ['court_wall'],
      slots: ['court_wall|' + OPEN_WEDNESDAY + '|1500', 'court_wall|' + OPEN_WEDNESDAY + '|1530'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('plan_room_mismatch');
  });

  it('旧staff tennis入力をtennis_full/HHMMへcanonical保存する', async () => {
    const r = await invoke(createReservation, base({
      planId: 'tennis', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|8'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(201);
    const stored = (await db.collection('reservations').doc(r.body.internalId).get()).data() as any;
    expect(stored.planId).toBe('tennis_full');
    expect(stored.slots).toEqual([
      'court_1|' + OPEN_WEDNESDAY + '|0800',
      'court_1|' + OPEN_WEDNESDAY + '|0830',
    ]);
    expect((await db.collection('tennis_slots').doc('court_1|' + OPEN_WEDNESDAY + '|0800').get()).exists)
      .toBe(true);
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
    });
    const r = await invoke(businessCalendar, { method: 'GET', query: {}, headers: {}, body: {} });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      defaultClosedDays: [2],
      forceOpen: [OPEN_WEDNESDAY],
      forceClosed: [OPEN_THURSDAY],
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
