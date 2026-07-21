// テニス半面（壁打ちコート）復活の単体テスト（2026-07-22）
//
// 仕様の根拠:
// - 半面＝壁打ち練習用の独立施設 court_wall（コートA〜Eとは別）。2026-07-21 上村さん回答①
// - 課金単位＝半面1枠(1時間)の定額 240/280円。2026-07-21 上村さん回答「実際には半面=240円で運用」
// - 同時間の半面は1組まで（2026-07-21 回答②「一面しか無いため、1組まで で問題なし」）
// - 平日割 120/140・照明 630円 は料金表【R8】固定値

import * as fs from 'fs';
import * as path from 'path';
import { SERVER_PLAN_PRICING, computeServerPricing } from '../src/lib/pricingServer';
import { RESERVATION_PLAN_RULES, canonicalizeReservation, CanonicalReservation } from '../src/lib/reservationPlans';
import { planLabel, roomLabel, formatTennisTimeRanges } from '../src/lib/labels';
import { VALID_ROOM_IDS } from '../src/constants';

const NisshoPricing = require('../../assets/js/pricing.js');

const ROOT = path.resolve(__dirname, '../..');
const pricingJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'pricing.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const WEEKDAY = '2026-07-01';  // 水曜・祝日ではない
const SATURDAY = '2026-07-04'; // 土曜（平日割なし）

function halfBody(over: any = {}) {
  return {
    planId: 'tennis_half',
    roomIds: ['court_wall'],
    slots: [`court_wall|${WEEKDAY}|1800`, `court_wall|${WEEKDAY}|1830`],
    startDate: WEEKDAY,
    endDate: WEEKDAY,
    nights: 0,
    ...over,
  };
}

describe('tennis_half: 料金定義が料金表SSOT (docs/pricing.json) と一致', () => {
  it('SERVER_PLAN_PRICING.tennis_half が pricing.json tennis.half と一致する', () => {
    const t = SERVER_PLAN_PRICING.tennis_half as any;
    expect(t).toBeDefined();
    expect(t.residentPrice).toBe(pricingJson.tennis.half.resident);           // 240
    expect(t.nonResidentPrice).toBe(pricingJson.tennis.half.nonResident);     // 280
    expect(t.weekdayDiscountResident).toBe(pricingJson.tennis.half.weekdayDiscount.resident);       // 120
    expect(t.weekdayDiscountNonResident).toBe(pricingJson.tennis.half.weekdayDiscount.nonResident); // 140
    expect(t.lightingPrice).toBe(pricingJson.tennis.lighting.price);          // 630
  });

  it('プランルールは court_wall 専用・最大1室（A〜Eの流用を構造的に禁止）', () => {
    const rule = RESERVATION_PLAN_RULES.tennis_half;
    expect(rule).toBeDefined();
    expect([...rule.rooms]).toEqual(['court_wall']);
    expect(rule.maxRooms).toBe(1);
    expect(rule.kind).toBe('tennis');
    expect(VALID_ROOM_IDS.has('court_wall')).toBe(true);
  });

  it('フロント index.html の tennis_half 定義とサーバ定義が一致（3者一致）', () => {
    const block = indexHtml.slice(indexHtml.indexOf("id: 'tennis_half'"), indexHtml.indexOf("id: 'tennis_half'") + 1400);
    const num = (name: string) => {
      const m = block.match(new RegExp(`${name}:\\s*(\\d+)`));
      return m ? parseInt(m[1], 10) : null;
    };
    expect(num('residentPrice')).toBe(240);
    expect(num('nonResidentPrice')).toBe(280);
    expect(num('weekdayDiscountResident')).toBe(120);
    expect(num('weekdayDiscountNonResident')).toBe(140);
    expect(num('lightingPrice')).toBe(630);
    expect(block).toContain("rooms: ['court_wall']");
    // 定額の生命線: 人数課金へ逆行していない
    expect(block).not.toContain('perPerson');
    expect(block).not.toContain('1人');
  });
});

describe('tennis_half: canonicalizeReservation（在庫の入口）', () => {
  it('court_wall の正規予約を受理し canonical slots を返す', () => {
    const r = canonicalizeReservation(halfBody());
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: CanonicalReservation }).value;
    expect(v.planId).toBe('tennis_half');
    expect(v.kind).toBe('tennis');
    expect(v.slots).toEqual([`court_wall|${WEEKDAY}|1800`, `court_wall|${WEEKDAY}|1830`]);
  });

  it('コートA〜Eへ直送すると plan_room_mismatch で拒否（誤案内・在庫毀損の防止）', () => {
    for (const court of ['court_1', 'court_2', 'court_3', 'court_4', 'court_5']) {
      const r = canonicalizeReservation(halfBody({
        roomIds: [court],
        slots: [`${court}|${WEEKDAY}|1800`, `${court}|${WEEKDAY}|1830`],
      }));
      expect(r.ok).toBe(false);
      expect((r as any).error).toBe('plan_room_mismatch');
    }
  });

  it('複数室（court_wall + court_1）は拒否（半面は1つしかない）', () => {
    const r = canonicalizeReservation(halfBody({
      roomIds: ['court_wall', 'court_1'],
      slots: [
        `court_wall|${WEEKDAY}|1800`, `court_wall|${WEEKDAY}|1830`,
        `court_1|${WEEKDAY}|1800`, `court_1|${WEEKDAY}|1830`,
      ],
    }));
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('plan_room_mismatch');
  });

  it('30分ペアが揃わない slots は plan_slot_mismatch', () => {
    const r = canonicalizeReservation(halfBody({
      slots: [`court_wall|${WEEKDAY}|1800`],
    }));
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('plan_slot_mismatch');
  });
});

