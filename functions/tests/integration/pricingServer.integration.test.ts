// #17 サーバ権威料金の integration test（emulator）。
//
// createReservation を実コードのまま叩き、Firestore に保存された reservation の pricing が
// クライアント申告でなく **サーバ計算値** であること、改ざん total に対して pricingMismatch が
// 併記されること、pricing 省略でもサーバ計算値が保存されることを検証する。
//
// ポートは FIRESTORE_EMULATOR_HOST 環境変数に追従（clearDb も同ホスト）＝8080/8081 どちらでも動く。

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';

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
import { createReservation } from '../../src/handlers/createReservation';

const db = admin.firestore();
const EMU_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

function invoke(handler: any, req: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200, headersSent: false,
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
    `http://${EMU_HOST}/emulator/v1/projects/futami-yoyaku-492607/databases/(default)/documents`,
    { method: 'DELETE' },
  ).catch(() => { /* noop */ });
}

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

const CAMP_HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const OPEN_WEDNESDAY = addDays(nextWeekday(2), 1); // 火(既定定休)+1 = 水

beforeEach(clearDb);
afterAll(async () => { await admin.app().delete(); });

async function storedPricing(internalId: string): Promise<any> {
  const doc = await db.collection('reservations').doc(internalId).get();
  return doc.data();
}

describe('#17 サーバ権威料金（createReservation 実コード・emulator）', () => {
  const dayAm = (over: any = {}) => ({
    method: 'POST', query: {}, headers: {},
    body: {
      planId: 'day_27_am', roomIds: ['room_27'],
      slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      customer: { name: '山田', phone: '090-0000-0000' },
      ...over,
    },
  });

  it('total:1 改ざん → 保存 total はサーバ計算値(1790)＋pricingMismatch 記録', async () => {
    const r = await invoke(createReservation, dayAm({ pricing: { total: 1 } }));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.pricing.total).toBe(1790);
    expect(data.pricingMismatch).toEqual({ claimedTotal: 1, computedTotal: 1790 });
  });

  it('pricing 省略（staff相当） → サーバ計算値(1790)保存・pricingMismatch なし', async () => {
    const r = await invoke(createReservation, dayAm({ pricing: null }));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.pricing.total).toBe(1790);
    expect(data.pricingMismatch).toBeUndefined();
  });

  it('正しい total → 一致保存・pricingMismatch なし', async () => {
    const r = await invoke(createReservation, dayAm({ pricing: { total: 1790, sportGuestEstimate: null } }));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.pricing.total).toBe(1790);
    expect(data.pricingMismatch).toBeUndefined();
  });

  it('キャンプ改ざん total → 区画×泊のサーバ計算値へ上書き（2区画1泊=1580）', async () => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'camp_stay', roomIds: ['camp_1', 'camp_2'], nights: 1,
        slots: overnightSlots(['camp_1', 'camp_2'], OPEN_WEDNESDAY, 1, CAMP_HOURS),
        startDate: OPEN_WEDNESDAY, endDate: addDays(OPEN_WEDNESDAY, 1),
        customer: { name: '山田', phone: '090-0000-0000' },
        pricing: { total: 1 },
      },
    });
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.pricing.total).toBe(790 * 2 * 1);
    expect(data.pricingMismatch).toEqual({ claimedTotal: 1, computedTotal: 1580 });
  });

  it('サウナ：改ざん total でもオプション込みサーバ計算値を保存し saunaOptions が残る', async () => {
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'sauna_1', roomIds: ['sauna'],
        slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田', phone: '090-0000-0000' },
        pricing: { total: 5, saunaOptions: { towels: 2, tarpTent: 1, ice20kg: 0 } },
      },
    });
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.pricing.total).toBe(13200 + 550 * 2 + 1100); // 15400
    expect(data.pricing.saunaOptions).toEqual({ towels: 2, tarpTent: 1, ice20kg: 0 });
    expect(data.pricingMismatch.computedTotal).toBe(15400);
  });

  it('テニス：クライアントが weekdayDiscountHours を詐称してもサーバが日付判定で保存値を決める', async () => {
    // 一面・1時間（09:00枠）。平日割はサーバが OPEN_WEDNESDAY の曜日/祝日から自律判定。
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'tennis_full', roomIds: ['court_1'],
        slots: ['court_1|' + OPEN_WEDNESDAY + '|0900', 'court_1|' + OPEN_WEDNESDAY + '|0930'],
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '山田', phone: '090-0000-0000', isMember: true },
        pricing: { total: 1, tennis: { useLighting: false, weekdayDiscountHours: 99 } },
      },
    });
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    // サーバは 630(通常) か 320(平日割) のいずれか（OPEN_WEDNESDAY が祝日でなければ 320）。
    expect([320, 630]).toContain(data.pricing.total);
    // weekdayDiscountHours はクライアント詐称(99)でなくサーバ判定(0 or 1)
    expect([0, 1]).toContain(data.pricing.tennis.weekdayDiscountHours);
    expect(data.pricing.tennis.weekdayDiscountHours).not.toBe(99);
    expect(data.pricingMismatch.claimedTotal).toBe(1);
  });
});

