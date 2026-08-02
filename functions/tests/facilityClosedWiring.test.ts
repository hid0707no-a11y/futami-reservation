// facilityClosed — 「配線」のテスト（2026-08-02 通し確認で新設）
//
// businessDays / facilityImpact の単体テストは既にあるが、そこで使う slots は
// すべて手書きの配列だった。手書きの slots は「本番で本当にその形が来るのか」を
// 保証しない＝ライブラリが正しくても、呼び出し側が繋がっていなければ意味がない。
//
// このファイルが見るのは次の2点：
//   ① 実際に canonicalizeReservation が吐く canonical（slots / serviceDates）に対して
//      チェックアウト日の扱いが期待どおりか
//   ② フロント assets/js/availability.js の isPlanFacilityClosed が
//      サーバ findClosedFacilitySlot と同じ答えを出すか（パリティ）
//
// ★★ 既知の未対応が1件あります。下の「createReservation の配線」を参照 ★★

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Availability = require('../../assets/js/availability.js');

import {
  businessCalendarFromData,
  findClosedFacilitySlot,
  findClosedDayInServiceDates,
  serviceDatesFromRange,
} from '../src/lib/businessDays';
import { canonicalizeReservation, CanonicalReservation } from '../src/lib/reservationPlans';

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const cal = (entries: unknown[]) => businessCalendarFromData({ facilityClosed: entries });

/** 宿泊プランのクライアント slots を、本番の公開HTMLと同じ規則で組む。 */
function overnightSlots(roomIds: string[], start: string, nights: number, hours: number[]): string[] {
  const checkinHour = hours[0];
  return roomIds.flatMap(roomId =>
    Array.from({ length: nights }, (_, night) =>
      hours.map(hour => `${roomId}|${addDays(start, night + (hour < checkinHour ? 1 : 0))}|${hour}`),
    ).flat(),
  );
}

/** canonicalizeReservation を通した本物の canonical を取り出す（失敗したらテストを落とす）。 */
function canonical(body: any): CanonicalReservation {
  const result = canonicalizeReservation(body);
  if (!result.ok) {
    throw new Error(`canonicalizeReservation が失敗した: ${JSON.stringify(result)}`);
  }
  return result.value;
}

