// 施設ごとの停止（facilityClosed）の integration test（Firestore Emulator）
//
// 2026-08-02 新設。運営（西田さん）の要望「サウナだけをその日は予約不可にしたい」。
// 従来はダミー予約を入れて塞いでいたため、運営宛メールの大量送信と行政報告用スプシへの
// 架空売上計上という副作用が出ていた。facilityClosed は在庫を1件も作らずに止める。
//
// 検証するのは3点：
//   ① businessCalendar POST の検証（契約外の形は保存させない）
//   ② dryRun が一切書き込まず、矛盾する既存予約を返す
//      （2026-09-24 に臨時休業日を追加した際、その日の有料予約が取り残された事故の再発防止）
//   ③ createReservation 実コードが facility_closed で 400 を返し、在庫も予約も作らない
//
// 実行：
//   $ export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   $ firebase emulators:start --only firestore --project futami-yoyaku-492607
//   $ cd functions && npm run test:integration

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
import { businessCalendar } from '../../src/handlers/availability';
import { createReservation } from '../../src/handlers/createReservation';

const db = admin.firestore();

/** onRequest ハンドラを実行し、res に書かれた結果を待つ。 */
function invoke(handler: any, req: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      headersSent: false,
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
const OPEN_WEDNESDAY = addDays(CLOSED_TUESDAY, 1);
const OPEN_THURSDAY = addDays(CLOSED_TUESDAY, 2);

function fixedSlots(roomId: string, date: string, hours: number[]): string[] {
  return hours.map(hour => roomId + '|' + date + '|' + hour);
}

/** POST /businessCalendar（スタッフ認証はモック済み） */
const calPost = (body: any) => invoke(businessCalendar, { method: 'POST', query: {}, headers: {}, body });
const calGet = () => invoke(businessCalendar, { method: 'GET', query: {}, headers: {}, body: {} });

/** GET は 60 秒キャッシュを持つ。POST が必ずキャッシュを落とすので GET の前に1回 POST する。 */
async function calGetFresh() {
  await calPost({});           // 書込み内容なし＝updatedAt のみ。副作用でキャッシュが落ちる
  return calGet();
}

const CAL_DOC = 'config/business_calendar';
const readCal = async () => (await db.doc(CAL_DOC).get()).data() as any;

beforeEach(clearDb);
afterAll(async () => { await admin.app().delete(); });

// ─────────────────────────────────────────────
// ① POST の検証
// ─────────────────────────────────────────────
describe('businessCalendar POST — facilityClosed の検証', () => {
  it('終日キーと時間キーを保存できる', async () => {
    const entries = [
      `sauna|${OPEN_WEDNESDAY}`,
      `sauna|${OPEN_THURSDAY}|10`,
      `court_wall|${OPEN_WEDNESDAY}|0`,
      `room_27|${OPEN_WEDNESDAY}|23`,
    ];
    const r = await calPost({ facilityClosed: entries });
    expect(r.statusCode).toBe(200);
    expect((await readCal()).facilityClosed).toEqual(entries);
  });

  it('GET のレスポンスに facilityClosed が含まれる', async () => {
    const entries = [`sauna|${OPEN_WEDNESDAY}|12`];
    await calPost({ facilityClosed: entries });
    const r = await calGet();
    expect(r.statusCode).toBe(200);
    expect(r.body.facilityClosed).toEqual(entries);
    // 既存3項目も従来どおり返る（形が変わっていない）
    expect(r.body).toEqual({
      defaultClosedDays: [2], forceOpen: [], forceClosed: [], facilityClosed: entries,
    });
  });

  it('facilityClosed 未設定の既存ドキュメントでも GET は空配列を返す（回帰）', async () => {
    await db.doc(CAL_DOC).set({ defaultClosedDays: [2], forceOpen: [], forceClosed: [] });
    const r = await calGetFresh();
    expect(r.statusCode).toBe(200);
    expect(r.body.facilityClosed).toEqual([]);
  });

  it.each([
    ['配列でない（文字列）', `sauna|${OPEN_WEDNESDAY}`],
    ['配列でない（オブジェクト）', { a: 1 }],
    ['配列でない（数値）', 3],
    ['未知の roomId', [`nonexistent_room|${OPEN_WEDNESDAY}`]],
    ['存在しない日付', ['sauna|2026-02-30']],
    ['ゼロ埋めなし日付', ['sauna|2026-9-20']],
    ['hour 24', [`sauna|${OPEN_WEDNESDAY}|24`]],
    ['hour 負', [`sauna|${OPEN_WEDNESDAY}|-1`]],
    ['hour ゼロ埋め', [`sauna|${OPEN_WEDNESDAY}|08`]],
    ['要素が多い', [`sauna|${OPEN_WEDNESDAY}|10|extra`]],
    ['区切りが足りない', ['sauna']],
    ['空文字', ['']],
    ['数値要素', [123]],
    ['null 要素', [null]],
    ['有効値に1件だけ不正が混じる', [`sauna|${OPEN_WEDNESDAY}`, `sauna|${OPEN_WEDNESDAY}|24`]],
  ])('%s は 400 invalid_facilityClosed で1件も書き込まない', async (_name, payload) => {
    const r = await calPost({ facilityClosed: payload });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_facilityClosed');
    expect((await db.doc(CAL_DOC).get()).exists).toBe(false);
  });

  it('2000件は保存でき、2001件は 400', async () => {
    const mk = (n: number) => Array.from({ length: n },
      (_, i) => `sauna|${addDays('2026-01-01', i % 365)}|${i % 24}`);
    const ok = await calPost({ facilityClosed: mk(2000) });
    expect(ok.statusCode).toBe(200);
    expect((await readCal()).facilityClosed.length).toBe(2000);

    const ng = await calPost({ facilityClosed: mk(2001) });
    expect(ng.statusCode).toBe(400);
    expect(ng.body.error).toBe('invalid_facilityClosed');
    // 直前の 2000 件が壊されていない
    expect((await readCal()).facilityClosed.length).toBe(2000);
  });

  it('facilityClosed を送らない POST は既存の停止設定を消さない（merge）', async () => {
    const entries = [`sauna|${OPEN_WEDNESDAY}`];
    await calPost({ facilityClosed: entries });
    const r = await calPost({ forceClosed: [OPEN_THURSDAY] });
    expect(r.statusCode).toBe(200);
    const after = await readCal();
    expect(after.facilityClosed).toEqual(entries);
    expect(after.forceClosed).toEqual([OPEN_THURSDAY]);
  });

  it('空配列を送ると全解除できる', async () => {
    await calPost({ facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    const r = await calPost({ facilityClosed: [] });
    expect(r.statusCode).toBe(200);
    expect((await readCal()).facilityClosed).toEqual([]);
  });

  it('既存3項目の検証は変わっていない（回帰）', async () => {
    expect((await calPost({ defaultClosedDays: [1.5] })).body.error).toBe('invalid_defaultClosedDays');
    expect((await calPost({ forceOpen: ['2026-02-30'] })).body.error).toBe('invalid_forceOpen');
    expect((await calPost({ forceClosed: ['broken'] })).body.error).toBe('invalid_forceClosed');
    expect((await db.doc(CAL_DOC).get()).exists).toBe(false);
  });
});

// ─────────────────────────────────────────────
// ② dryRun
// ─────────────────────────────────────────────
describe('businessCalendar POST dryRun — 書き込まずに矛盾予約を返す', () => {
  /** confirmed 予約を1件作る */
  async function putReservation(id: string, over: any = {}) {
    await db.collection('reservations').doc(id).set({
      status: 'confirmed',
      displayId: 'F-' + id.toUpperCase(),
      planId: 'sauna_1',
      roomIds: ['sauna'],
      slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10, 11]),
      startDate: OPEN_WEDNESDAY,
      endDate: OPEN_WEDNESDAY,
      customer: { name: '西田 花子' },
      pricing: { total: 13200 },
      ...over,
    });
  }

  it('dryRun は config を1文字も書き換えない', async () => {
    await calPost({ facilityClosed: [`sauna|${OPEN_THURSDAY}`], forceClosed: [] });
    const before = await readCal();

    const r = await calPost({
      dryRun: true,
      facilityClosed: [`sauna|${OPEN_WEDNESDAY}`],
      forceClosed: [OPEN_WEDNESDAY],
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.dryRun).toBe(true);

    const after = await readCal();
    expect(after.facilityClosed).toEqual(before.facilityClosed);
    expect(after.forceClosed).toEqual(before.forceClosed);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('config が未作成なら dryRun は作成もしない', async () => {
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.statusCode).toBe(200);
    expect((await db.doc(CAL_DOC).get()).exists).toBe(false);
  });

  it('施設停止と矛盾する confirmed 予約を返す（必要な項目が揃っている）', async () => {
    await putReservation('r1');
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.statusCode).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.affected).toEqual([{
      displayId: 'F-R1',
      planId: 'sauna_1',
      roomIds: ['sauna'],
      startDate: OPEN_WEDNESDAY,
      customerName: '西田 花子',
      total: 13200,
    }]);
  });

  it('時間指定の停止は、その時間の予約だけを拾う', async () => {
    await putReservation('a', { displayId: 'F-A', slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10, 11]) });
    await putReservation('b', { displayId: 'F-B', planId: 'sauna_2', slots: fixedSlots('sauna', OPEN_WEDNESDAY, [12, 13, 14]) });

    const hitA = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}|10`] });
    expect(hitA.body.count).toBe(1);
    expect(hitA.body.affected[0].displayId).toBe('F-A');

    const hitB = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}|13`] });
    expect(hitB.body.count).toBe(1);
    expect(hitB.body.affected[0].displayId).toBe('F-B');

    const none = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}|20`] });
    expect(none.body.count).toBe(0);
    expect(none.body.affected).toEqual([]);
  });

  it('cancelled 予約は矛盾に数えない', async () => {
    await putReservation('c1', { status: 'cancelled' });
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.body.count).toBe(0);
    expect(r.body.affected).toEqual([]);
  });

  it('サウナ連動：sauna_share の予約が sauna の停止で検出される（逆も）', async () => {
    await putReservation('f1', {
      displayId: 'F-FUTAMI', planId: 'plan_sauna_futami',
      roomIds: ['sauna_share'], slots: fixedSlots('sauna_share', OPEN_WEDNESDAY, [10, 11]),
    });
    const bySauna = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(bySauna.body.count).toBe(1);
    expect(bySauna.body.affected[0].displayId).toBe('F-FUTAMI');

    await clearDb();
    await putReservation('n1', { displayId: 'F-NORMAL' });   // 通常サウナ（roomIds: sauna）
    const byShare = await calPost({ dryRun: true, facilityClosed: [`sauna_share|${OPEN_WEDNESDAY}`] });
    expect(byShare.body.count).toBe(1);
    expect(byShare.body.affected[0].displayId).toBe('F-NORMAL');
  });

  it('他施設の予約は巻き込まない', async () => {
    await putReservation('x1', {
      planId: 'day_27_am', roomIds: ['room_27'],
      slots: fixedSlots('room_27', OPEN_WEDNESDAY, [8, 9, 10, 11]),
    });
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.body.count).toBe(0);
  });

  it('★臨時休業日（forceClosed）の追加でも矛盾予約を返す（2026-09-24 事故の再発防止）', async () => {
    await putReservation('p1');
    const r = await calPost({ dryRun: true, forceClosed: [OPEN_WEDNESDAY] });
    expect(r.statusCode).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.affected[0].displayId).toBe('F-P1');
    expect(r.body.affected[0].total).toBe(13200);
  });

  it('既に登録済みの臨時休業日を送り直しても警告しない（追加日だけ見る）', async () => {
    await putReservation('p2');
    await calPost({ forceClosed: [OPEN_WEDNESDAY] });
    const r = await calPost({ dryRun: true, forceClosed: [OPEN_WEDNESDAY] });
    expect(r.body.count).toBe(0);
    expect(r.body.affected).toEqual([]);
  });

  it('連泊予約は途中の日に休業日を入れても検出される', async () => {
    await putReservation('s1', {
      planId: 'lodge_stay', roomIds: ['lodge_a'],
      slots: [`lodge_a|${OPEN_WEDNESDAY}|16`, `lodge_a|${OPEN_THURSDAY}|8`],
      startDate: OPEN_WEDNESDAY, endDate: OPEN_THURSDAY,
    });
    const r = await calPost({ dryRun: true, forceClosed: [OPEN_THURSDAY] });
    expect(r.body.count).toBe(1);
  });

  it('slots が欠けた古い予約でも roomIds×日付で終日停止に当たる', async () => {
    await putReservation('old1', { slots: [] });
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.body.count).toBe(1);
  });

  it('職員手動予約（pricing:null）は total が null で返る', async () => {
    await putReservation('m1', { pricing: null });
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.body.count).toBe(1);
    expect(r.body.affected[0].total).toBeNull();
  });

  it('affected は最大50件・count は総数を返す', async () => {
    const batch = db.batch();
    for (let i = 0; i < 55; i++) {
      batch.set(db.collection('reservations').doc('bulk' + i), {
        status: 'confirmed', displayId: 'F-B' + i, planId: 'sauna_1', roomIds: ['sauna'],
        slots: fixedSlots('sauna', OPEN_WEDNESDAY, [10, 11]),
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY,
        customer: { name: 'テスト' }, pricing: { total: 13200 },
      });
    }
    await batch.commit();
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.body.count).toBe(55);
    expect(r.body.affected.length).toBe(50);
  });

  it('影響なしなら空で返す（確認ダイアログを出さないため）', async () => {
    await putReservation('q1');
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_THURSDAY}`] });
    expect(r.body).toEqual({ dryRun: true, affected: [], count: 0 });
  });

  it('dryRun でも不正な facilityClosed は 400（検証が先）', async () => {
    const r = await calPost({ dryRun: true, facilityClosed: [`sauna|${OPEN_WEDNESDAY}|24`] });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('invalid_facilityClosed');
  });

  it('dryRun:false / 未指定なら従来どおり書き込む', async () => {
    const r = await calPost({ dryRun: false, facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await readCal()).facilityClosed).toEqual([`sauna|${OPEN_WEDNESDAY}`]);
  });
});

