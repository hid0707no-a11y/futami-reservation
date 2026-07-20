// サーバ側 権威的 料金計算（lib/pricingServer.ts）のユニットテスト（#17）。
//
// 検証する不変条件：
//  a. 価格表(SERVER_PLAN_PRICING)が docs/pricing.json / index.html PLANS とドリフトしていない
//  b. コア純関数の期待値マトリクス（pricing.test.ts の期待値を再利用）
//  c. パリティ：assets/js/pricing.js と同一入力で完全一致
//  d. 網羅ガード：RESERVATION_PLAN_RULES の全 planId に計算経路がある（将来のプラン追加漏れ検出）
//  e. computeServerPricing のプラン別期待値・学生/シーツ復元・平日割・sportGuestEstimate・mismatch
//  f. 平日割/祝日のサーバ自律判定

import * as fs from 'fs';
import * as path from 'path';

import {
  SERVER_PLAN_PRICING, SAUNA_OPTION_PRICES,
  calculateStayPrice, calculateHourlyTennisPrice, calculateCampPrice,
  isJapaneseHoliday, isTennisWeekdayDiscountSlot, tennisHourKeysFromSlots,
  computeServerPricing,
} from '../src/lib/pricingServer';
import { RESERVATION_PLAN_RULES, CanonicalReservation } from '../src/lib/reservationPlans';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NisshoPricing = require('../../assets/js/pricing.js');

const ROOT = path.resolve(__dirname, '../..');
const pricingJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'pricing.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** index.html の PLANS から planId ブロック内の数値フィールドを1つ取り出す（drift 検出用）。 */
function htmlPlanNumber(planId: string, field: string): number {
  const idx = indexHtml.indexOf(`id: '${planId}'`);
  if (idx < 0) throw new Error(`plan not found in index.html: ${planId}`);
  const block = indexHtml.slice(idx, idx + 600);
  const m = block.match(new RegExp(`\\b${field}:\\s*(\\d+)`));
  if (!m) throw new Error(`field ${field} not found for ${planId}`);
  return Number(m[1]);
}

// ─────────────────────────────────────────────
// a. ドリフト検出
// ─────────────────────────────────────────────
describe('価格表ドリフト検出（SERVER_PLAN_PRICING ↔ docs/pricing.json）', () => {
  it('テニス一面貸切・平日割・照明', () => {
    const t = SERVER_PLAN_PRICING.tennis_full as any;
    expect(t.residentPrice).toBe(pricingJson.tennis.full.resident);
    expect(t.nonResidentPrice).toBe(pricingJson.tennis.full.nonResident);
    expect(t.weekdayDiscountResident).toBe(pricingJson.tennis.full.weekdayDiscount.resident);
    expect(t.weekdayDiscountNonResident).toBe(pricingJson.tennis.full.weekdayDiscount.nonResident);
    expect(t.lightingPrice).toBe(pricingJson.tennis.lighting.price);
  });

  it('みどりの広場 全4枠（市民/市外/学生市民/学生市外）＋夜間照明', () => {
    const map: Record<string, string> = { midori_am: 'am', midori_pm: 'pm', midori_day: 'day', midori_eve: 'eve' };
    for (const [planId, key] of Object.entries(map)) {
      const m = SERVER_PLAN_PRICING[planId] as any;
      expect(m.resident).toBe(pricingJson.midori[key].resident);
      expect(m.nonResident).toBe(pricingJson.midori[key].nonResident);
      expect(m.studentResident).toBe(pricingJson.midori[key].studentResident);
      expect(m.studentNonResident).toBe(pricingJson.midori[key].studentNonResident);
    }
    expect((SERVER_PLAN_PRICING.midori_eve as any).lightingPrice).toBe(pricingJson.midori.lighting.price);
  });

  it('室別日帰り（27畳/体験/研修 × am/pm/eve/daytime/all）', () => {
    const facilities: Record<string, string> = { twentySeven: 'day_27', experience: 'day_exp', training: 'day_train' };
    const slots: Record<string, string> = { am: 'am', pm: 'pm', eve: 'eve', daytime: 'daytime', all: 'all' };
    for (const [facKey, prefix] of Object.entries(facilities)) {
      for (const [jsonKey, planSuffix] of Object.entries(slots)) {
        const planId = `${prefix}_${planSuffix}`;
        expect((SERVER_PLAN_PRICING[planId] as any).basePrice).toBe(pricingJson.roomDay[facKey][jsonKey]);
      }
    }
  });

  it('サウナ（通常/ふたみの日/オプション）', () => {
    expect((SERVER_PLAN_PRICING.sauna_1 as any).basePrice).toBe(pricingJson.sauna.base.price);
    expect((SERVER_PLAN_PRICING.plan_sauna_futami as any).pricePerPerson).toBe(pricingJson.sauna.futamiDay.price);
    expect(SAUNA_OPTION_PRICES.towel).toBe(pricingJson.sauna.options.towel.price);
    expect(SAUNA_OPTION_PRICES.tarpTent).toBe(pricingJson.sauna.options.tarpTent.price);
    expect(SAUNA_OPTION_PRICES.ice20kg).toBe(pricingJson.sauna.options.ice.price);
  });
});