describe('tennis_half: サーバ権威料金（1枠定額・人数非依存）', () => {
  const canonicalOf = (body: any): CanonicalReservation => {
    const r = canonicalizeReservation(body);
    expect(r.ok).toBe(true);
    return (r as { ok: true; value: CanonicalReservation }).value;
  };

  it('通常枠1時間: 市民240円 / 市外280円（申告人数がいくらでも変わらない定額）', () => {
    const canonical = canonicalOf(halfBody());
    const resident = computeServerPricing(canonical, { isResident: true, declaredPricing: null });
    const outside = computeServerPricing(canonical, { isResident: false, declaredPricing: null });
    expect(resident.pricing.total).toBe(240);
    expect(outside.pricing.total).toBe(280);
    // 人数フィールドを混ぜても total に影響しない（空間貸し）
    const withGuests = computeServerPricing(canonical, {
      isResident: true, declaredPricing: { total: 960 }, guests: { adult: 4 },
    });
    expect(withGuests.pricing.total).toBe(240);
  });

  it('平日 8:30-17:00 枠は平日割 120/140、土曜は割引なし', () => {
    const weekday = canonicalOf(halfBody({
      slots: [`court_wall|${WEEKDAY}|0900`, `court_wall|${WEEKDAY}|0930`],
    }));
    expect(computeServerPricing(weekday, { isResident: true, declaredPricing: null }).pricing.total).toBe(120);
    expect(computeServerPricing(weekday, { isResident: false, declaredPricing: null }).pricing.total).toBe(140);

    const saturday = canonicalOf(halfBody({
      slots: [`court_wall|${SATURDAY}|0900`, `court_wall|${SATURDAY}|0930`],
      startDate: SATURDAY, endDate: SATURDAY,
    }));
    expect(computeServerPricing(saturday, { isResident: true, declaredPricing: null }).pricing.total).toBe(240);
  });

  it('照明あり2時間: (240×2) + (630×2) = 1740、courtType=half が記録される', () => {
    const canonical = canonicalOf(halfBody({
      slots: [
        `court_wall|${WEEKDAY}|1800`, `court_wall|${WEEKDAY}|1830`,
        `court_wall|${WEEKDAY}|1900`, `court_wall|${WEEKDAY}|1930`,
      ],
    }));
    const r = computeServerPricing(canonical, {
      isResident: true,
      declaredPricing: { total: 1740, tennis: { useLighting: true } },
    });
    expect(r.pricing.total).toBe(1740);
    expect(r.pricing.tennis).not.toBeNull();
    expect(r.pricing.tennis!.courtType).toBe('half');
    expect(r.pricing.tennis!.lightingFee).toBe(1260);
  });

  it('フロント pricing.js と同一結果（パリティ）', () => {
    const plan = {
      residentPrice: 240, nonResidentPrice: 280, weekdayDiscount: true,
      weekdayDiscountResident: 120, weekdayDiscountNonResident: 140, lightingPrice: 630,
    };
    for (const isResident of [true, false]) {
      for (const useLighting of [true, false]) {
        for (const discounted of [true, false]) {
          const opts = {
            hours: ['1000', '1100'], isResident, useLighting, courtCount: 1,
            isWeekdayDiscountHour: () => discounted,
          };
          expect(NisshoPricing.calculateHourlyTennisPrice(plan, opts))
            .toBe(require('../src/lib/pricingServer').calculateHourlyTennisPrice(plan, opts));
        }
      }
    }
  });
});

describe('labels: 顧客向けメールの表示名（生ID漏れ防止）', () => {
  it('tennis_half / court_wall が日本語ラベルに解決される', () => {
    expect(planLabel('tennis_half')).toBe('半面コート（壁打ち練習用）');
    expect(roomLabel('court_wall')).toBe('半面コート（壁打ち練習用）');
    expect(planLabel('tennis_full')).toBe('テニスコート（一面貸切）');
    expect(roomLabel('court_1')).toBe('テニスコートA');
  });

  it('未知IDは生IDへフォールバック（メールを止めない）', () => {
    expect(planLabel('mystery_plan')).toBe('mystery_plan');
    expect(roomLabel(undefined)).toBe('');
  });

  it('formatTennisTimeRanges: 連続30分ペアを帯へ結合し、飛び枠は区切る', () => {
    const d = WEEKDAY;
    expect(formatTennisTimeRanges([
      `court_wall|${d}|0800`, `court_wall|${d}|0830`,
      `court_wall|${d}|0900`, `court_wall|${d}|0930`,
    ])).toBe('08:00〜10:00');
    expect(formatTennisTimeRanges([
      `court_wall|${d}|0800`, `court_wall|${d}|0830`,
      `court_wall|${d}|1300`, `court_wall|${d}|1330`,
    ])).toBe('08:00〜09:00、13:00〜14:00');
    // 30分開始の1時間枠（08:30〜09:30）
    expect(formatTennisTimeRanges([
      `court_wall|${d}|0830`, `court_wall|${d}|0900`,
    ])).toBe('08:30〜09:30');
  });

  it('formatTennisTimeRanges: 不正入力は黙って無視', () => {
    expect(formatTennisTimeRanges(null)).toBe('');
    expect(formatTennisTimeRanges(['garbage', 'court_wall|x|9999', 42 as any])).toBe('');
  });
});