// ─────────────────────────────────────────────
// ③ createReservation 実コードでの強制
// ─────────────────────────────────────────────
describe('createReservation — facility_closed の強制（real-path）', () => {
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

  it('停止なしなら従来どおり成立する（回帰：既存挙動を壊していない）', async () => {
    const r = await invoke(createReservation, saunaBody());
    expect(r.statusCode).toBe(201);
    expect((await db.collection('slots').doc(`sauna|${OPEN_WEDNESDAY}|10`).get()).exists).toBe(true);
  });

  it('facilityClosed が空配列でも従来どおり成立する', async () => {
    await calPost({ facilityClosed: [] });
    const r = await invoke(createReservation, saunaBody());
    expect(r.statusCode).toBe(201);
  });

  it('終日停止のサウナは 400 facility_closed で、在庫も予約も作られない', async () => {
    await calPost({ facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
    const r = await invoke(createReservation, saunaBody());
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('facility_closed');
    expect(r.body.detail).toBe(`sauna|${OPEN_WEDNESDAY}|10`);
    // ★ダミー予約と違い在庫も予約も1件も作らない（メール送信・スプシ計上が起きない根拠）
    expect((await db.collection('slots').doc(`sauna|${OPEN_WEDNESDAY}|10`).get()).exists).toBe(false);
    expect((await db.collection('reservations').get()).size).toBe(0);
  });

  it('時間指定の停止は当たった枠だけ落とす（A枠400 / B枠201）', async () => {
    await calPost({ facilityClosed: [`sauna|${OPEN_WEDNESDAY}|10`] });
    const a = await invoke(createReservation, saunaBody());
    expect(a.statusCode).toBe(400);
    expect(a.body.error).toBe('facility_closed');

    const b = await invoke(createReservation, saunaBody({
      planId: 'sauna_2', slots: fixedSlots('sauna', OPEN_WEDNESDAY, [12, 13, 14]),
    }));
    expect(b.statusCode).toBe(201);
  });

  it('サウナ連動：sauna の停止でふたみの日（sauna_share）も 400', async () => {
    await db.doc('config/special_days').set({ sauna_capacity_days: [OPEN_THURSDAY] });
    await calPost({ facilityClosed: [`sauna|${OPEN_THURSDAY}`] });
    const r = await invoke(createReservation, saunaBody({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots('sauna_share', OPEN_THURSDAY, [10, 11]),
      startDate: OPEN_THURSDAY, endDate: OPEN_THURSDAY,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('facility_closed');
    expect((await db.collection('reservations').get()).size).toBe(0);
  });

  it('サウナ連動：sauna_share の停止で通常サウナも 400', async () => {
    await calPost({ facilityClosed: [`sauna_share|${OPEN_WEDNESDAY}`] });
    const r = await invoke(createReservation, saunaBody());
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('facility_closed');
  });

  it('テニスは HHMM スロットでも終日停止で 400', async () => {
    await calPost({ facilityClosed: [`court_wall|${OPEN_WEDNESDAY}`] });
    const r = await invoke(createReservation, {
      method: 'POST', query: {}, headers: {},
      body: {
        planId: 'tennis_half', roomIds: ['court_wall'],
        slots: [`court_wall|${OPEN_WEDNESDAY}|1800`, `court_wall|${OPEN_WEDNESDAY}|1830`],
        startDate: OPEN_WEDNESDAY, endDate: OPEN_WEDNESDAY, nights: 0,
        customer: { name: '半面 太郎', phone: '090-1111-2222', isMember: true },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('facility_closed');
    expect((await db.collection('tennis_slots').get()).size).toBe(0);
  });

  it('停止したのと別の施設は影響を受けない', async () => {
    await calPost({ facilityClosed: [`sauna|${OPEN_WEDNESDAY}`] });
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

  it('停止したのと別の日は影響を受けない', async () => {
    await calPost({ facilityClosed: [`sauna|${OPEN_THURSDAY}`] });
    const r = await invoke(createReservation, saunaBody());
    expect(r.statusCode).toBe(201);
  });

  it('日付単位の closed_day が facility_closed より先に返る（既存挙動の順序を保つ）', async () => {
    await calPost({ facilityClosed: [`sauna|${CLOSED_TUESDAY}`] });
    const r = await invoke(createReservation, saunaBody({
      slots: fixedSlots('sauna', CLOSED_TUESDAY, [10, 11]),
      startDate: CLOSED_TUESDAY, endDate: CLOSED_TUESDAY,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('closed_day');
  });
});