describe('価格表ドリフト検出（SERVER_PLAN_PRICING ↔ index.html PLANS・pricing.json 非掲載分）', () => {
  it('宿泊（基本料金＋人数加算）', () => {
    for (const planId of ['stay_6', 'stay_27', 'stay_exp', 'stay_all']) {
      const s = SERVER_PLAN_PRICING[planId] as any;
      expect(s.basePrice).toBe(htmlPlanNumber(planId, 'basePrice'));
      expect(s.extraAdult).toBe(htmlPlanNumber(planId, 'extraAdult'));
      expect(s.extraChild).toBe(htmlPlanNumber(planId, 'extraChild'));
      expect(s.extraInfant).toBe(htmlPlanNumber(planId, 'extraInfant'));
    }
  });

  it('固定料金・キャンプ・ロッジ', () => {
    expect((SERVER_PLAN_PRICING.day_6_all as any).basePrice).toBe(htmlPlanNumber('day_6_all', 'basePrice'));
    expect((SERVER_PLAN_PRICING.day_kitchen as any).basePrice).toBe(htmlPlanNumber('day_kitchen', 'basePrice'));
    expect((SERVER_PLAN_PRICING.camp_stay as any).basePrice).toBe(htmlPlanNumber('camp_stay', 'basePrice'));
    expect((SERVER_PLAN_PRICING.lodge_stay as any).basePrice).toBe(htmlPlanNumber('lodge_stay', 'basePrice'));
    expect((SERVER_PLAN_PRICING.lodge_day as any).basePrice).toBe(htmlPlanNumber('lodge_day', 'basePrice'));
  });
});

// ─────────────────────────────────────────────
// b. コア純関数 期待値マトリクス（pricing.test.ts の期待値を再利用）
// ─────────────────────────────────────────────
describe('calculateStayPrice（コア）', () => {
  const stay6 = { basePrice: 2310, extraAdult: 1580, extraChild: 1050, extraInfant: 790 };
  it('1室1泊 大人3名 = 7050', () => {
    expect(calculateStayPrice(stay6, { roomCount: 1, nights: 1, guestsAdult: 3, guestsChild: 0, guestsInfant: 0 })).toBe(7050);
  });
  it('2室1泊 大人6名 = 14100', () => {
    expect(calculateStayPrice(stay6, { roomCount: 2, nights: 1, guestsAdult: 6, guestsChild: 0, guestsInfant: 0 })).toBe(14100);
  });
  it('1室3泊 大人2名 = 16410', () => {
    expect(calculateStayPrice(stay6, { roomCount: 1, nights: 3, guestsAdult: 2, guestsChild: 0, guestsInfant: 0 })).toBe(16410);
  });
  it('小学生・未就学児加算 = 5200', () => {
    expect(calculateStayPrice(stay6, { roomCount: 1, nights: 1, guestsAdult: 0, guestsChild: 2, guestsInfant: 1 })).toBe(5200);
  });
  it('roomCount=0/nights=0 は 1 にフォールバック', () => {
    expect(calculateStayPrice(stay6, { roomCount: 0, nights: 0, guestsAdult: 1, guestsChild: 0, guestsInfant: 0 })).toBe(2310 + 1580);
  });
});