// ─────────────────────────────────────────────
// 職員手動予約（createdBy=staff）はサーバ料金を計算・保存しない
//
// staff.html には市民/市外の入力UIが無く customer.isMember を false 固定で送るため、
// サーバが権威計算すると伊予市民のお客様の予約でも必ず市外料金が保存され、日次同期で
// スプレッドシートの「合計金額」列に載る。0円（＝明らかに未記入）なら人が気づけるが、
// 尤もらしい誤った金額は検知されないまま行政報告用の台帳に残る＝より悪い。
//
// ★このブロックの本命は「serverPricing を null にしたことで新たな 500 を作っていない」こと。
//   handler はメール本文組立で serverPricing.saunaOptions をプロパティ直参照しており、
//   null 安全化（?.）を怠るとテニス以外の職員予約が全経路 500 になる（現行より重い障害）。
// ─────────────────────────────────────────────
describe('#17-2 職員手動予約はサーバ料金を計算しない（市外料金の尤もらしい誤りを止める）', () => {
  const authMock = jest.requireMock('../../src/lib/auth') as { isVerifiedStaffRequest: jest.Mock };
  const mailMock = jest.requireMock('../../src/lib/mail') as {
    sendConfirmationEmail: jest.Mock;
    sendStaffNotification: jest.Mock;
  };
  const asStaff = () => authMock.isVerifiedStaffRequest.mockImplementation(async () => true);
  const asWeb = () => authMock.isVerifiedStaffRequest.mockImplementation(async () => false);

  beforeEach(() => {
    mailMock.sendConfirmationEmail.mockClear();
    mailMock.sendStaffNotification.mockClear();
    asStaff();
  });
  // web 前提の既存 describe へ staff=true を漏らさない
  afterEach(asWeb);

  // staff.html が実際に送る形：pricing は null・isMember は入力UIが無いため false 固定。
  const staffBody = (over: any = {}) => ({
    method: 'POST', query: {}, headers: { authorization: 'Bearer staff' },
    body: {
      customer: { name: '山田', phone: '090-0000-0000', isMember: false },
      pricing: null, createdBy: 'staff',
      ...over,
    },
  });
  const dayAmFields = {
    planId: 'day_27_am', roomIds: ['room_27'],
    slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
    startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
  };

  it('一般プラン：pricing は null 保存・pricingMismatch も付かない', async () => {
    const r = await invoke(createReservation, staffBody(dayAmFields));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.createdBy).toBe('staff');
    expect(data.pricing).toBeNull();
    expect(data.pricingMismatch).toBeUndefined();
  });

  it('★通常サウナ：serverPricing=null でもメール組立が落ちず 201（500 回帰テスト）', async () => {
    const r = await invoke(createReservation, staffBody({
      planId: 'sauna_1', roomIds: ['sauna'],
      slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10, 11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(201);
    expect((await storedPricing(r.body.internalId)).pricing).toBeNull();
    // メール経路まで実際に到達したことを固定（TypeError なら 500 で呼ばれない）
    expect(mailMock.sendConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mailMock.sendConfirmationEmail.mock.calls[0][0].saunaOptionsText).toBeUndefined();
  });

  it('★ふたみの日サウナ：serverPricing=null でもメール組立が落ちず 201（500 回帰テスト）', async () => {
    await db.doc('config/special_days').set({ sauna_capacity_days: [OPEN_WEDNESDAY] });
    const r = await invoke(createReservation, staffBody({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots('sauna_share', OPEN_WEDNESDAY, [10, 11]),
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
      guestCount: 4,
    }));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.isFutamiDay).toBe(true);
    expect(data.pricing).toBeNull();
    expect(mailMock.sendConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mailMock.sendConfirmationEmail.mock.calls[0][0].saunaOptionsText).toBeUndefined();
  });

  it('テニス：市民/市外が分からない職員経路では市外料金を埋めない（報告された実害）', async () => {
    const r = await invoke(createReservation, staffBody({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|' + OPEN_WEDNESDAY + '|0900', 'court_1|' + OPEN_WEDNESDAY + '|0930'],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
    }));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    expect(data.isTennis).toBe(true);
    expect(data.pricing).toBeNull();
    expect(data.pricingMismatch).toBeUndefined();
  });

  it('職員経路なら customer.isMember=true を送っても計算しない（区分の値でなく経路で決まる）', async () => {
    const r = await invoke(createReservation, staffBody({
      ...dayAmFields,
      customer: { name: '山田', phone: '090-0000-0000', isMember: true },
    }));
    expect(r.statusCode).toBe(201);
    expect((await storedPricing(r.body.internalId)).pricing).toBeNull();
  });

  it('対比：同じ payload でも公開（非職員）経路はサーバ計算値を保存し total:1 改ざんを上書きする', async () => {
    asWeb();
    const r = await invoke(createReservation, staffBody({ ...dayAmFields, pricing: { total: 1 } }));
    expect(r.statusCode).toBe(201);
    const data = await storedPricing(r.body.internalId);
    // body.createdBy='staff' の自己申告は無視され、認証結果で web になる
    expect(data.createdBy).toBe('web');
    expect(data.pricing.total).toBe(1790);
    expect(data.pricingMismatch).toEqual({ claimedTotal: 1, computedTotal: 1790 });
  });
});