const STAY_HOURS = [16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const CAMP_HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** 2泊の 27畳（9/18 IN → 9/20 OUT）。以降のテストの基準ケース。 */
function stay27TwoNights(): CanonicalReservation {
  const start = '2026-09-18';
  const nights = 2;
  return canonical({
    planId: 'stay_27',
    roomIds: ['room_27'],
    slots: overnightSlots(['room_27'], start, nights, STAY_HOURS),
    startDate: start,
    endDate: addDays(start, nights),
    nights,
  });
}

const uniqueDates = (slots: string[]): string[] =>
  Array.from(new Set(slots.map(s => s.split('|')[1]))).sort();

// ─────────────────────────────────────────────
// ① canonical の形そのものを固定する
// ─────────────────────────────────────────────
describe('canonical の前提：宿泊の slots はチェックアウト日を含み、serviceDates は含まない', () => {
  it('stay_27 の2泊は slots が3日ぶん・serviceDates が2日ぶん', () => {
    const c = stay27TwoNights();
    // slots はチェックアウト日(9/20)の早朝 0〜9時ぶんを含む
    expect(uniqueDates(c.slots)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
    // serviceDates は「泊まった日」だけ
    expect(c.serviceDates).toEqual(['2026-09-18', '2026-09-19']);
  });

  it('serviceDatesFromRange は canonical.serviceDates を正しく復元する（changeCampSites 経路の前提）', () => {
    const c = stay27TwoNights();
    expect(serviceDatesFromRange(c.startDate, c.endDate)).toEqual(c.serviceDates);
  });

  it('camp_stay（チェックイン14時・翌12時まで）でも同じ関係が成り立つ', () => {
    const start = '2026-09-18';
    const c = canonical({
      planId: 'camp_stay',
      roomIds: ['camp_1'],
      slots: overnightSlots(['camp_1'], start, 1, CAMP_HOURS),
      startDate: start,
      endDate: addDays(start, 1),
      nights: 1,
    });
    expect(uniqueDates(c.slots)).toEqual(['2026-09-18', '2026-09-19']);
    expect(c.serviceDates).toEqual(['2026-09-18']);
    expect(serviceDatesFromRange(c.startDate, c.endDate)).toEqual(c.serviceDates);
  });

  it('単日プラン（fixed_day）は slots も serviceDates も開始日だけ', () => {
    const c = canonical({
      planId: 'day_27_am',
      roomIds: ['room_27'],
      slots: [8, 9, 10, 11].map(h => `room_27|2026-09-18|${h}`),
      startDate: '2026-09-18',
      endDate: '2026-09-18',
      nights: 0,
    });
    expect(uniqueDates(c.slots)).toEqual(['2026-09-18']);
    expect(c.serviceDates).toEqual(['2026-09-18']);
  });
});

// ─────────────────────────────────────────────
// ② 本物の canonical に対する終日停止の判定（指摘[1]の本丸）
// ─────────────────────────────────────────────
describe('★本物の canonical で：終日停止はチェックアウト日だけの宿泊を拒否しない', () => {
  it('チェックアウト日(9/20)の終日停止 → 3引数なら通る', () => {
    const c = stay27TwoNights();
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-20']), c.serviceDates)).toBeNull();
  });

  it('宿泊初日(9/18)・中間日(9/19)の終日停止は従来どおり止める', () => {
    const c = stay27TwoNights();
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-18']), c.serviceDates))
      .not.toBeNull();
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-19']), c.serviceDates))
      .not.toBeNull();
  });

  it('チェックアウト日の「時間指定」停止は当たる（朝8時だけ止める運用を殺さない）', () => {
    const c = stay27TwoNights();
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-20|8']), c.serviceDates))
      .toBe('room_27|2026-09-20|8');
  });

  it('チェックアウト日にしか無い時間(10時〜)の停止は当たらない（その時間は使っていない）', () => {
    const c = stay27TwoNights();
    // stay_27 の slots はチェックアウト日は 0〜9時までしか持たない
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-20|14']), c.serviceDates)).toBeNull();
  });

  it('既存の定休日判定と同じ向き：closed_day もチェックアウト日を検査しない', () => {
    const c = stay27TwoNights();
    const dayCal = businessCalendarFromData({ defaultClosedDays: [], forceClosed: ['2026-09-20'] });
    expect(findClosedDayInServiceDates(c.serviceDates, dayCal)).toBeNull();
    // 中間日なら止まる（規約の向きが逆でないことの確認）
    const midCal = businessCalendarFromData({ defaultClosedDays: [], forceClosed: ['2026-09-19'] });
    expect(findClosedDayInServiceDates(c.serviceDates, midCal)).toBe('2026-09-19');
  });

  it('camp_stay でもチェックアウト日の終日停止は通る', () => {
    const start = '2026-09-18';
    const c = canonical({
      planId: 'camp_stay',
      roomIds: ['camp_1'],
      slots: overnightSlots(['camp_1'], start, 1, CAMP_HOURS),
      startDate: start,
      endDate: addDays(start, 1),
      nights: 1,
    });
    expect(findClosedFacilitySlot(c.slots, cal(['camp_1|2026-09-19']), c.serviceDates)).toBeNull();
    expect(findClosedFacilitySlot(c.slots, cal(['camp_1|2026-09-18']), c.serviceDates)).not.toBeNull();
  });

  it('facilityClosed が空なら serviceDates の有無に関わらず素通り（導入前と同じ）', () => {
    const c = stay27TwoNights();
    expect(findClosedFacilitySlot(c.slots, cal([]), c.serviceDates)).toBeNull();
    expect(findClosedFacilitySlot(c.slots, cal([]))).toBeNull();
  });
});

// ─────────────────────────────────────────────
// ③ ★★ 既知の未対応：createReservation がまだ serviceDates を渡していない ★★
// ─────────────────────────────────────────────
//
// findClosedFacilitySlot は第3引数 serviceDates を受け取れるようになったが、
// createReservation.ts の4箇所（224 / 239 / 355 / 445 行）は今も2引数で呼んでいる。
// つまり ② で確認した修正は **予約作成の経路ではまだ効いていない**。
//
// 実害：room_27 を 9/20 だけ終日停止すると、9/18 から2泊して 9/20 に
//       チェックアウトするだけの宿泊まで facility_closed で 400 になる。
//
// 直し方：createReservation.ts の4箇所を
//     findClosedFacilitySlot(slots, txCal)
//   → findClosedFacilitySlot(slots, txCal, canonical.serviceDates)
//   に変える（1箇所目は businessCal）。
//   直したら、このブロックの2件を ②「チェックアウト日は通る」側へ反転させること。
describe('【既知の未対応】createReservation は2引数のまま＝チェックアウト日でも止まる', () => {
  it('2引数呼び出し（＝createReservation の現状）はチェックアウト日の終日停止で止まってしまう', () => {
    const c = stay27TwoNights();
    // ここが null になったら createReservation 側が直った合図。上のコメントに従って反転する。
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-20'])))
      .toBe('room_27|2026-09-20|0');
  });

  it('changeCampSites 経路（reservation.ts）は3引数で呼べている＝こちらは修正済み', () => {
    // reservation.ts:217-218 は serviceDatesFromRange(startDate, endDate) を渡している。
    // 保存済みドキュメントしか無くても canonical と同じ serviceDates を復元できることを保証する。
    const c = stay27TwoNights();
    const restored = serviceDatesFromRange(c.startDate, c.endDate);
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-20']), restored)).toBeNull();
    expect(findClosedFacilitySlot(c.slots, cal(['room_27|2026-09-19']), restored)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────
// ④ フロント isPlanFacilityClosed（assets/js/availability.js）
// ─────────────────────────────────────────────
const planClosed = (
  facilityClosed: unknown[], roomId: string, date: string, hours: unknown,
): boolean => Availability.isPlanFacilityClosed(facilityClosed, roomId, date, hours);

const D = '2026-09-20';
// ふたみの日サウナの4枠（index.html の plan.slots と同じ）
const FUTAMI_SLOTS: Record<string, number[]> = {
  A: [10, 11],
  B: [12, 13, 14],
  C: [15, 16],
  D: [17, 18, 19],
};

describe('availability.js isPlanFacilityClosed — export と基本動作', () => {
  it('関数として export されている', () => {
    expect(typeof Availability.isPlanFacilityClosed).toBe('function');
  });

  it('facilityClosed が空／未設定なら常に false（導入前と完全に同じ）', () => {
    for (const empty of [[], null, undefined, 'x', 0]) {
      expect(planClosed(empty as any, 'sauna_share', D, FUTAMI_SLOTS.A)).toBe(false);
    }
  });

  it('roomId / date が空なら false', () => {
    expect(planClosed([`sauna|${D}`], '', D, FUTAMI_SLOTS.A)).toBe(false);
    expect(planClosed([`sauna|${D}`], 'sauna_share', '', FUTAMI_SLOTS.A)).toBe(false);
  });
});

describe('availability.js isPlanFacilityClosed — 終日停止', () => {
  it('終日停止なら全枠が閉じる', () => {
    for (const hours of Object.values(FUTAMI_SLOTS)) {
      expect(planClosed([`sauna_share|${D}`], 'sauna_share', D, hours)).toBe(true);
    }
  });

  it('サウナ連動：sauna への終日停止が sauna_share のプランにも効く', () => {
    for (const hours of Object.values(FUTAMI_SLOTS)) {
      expect(planClosed([`sauna|${D}`], 'sauna_share', D, hours)).toBe(true);
    }
  });

  it('逆向きも効く：sauna_share への停止が通常サウナに効く', () => {
    expect(planClosed([`sauna_share|${D}`], 'sauna', D, [15, 16])).toBe(true);
  });

  it('別日・別施設には効かない', () => {
    expect(planClosed([`sauna|2026-09-21`], 'sauna_share', D, FUTAMI_SLOTS.A)).toBe(false);
    expect(planClosed([`room_27|${D}`], 'sauna_share', D, FUTAMI_SLOTS.A)).toBe(false);
  });
});

describe('availability.js isPlanFacilityClosed — 時間指定の停止', () => {
  it('プランを構成する時間が1つでも止まっていればプランごと閉じる', () => {
    expect(planClosed([`sauna|${D}|13`], 'sauna_share', D, FUTAMI_SLOTS.B)).toBe(true);
  });

  it('プランに含まれない時間の停止では閉じない', () => {
    expect(planClosed([`sauna|${D}|13`], 'sauna_share', D, FUTAMI_SLOTS.A)).toBe(false);
    expect(planClosed([`sauna|${D}|13`], 'sauna_share', D, FUTAMI_SLOTS.C)).toBe(false);
    expect(planClosed([`sauna|${D}|13`], 'sauna_share', D, FUTAMI_SLOTS.D)).toBe(false);
  });

  it('境界（枠の先頭・末尾の時間）でも当たる', () => {
    expect(planClosed([`sauna|${D}|12`], 'sauna_share', D, FUTAMI_SLOTS.B)).toBe(true);
    expect(planClosed([`sauna|${D}|14`], 'sauna_share', D, FUTAMI_SLOTS.B)).toBe(true);
    expect(planClosed([`sauna|${D}|11`], 'sauna_share', D, FUTAMI_SLOTS.B)).toBe(false);
    expect(planClosed([`sauna|${D}|15`], 'sauna_share', D, FUTAMI_SLOTS.B)).toBe(false);
  });
});

describe('availability.js isPlanFacilityClosed — hours が無いプランは終日停止だけを見る', () => {
  // テニス・ロッジ日帰りは利用者が枠を選ぶ。1枠の停止で日付ごと弾くと誤爆になる。
  it.each([[[]], [null], [undefined], ['0800'], [{}]])(
    'hours=%p のとき時間指定の停止では閉じない', (hours) => {
      expect(planClosed([`court_1|${D}|8`], 'court_1', D, hours as any)).toBe(false);
    });

  it.each([[[]], [null], [undefined], ['0800'], [{}]])(
    'hours=%p でも終日停止なら閉じる', (hours) => {
      expect(planClosed([`court_1|${D}`], 'court_1', D, hours as any)).toBe(true);
    });
});

describe('availability.js isPlanFacilityClosed — 壊れた入力で落ちない', () => {
  const BROKEN: unknown[] = [
    null, undefined, 42, {}, [], '', 'sauna', `sauna|${D}|10|extra`,
    `sauna|${D}|99`, `sauna|${D}|-1`, `sauna|${D}|abc`, `sauna|2026-02-30`, `SAUNA|${D}`,
  ];

  it('壊れた要素だけなら false（例外も投げない）', () => {
    expect(() => planClosed(BROKEN, 'sauna_share', D, FUTAMI_SLOTS.A)).not.toThrow();
    expect(planClosed(BROKEN, 'sauna_share', D, FUTAMI_SLOTS.A)).toBe(false);
  });

  it('壊れた要素に混じった有効な停止は効く', () => {
    expect(planClosed([...BROKEN, `sauna|${D}|10`], 'sauna_share', D, FUTAMI_SLOTS.A)).toBe(true);
  });

  it('hours の中に壊れた値があっても、有効な時間の判定は生きる', () => {
    expect(planClosed([`sauna|${D}|11`], 'sauna_share', D, [null, 'abc', 11])).toBe(true);
    expect(planClosed([`sauna|${D}|11`], 'sauna_share', D, [null, 'abc', 99])).toBe(false);
  });
});

// ─────────────────────────────────────────────
// ⑤ サーバ⇄フロントのパリティ（isPlanFacilityClosed 版）
// ─────────────────────────────────────────────
describe('★パリティ：isPlanFacilityClosed の答えがサーバ findClosedFacilitySlot と一致する', () => {
  // 「画面では空きに見えるのに予約すると400」を防ぐ不変条件。
  // ふたみの日サウナは1予約で枠を丸ごと占有する＝プラン単位の判定がそのまま在庫判定になる。
  const CASES: Array<[string, unknown[], string, number[]]> = [
    ['停止なし', [], 'sauna_share', FUTAMI_SLOTS.A],
    ['sauna 終日', [`sauna|${D}`], 'sauna_share', FUTAMI_SLOTS.A],
    ['sauna_share 終日', [`sauna_share|${D}`], 'sauna_share', FUTAMI_SLOTS.B],
    ['sauna 10時（A枠に当たる）', [`sauna|${D}|10`], 'sauna_share', FUTAMI_SLOTS.A],
    ['sauna 10時（B枠には当たらない）', [`sauna|${D}|10`], 'sauna_share', FUTAMI_SLOTS.B],
    ['sauna 13時（B枠の中間）', [`sauna|${D}|13`], 'sauna_share', FUTAMI_SLOTS.B],
    ['sauna_share 17時（D枠先頭）', [`sauna_share|${D}|17`], 'sauna_share', FUTAMI_SLOTS.D],
    ['sauna_share 19時（D枠末尾）', [`sauna_share|${D}|19`], 'sauna_share', FUTAMI_SLOTS.D],
    ['通常サウナ側から sauna_share の停止', [`sauna_share|${D}`], 'sauna', [15, 16]],
    ['別日', [`sauna|2026-09-21`], 'sauna_share', FUTAMI_SLOTS.C],
    ['別施設', [`room_27|${D}`], 'sauna_share', FUTAMI_SLOTS.C],
    ['壊れた要素のみ', [`sauna|${D}|abc`, 'sauna', 42], 'sauna_share', FUTAMI_SLOTS.A],
  ];

  it.each(CASES)('%s', (_name, entries, roomId, hours) => {
    const slots = hours.map(h => `${roomId}|${D}|${h}`);
    const server = findClosedFacilitySlot(slots, cal(entries)) !== null;
    const front = planClosed(entries, roomId, D, hours);
    expect(front).toBe(server);
  });

  it('★安全側の不変条件：サーバが閉じるプランをフロントが開けて見せることは無い', () => {
    const RAW: unknown[][] = [
      [`sauna|${D}`], [`sauna_share|${D}`], [`sauna|${D}|10`], [`sauna|${D}|0`],
      [`sauna|${D}|08`], [`sauna|2026-02-30`], [`SAUNA|${D}`], [`sauna|${D}|10|extra`],
      ['sauna'], [''], [42], [null], [undefined], [{}],
    ];
    for (const entries of RAW) {
      for (const [name, hours] of Object.entries(FUTAMI_SLOTS)) {
        const slots = hours.map(h => `sauna_share|${D}|${h}`);
        const server = findClosedFacilitySlot(slots, cal(entries)) !== null;
        const front = planClosed(entries, 'sauna_share', D, hours);
        // server === true なら front も true でなければならない
        expect({ entries, name, ok: !server || front }).toEqual({ entries, name, ok: true });
      }
    }
  });
});