describe('calculateHourlyTennisPrice（コア）', () => {
  const tennis = {
    residentPrice: 630, nonResidentPrice: 760, weekdayDiscount: true,
    weekdayDiscountResident: 320, weekdayDiscountNonResident: 380, lightingPrice: 630,
  };
  it('市民・通常2枠 = 1260', () => {
    expect(calculateHourlyTennisPrice(tennis, { hours: ['0900', '0930'], isResident: true, useLighting: false, courtCount: 1, isWeekdayDiscountHour: () => false })).toBe(1260);
  });
  it('市民・平日割2枠 = 640', () => {
    expect(calculateHourlyTennisPrice(tennis, { hours: ['1000', '1030'], isResident: true, useLighting: false, courtCount: 1, isWeekdayDiscountHour: () => true })).toBe(640);
  });
  it('複数コート倍率 = 3780', () => {
    expect(calculateHourlyTennisPrice(tennis, { hours: ['0900', '0930'], isResident: true, useLighting: false, courtCount: 3, isWeekdayDiscountHour: () => false })).toBe(3780);
  });
  it('夜間照明ON = 2780', () => {
    expect(calculateHourlyTennisPrice(tennis, { hours: ['1800', '1830'], isResident: false, useLighting: true, courtCount: 1, isWeekdayDiscountHour: () => false })).toBe(2780);
  });
  it('割引固定値未設定はフォールバック 320', () => {
    const plan = { residentPrice: 630, nonResidentPrice: 760, weekdayDiscount: true };
    expect(calculateHourlyTennisPrice(plan, { hours: ['0900'], isResident: true, useLighting: false, courtCount: 1, isWeekdayDiscountHour: () => true })).toBe(320);
  });
});

describe('calculateCampPrice（コア）', () => {
  it('3区画2泊 = 4740', () => {
    expect(calculateCampPrice({ basePrice: 790 }, { siteCount: 3, nights: 2 })).toBe(4740);
  });
  it('0区画は0', () => {
    expect(calculateCampPrice({ basePrice: 790 }, { siteCount: 0, nights: 1 })).toBe(0);
  });
});

// ─────────────────────────────────────────────
// c. パリティ（pricing.js と完全一致）
// ─────────────────────────────────────────────
describe('パリティ：pricingServer コア ≡ assets/js/pricing.js', () => {
  const stayPlan = { basePrice: 2310, extraAdult: 1580, extraChild: 1050, extraInfant: 790 };
  const stayCases = [
    { roomCount: 1, nights: 1, guestsAdult: 3, guestsChild: 0, guestsInfant: 0 },
    { roomCount: 2, nights: 1, guestsAdult: 6, guestsChild: 1, guestsInfant: 2 },
    { roomCount: 4, nights: 14, guestsAdult: 10, guestsChild: 3, guestsInfant: 1 },
    { roomCount: 0, nights: 0, guestsAdult: 1, guestsChild: 0, guestsInfant: 0 },
  ];
  it('宿泊：全ケース一致', () => {
    for (const c of stayCases) {
      expect(calculateStayPrice(stayPlan, c)).toBe(NisshoPricing.calculateStayPrice(stayPlan, c));
    }
  });

  const tennisPlan = {
    residentPrice: 630, nonResidentPrice: 760, weekdayDiscount: true,
    weekdayDiscountResident: 320, weekdayDiscountNonResident: 380, lightingPrice: 630,
  };
  // 平日割判定コールバックは両実装に同一を渡す（曜日ロジックはコア外・別途検証）。
  const discountEven = (h: string) => Number(h) % 200 === 0; // 任意の決定的関数
  it('テニス：市民/市外 × 照明 × コート数 × 割引パターン 全一致', () => {
    for (const isResident of [true, false]) {
      for (const useLighting of [true, false]) {
        for (const courtCount of [1, 3, 5]) {
          for (const cb of [() => true, () => false, discountEven]) {
            const opts = { hours: ['0900', '0930', '1000', '1800'], isResident, useLighting, courtCount, isWeekdayDiscountHour: cb };
            expect(calculateHourlyTennisPrice(tennisPlan, opts)).toBe(NisshoPricing.calculateHourlyTennisPrice(tennisPlan, opts));
          }
        }
      }
    }
  });
  it('テニス：割引固定値未設定のフォールバックも一致', () => {
    const plan = { residentPrice: 630, nonResidentPrice: 760, weekdayDiscount: true };
    const opts = { hours: ['0900', '1000'], isResident: true, useLighting: false, courtCount: 2, isWeekdayDiscountHour: () => true };
    expect(calculateHourlyTennisPrice(plan, opts)).toBe(NisshoPricing.calculateHourlyTennisPrice(plan, opts));
  });

  it('キャンプ：区画×泊 全一致', () => {
    const camp = { basePrice: 790 };
    for (const siteCount of [0, 1, 2, 3]) {
      for (const nights of [1, 2, 3]) {
        expect(calculateCampPrice(camp, { siteCount, nights })).toBe(NisshoPricing.calculateCampPrice(camp, { siteCount, nights }));
      }
    }
  });
});

// ─────────────────────────────────────────────
// d. 網羅ガード（将来のプラン追加漏れ検出）
// ─────────────────────────────────────────────
describe('網羅ガード：RESERVATION_PLAN_RULES の全 planId に計算経路がある', () => {
  it('全 planId が SERVER_PLAN_PRICING に存在する', () => {
    const missing = Object.keys(RESERVATION_PLAN_RULES).filter(id => SERVER_PLAN_PRICING[id] === undefined);
    expect(missing).toEqual([]);
  });
  it('SERVER_PLAN_PRICING に RULES 外の余剰 planId が無い', () => {
    const extra = Object.keys(SERVER_PLAN_PRICING).filter(id => (RESERVATION_PLAN_RULES as any)[id] === undefined);
    expect(extra).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// f. 平日割・祝日（サーバ自律判定）
// ─────────────────────────────────────────────
describe('平日割・祝日 サーバ自律判定', () => {
  it('祝日テーブル', () => {
    expect(isJapaneseHoliday('2026-05-05')).toBe(true);   // こどもの日
    expect(isJapaneseHoliday('2026-07-20')).toBe(true);   // 海の日
    expect(isJapaneseHoliday('2026-05-13')).toBe(false);  // 平日
    expect(isJapaneseHoliday('')).toBe(false);
  });
  it('平日(水)の枠内は割引・枠外/週末/祝日は非割引', () => {
    // 2026-05-13(水) 非祝日
    expect(isTennisWeekdayDiscountSlot('2026-05-13', '0900')).toBe(true);  // 09:00-10:00 ⊂ 8:30-17:00
    expect(isTennisWeekdayDiscountSlot('2026-05-13', '0800')).toBe(false); // 08:00 開始は枠外
    expect(isTennisWeekdayDiscountSlot('2026-05-13', '1630')).toBe(false); // 16:30-17:30 は 17:00 超過
    expect(isTennisWeekdayDiscountSlot('2026-05-13', '1600')).toBe(true);  // 16:00-17:00 ⊂ 枠
    // 週末・祝日
    expect(isTennisWeekdayDiscountSlot('2026-05-16', '0900')).toBe(false); // 土
    expect(isTennisWeekdayDiscountSlot('2026-05-05', '0900')).toBe(false); // 火・祝日
  });
});

describe('tennisHourKeysFromSlots：30分ペアから1時間課金枠を復元', () => {
  it('1コート1時間', () => {
    expect(tennisHourKeysFromSlots(['court_1|2026-05-13|0900', 'court_1|2026-05-13|0930'], ['court_1'])).toEqual(['0900']);
  });
  it('複数コートは先頭コートの枠だけ（コート間は canonical で同一保証）', () => {
    const slots = ['court_1|2026-05-13|0900', 'court_1|2026-05-13|0930', 'court_2|2026-05-13|0900', 'court_2|2026-05-13|0930'];
    expect(tennisHourKeysFromSlots(slots, ['court_1', 'court_2'])).toEqual(['0900']);
  });
  it('非連続2時間', () => {
    const slots = ['court_1|2026-05-13|0900', 'court_1|2026-05-13|0930', 'court_1|2026-05-13|1030', 'court_1|2026-05-13|1100'];
    expect(tennisHourKeysFromSlots(slots, ['court_1'])).toEqual(['0900', '1030']);
  });
});

// ─────────────────────────────────────────────
// e. computeServerPricing（プラン別・オーケストレーター）
// ─────────────────────────────────────────────
function canonical(over: Partial<CanonicalReservation>): CanonicalReservation {
  return {
    planId: 'day_27_am', kind: 'fixed_day', roomIds: ['room_27'],
    slots: ['room_27|2026-05-13|8'], startDate: '2026-05-13', endDate: '2026-05-13',
    nights: 0, serviceDates: ['2026-05-13'], ...over,
  };
}

describe('computeServerPricing：宿泊', () => {
  it('stay_6 複数室は室数倍率', () => {
    const c = canonical({ planId: 'stay_6', kind: 'overnight', roomIds: ['room_6_1', 'room_6_2'], nights: 1 });
    const { pricing } = computeServerPricing(c, { guests: { adult: 6, elementary: 0, child: 0 }, isResident: true });
    expect(pricing.total).toBe(14100); // (2310*2 + 1580*6)*1
  });
  it('stay_all は6室占有でも室数倍率にしない（束価格）', () => {
    const c = canonical({ planId: 'stay_all', kind: 'overnight', roomIds: ['room_6_1', 'room_6_2', 'room_6_3', 'room_6_4', 'room_27', 'room_exp'], nights: 1 });
    const { pricing } = computeServerPricing(c, { guests: { adult: 0, elementary: 0, child: 0 } });
    expect(pricing.total).toBe(28100);
  });
  it('guests マッピング（elementary=小学生, child=未就学児）', () => {
    const c = canonical({ planId: 'stay_27', kind: 'overnight', roomIds: ['room_27'], nights: 1 });
    const { pricing } = computeServerPricing(c, { guests: { adult: 0, elementary: 2, child: 1 } });
    expect(pricing.total).toBe(9430 + 1050 * 2 + 790 * 1);
  });
});

describe('computeServerPricing：固定/キャンプ/ロッジ', () => {
  it('固定料金プラン', () => {
    expect(computeServerPricing(canonical({ planId: 'day_27_am' }), {}).pricing.total).toBe(1790);
    expect(computeServerPricing(canonical({ planId: 'day_train_all' }), {}).pricing.total).toBe(8910);
  });
  it('キャンプは区画×泊', () => {
    const c = canonical({ planId: 'camp_stay', kind: 'overnight', roomIds: ['camp_1', 'camp_2'], nights: 3 });
    expect(computeServerPricing(c, {}).pricing.total).toBe(790 * 2 * 3);
  });
  it('ロッジ日帰りは選択時間数×単価', () => {
    const c = canonical({ planId: 'lodge_day', kind: 'hourly_day', roomIds: ['lodge_a'], slots: ['lodge_a|2026-05-13|10', 'lodge_a|2026-05-13|11', 'lodge_a|2026-05-13|12'] });
    expect(computeServerPricing(c, {}).pricing.total).toBe(330 * 3);
  });
  it('ロッジ宿泊：申告 total からシーツ枚数を復元（正当価格集合へスナップ）', () => {
    const c = canonical({ planId: 'lodge_stay', kind: 'overnight', roomIds: ['lodge_a'], nights: 2 });
    const base = 4720 * 2;
    // シーツ2枚を含む正当 total → 復元して一致（mismatch なし）
    const r1 = computeServerPricing(c, { declaredPricing: { total: base + 340 * 2 } });
    expect(r1.pricing.total).toBe(base + 680);
    expect(r1.pricing.optionFee).toBe(680);
    expect(r1.mismatch).toBeNull();
    // 改ざん total:1 → シーツ0にスナップ＝base、mismatch 記録
    const r2 = computeServerPricing(c, { declaredPricing: { total: 1 } });
    expect(r2.pricing.total).toBe(base);
    expect(r2.mismatch).toEqual({ claimedTotal: 1, computedTotal: base });
    // 上限超え申告はシーツ上限(10)でクランプ
    const r3 = computeServerPricing(c, { declaredPricing: { total: base + 340 * 999 } });
    expect(r3.pricing.total).toBe(base + 340 * 10);
  });
});

describe('computeServerPricing：テニス（平日割サーバ判定）', () => {
  const tennisC = (over: Partial<CanonicalReservation> = {}) => canonical({
    planId: 'tennis_full', kind: 'tennis', roomIds: ['court_1'],
    slots: ['court_1|2026-05-13|0900', 'court_1|2026-05-13|0930'],
    startDate: '2026-05-13', endDate: '2026-05-13', ...over,
  });
  it('市民・平日枠内は割引（320）', () => {
    const { pricing } = computeServerPricing(tennisC(), { isResident: true });
    expect(pricing.total).toBe(320);
    expect(pricing.tennis).toMatchObject({ courtType: 'full', isResident: true, totalHours: 1, weekdayDiscountHours: 1, useLighting: false, lightingFee: 0 });
  });
  it('週末は非割引（市民630）', () => {
    const { pricing } = computeServerPricing(tennisC({ slots: ['court_1|2026-05-16|0900', 'court_1|2026-05-16|0930'], startDate: '2026-05-16', endDate: '2026-05-16', serviceDates: ['2026-05-16'] }), { isResident: true });
    expect(pricing.total).toBe(630);
    expect(pricing.tennis!.weekdayDiscountHours).toBe(0);
  });
  it('クライアントが weekdayDiscountHours を詐称してもサーバが日付で上書き', () => {
    // 土曜なのに割引枠数を偽装 → サーバは0に是正
    const { pricing } = computeServerPricing(
      tennisC({ slots: ['court_1|2026-05-16|0900', 'court_1|2026-05-16|0930'], startDate: '2026-05-16', endDate: '2026-05-16', serviceDates: ['2026-05-16'] }),
      { isResident: true, declaredPricing: { total: 320, tennis: { weekdayDiscountHours: 1, useLighting: false } } },
    );
    expect(pricing.total).toBe(630);
    expect(pricing.tennis!.weekdayDiscountHours).toBe(0);
  });
  it('複数コート＋照明（照明はコート倍率・lightingFee は1面分）', () => {
    // 2コート・1時間・非割引(週末)・照明ON、市外
    const c = tennisC({
      roomIds: ['court_1', 'court_2'],
      slots: ['court_1|2026-05-16|1800', 'court_1|2026-05-16|1830', 'court_2|2026-05-16|1800', 'court_2|2026-05-16|1830'],
      startDate: '2026-05-16', endDate: '2026-05-16', serviceDates: ['2026-05-16'],
    });
    const { pricing } = computeServerPricing(c, { isResident: false, declaredPricing: { tennis: { useLighting: true } } });
    // (760 + 630照明) × 2コート = 2780
    expect(pricing.total).toBe(2780);
    expect(pricing.tennis!.lightingFee).toBe(630); // 1面1時間分（コート倍率なし）
    expect(pricing.tennis!.useLighting).toBe(true);
  });
  it('sportGuestEstimate は範囲内透過・範囲外は0', () => {
    expect(computeServerPricing(tennisC(), { declaredPricing: { sportGuestEstimate: 8 } }).pricing.sportGuestEstimate).toBe(8);
    expect(computeServerPricing(tennisC(), { declaredPricing: { sportGuestEstimate: 99 } }).pricing.sportGuestEstimate).toBe(0); // tennis max 10 超過
    expect(computeServerPricing(tennisC(), { declaredPricing: { sportGuestEstimate: -1 } }).pricing.sportGuestEstimate).toBe(0);
    expect(computeServerPricing(tennisC(), {}).pricing.sportGuestEstimate).toBeNull();
  });
});

describe('computeServerPricing：みどり（学生区分の復元）', () => {
  const midoriC = (planId: string, date = '2026-05-13') => canonical({
    planId, kind: 'fixed_day', roomIds: ['midori'],
    slots: [`midori|${date}|8`], startDate: date, endDate: date, serviceDates: [date],
  });
  it('市民一般 / 市外一般（申告なし＝一般既定）', () => {
    expect(computeServerPricing(midoriC('midori_am'), { isResident: true }).pricing.total).toBe(1890);
    expect(computeServerPricing(midoriC('midori_am'), { isResident: false }).pricing.total).toBe(2200);
  });
  it('学生：申告 total が学生価格に一致すれば学生として復元（mismatch なし）', () => {
    const r = computeServerPricing(midoriC('midori_am'), { isResident: true, declaredPricing: { total: 1050 } });
    expect(r.pricing.total).toBe(1050); // 学生市民
    expect(r.mismatch).toBeNull();
  });
  it('改ざん total:1 は一般価格へ収束し mismatch 記録', () => {
    const r = computeServerPricing(midoriC('midori_am'), { isResident: false, declaredPricing: { total: 1 } });
    expect(r.pricing.total).toBe(2200);
    expect(r.mismatch).toEqual({ claimedTotal: 1, computedTotal: 2200 });
  });
  it('夜間は照明時間数（0-5）をサーバ計算して加算', () => {
    const r = computeServerPricing(midoriC('midori_eve'), { isResident: true, declaredPricing: { total: 2730 + 1890 * 3, midori: { lightingHours: 3 } } });
    expect(r.pricing.total).toBe(2730 + 5670);
    expect(r.pricing.midori).toEqual({ slot: 'eve', lightingHours: 3, lightingFee: 5670 });
    expect(r.mismatch).toBeNull();
  });
  it('照明時間数の詐称(99h)は上限5にクランプ', () => {
    const r = computeServerPricing(midoriC('midori_eve'), { isResident: true, declaredPricing: { midori: { lightingHours: 99 } } });
    expect(r.pricing.midori!.lightingHours).toBe(5);
    expect(r.pricing.total).toBe(2730 + 1890 * 5);
  });
});

describe('computeServerPricing：サウナ（オプション）', () => {
  it('通常サウナ = 13200 + オプション', () => {
    const c = canonical({ planId: 'sauna_1', kind: 'fixed_day', roomIds: ['sauna'], slots: ['sauna|2026-05-13|10', 'sauna|2026-05-13|11'] });
    const r = computeServerPricing(c, { declaredPricing: { saunaOptions: { towels: 2, tarpTent: 1, ice20kg: 1 } } });
    expect(r.pricing.total).toBe(13200 + 550 * 2 + 1100 + 4400);
    expect(r.pricing.saunaOptions).toEqual({ towels: 2, tarpTent: 1, ice20kg: 1 });
    expect(r.pricing.optionFee).toBe(550 * 2 + 1100 + 4400);
  });
  it('ふたみの日サウナ = 2300 × 人数 + オプション', () => {
    const c = canonical({ planId: 'plan_sauna_futami', kind: 'futami_sauna', roomIds: ['sauna_share'], slots: ['sauna_share|2026-05-13|10', 'sauna_share|2026-05-13|11'] });
    const r = computeServerPricing(c, { guestCount: 4, declaredPricing: { saunaOptions: { towels: 3 } } });
    expect(r.pricing.total).toBe(2300 * 4 + 550 * 3);
  });
  it('ふたみの日サウナ：guestCount 省略時は handler と同じく guests.adult にフォールバック', () => {
    const c = canonical({ planId: 'plan_sauna_futami', kind: 'futami_sauna', roomIds: ['sauna_share'], slots: ['sauna_share|2026-05-13|10', 'sauna_share|2026-05-13|11'] });
    const r = computeServerPricing(c, { guests: { adult: 3 } });
    expect(r.pricing.total).toBe(2300 * 3);
  });
  it('サウナオプション数量の詐称は上限クランプ', () => {
    const c = canonical({ planId: 'sauna_1', kind: 'fixed_day', roomIds: ['sauna'], slots: ['sauna|2026-05-13|10', 'sauna|2026-05-13|11'] });
    const r = computeServerPricing(c, { declaredPricing: { saunaOptions: { towels: 999, tarpTent: 999, ice20kg: 999 } } });
    expect(r.pricing.saunaOptions).toEqual({ towels: 8, tarpTent: 1, ice20kg: 5 });
  });
});

describe('computeServerPricing：mismatch セマンティクス', () => {
  const c = canonical({ planId: 'day_27_am' });
  it('pricing 省略 → mismatch なし・サーバ計算値保存', () => {
    const r = computeServerPricing(c, {});
    expect(r.pricing.total).toBe(1790);
    expect(r.mismatch).toBeNull();
  });
  it('正しい total → 一致・mismatch なし', () => {
    const r = computeServerPricing(c, { declaredPricing: { total: 1790 } });
    expect(r.mismatch).toBeNull();
  });
  it('total:1 改ざん → サーバ値保存＋mismatch', () => {
    const r = computeServerPricing(c, { declaredPricing: { total: 1 } });
    expect(r.pricing.total).toBe(1790);
    expect(r.mismatch).toEqual({ claimedTotal: 1, computedTotal: 1790 });
  });
  it('巨額 total 改ざん → サーバ値保存＋mismatch', () => {
    const r = computeServerPricing(c, { declaredPricing: { total: 9_999_999 } });
    expect(r.pricing.total).toBe(1790);
    expect(r.mismatch!.computedTotal).toBe(1790);
  });
});
