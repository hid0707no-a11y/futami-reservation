import {
  BusinessCalendar,
  businessCalendarFromData,
  findClosedDayInServiceDates,
  findClosedFacilitySlot,
  isClosedDay,
  isFacilitySlotClosed,
} from '../src/lib/businessDays';

describe('businessDays', () => {
  const cal = {
    defaultClosedDays: [2],
    forceOpen: ['2026-08-04'],
    forceClosed: ['2026-08-05'],
    facilityClosed: [],
  };

  it('forceClosedを最優先しforceOpenで定休日を営業日にする', () => {
    expect(isClosedDay('2026-08-05', cal)).toBe(true);
    expect(isClosedDay('2026-08-04', cal)).toBe(false);
    expect(isClosedDay('2026-08-11', cal)).toBe(true);
  });

  it('中間宿泊日の定休日を検出しcheckout日は検査対象外にできる', () => {
    expect(findClosedDayInServiceDates(['2026-08-03','2026-08-04','2026-08-05'], {
      defaultClosedDays: [2], forceOpen: [], forceClosed: [], facilityClosed: [],
    })).toBe('2026-08-04');
    expect(findClosedDayInServiceDates(['2026-08-03'], {
      defaultClosedDays: [2], forceOpen: [], forceClosed: [], facilityClosed: [],
    })).toBeNull();
  });

  it('欠落設定は安全な既定値へ正規化する', () => {
    expect(businessCalendarFromData(null)).toEqual({
      defaultClosedDays: [2], forceOpen: [], forceClosed: [], facilityClosed: [],
    });
  });

  it('壊れた曜日設定は火曜へ戻し、存在しない日付は除外する', () => {
    expect(businessCalendarFromData({
      defaultClosedDays: [2, 1.5],
      forceOpen: ['2026-02-30', '2026-08-04'],
      forceClosed: ['not-a-date', '2026-08-05'],
    })).toEqual({
      defaultClosedDays: [2],
      forceOpen: ['2026-08-04'],
      forceClosed: ['2026-08-05'],
      facilityClosed: [],
    });
  });

  it('曜日設定の重複は除去し、空配列は「定休なし」として保持する', () => {
    expect(businessCalendarFromData({ defaultClosedDays: [2, 2, 6] }).defaultClosedDays)
      .toEqual([2, 6]);
    expect(businessCalendarFromData({ defaultClosedDays: [] }).defaultClosedDays)
      .toEqual([]);
  });
});

// ─────────────────────────────────────────────
// facilityClosed（施設単位の停止・2026-08-02 追加）
// ─────────────────────────────────────────────
//
// 運営要望「サウナだけをその日は予約不可にしたい」。
// 従来はダミー予約で塞いでいたため、運営宛メールの大量送信と行政報告用スプシへの
// 架空売上計上という副作用が出ていた。facilityClosed は在庫を1件も作らずに止める。

/** サウナ A〜D の時（index.html PLANS / reservationPlans.ts の SSOT と一致させる） */
const SAUNA_PLAN_HOURS: Record<string, number[]> = {
  'A 10:00-12:00': [10, 11],
  'B 12:30-14:30': [12, 13, 14],
  'C 15:00-17:00': [15, 16],
  'D 17:30-19:30': [17, 18, 19],
};
const SAUNA_ALL_HOURS = Object.values(SAUNA_PLAN_HOURS).flat();

const DATE = '2026-09-20';
const OTHER_DATE = '2026-09-21';

/** facilityClosed だけを差し替えたカレンダー（他項目は「休みでない」中立値） */
function calWith(facilityClosed: string[]): BusinessCalendar {
  return { defaultClosedDays: [], forceOpen: [], forceClosed: [], facilityClosed };
}

/** プランのスロットキー群（"roomId|date|hour"） */
function planSlots(roomId: string, date: string, hours: number[]): string[] {
  return hours.map(h => `${roomId}|${date}|${h}`);
}

describe('isFacilitySlotClosed / findClosedFacilitySlot — 終日キー', () => {
  const cal = calWith([`sauna|${DATE}`]);

  it.each(Object.entries(SAUNA_PLAN_HOURS))(
    '終日キー "sauna|%s" がサウナ%sの全時間を止める', (_planName, hours) => {
      for (const h of hours as number[]) {
        expect(isFacilitySlotClosed('sauna', DATE, String(h), cal)).toBe(true);
      }
      // プラン単位（createReservation が渡す形）でも当たる
      expect(findClosedFacilitySlot(planSlots('sauna', DATE, hours as number[]), cal))
        .toBe(`sauna|${DATE}|${(hours as number[])[0]}`);
    });

  it('A〜D 全時間（10〜19時）が例外なく止まる', () => {
    for (const h of SAUNA_ALL_HOURS) {
      expect(isFacilitySlotClosed('sauna', DATE, h, cal)).toBe(true);
    }
  });

  it('翌日は止まらない（日付をまたいで漏れない）', () => {
    expect(isFacilitySlotClosed('sauna', OTHER_DATE, '10', cal)).toBe(false);
    expect(findClosedFacilitySlot(planSlots('sauna', OTHER_DATE, [10, 11]), cal)).toBeNull();
  });

  it('hour を渡さない問い合わせでも終日停止なら true', () => {
    expect(isFacilitySlotClosed('sauna', DATE, null, cal)).toBe(true);
    expect(isFacilitySlotClosed('sauna', DATE, undefined, cal)).toBe(true);
  });

  it('2要素キー "roomId|date"（dryRun の probe 用）も終日停止に当たる', () => {
    expect(findClosedFacilitySlot([`sauna|${DATE}`], cal)).toBe(`sauna|${DATE}`);
  });
});

describe('isFacilitySlotClosed / findClosedFacilitySlot — 時間キー', () => {
  const cal = calWith([`sauna|${DATE}|10`]);

  it('10時だけ止まり、12時は止まらない', () => {
    expect(isFacilitySlotClosed('sauna', DATE, '10', cal)).toBe(true);
    expect(isFacilitySlotClosed('sauna', DATE, '12', cal)).toBe(false);
    expect(isFacilitySlotClosed('sauna', DATE, '11', cal)).toBe(false);
  });

  it('A枠(10,11)は予約できず、B枠(12,13,14)は予約できる', () => {
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, SAUNA_PLAN_HOURS['A 10:00-12:00']), cal))
      .toBe(`sauna|${DATE}|10`);
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, SAUNA_PLAN_HOURS['B 12:30-14:30']), cal))
      .toBeNull();
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, SAUNA_PLAN_HOURS['C 15:00-17:00']), cal))
      .toBeNull();
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, SAUNA_PLAN_HOURS['D 17:30-19:30']), cal))
      .toBeNull();
  });

  it('B枠だけ止める指定は B だけを落とす（12/13/14 の3本指定）', () => {
    const bCal = calWith([`sauna|${DATE}|12`, `sauna|${DATE}|13`, `sauna|${DATE}|14`]);
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, [12, 13, 14]), bCal)).toBe(`sauna|${DATE}|12`);
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, [10, 11]), bCal)).toBeNull();
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, [15, 16]), bCal)).toBeNull();
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, [17, 18, 19]), bCal)).toBeNull();
  });

  it('hour を渡さない問い合わせは時間指定の停止には当たらない', () => {
    expect(isFacilitySlotClosed('sauna', DATE, null, cal)).toBe(false);
    expect(isFacilitySlotClosed('sauna', DATE, undefined, cal)).toBe(false);
    expect(findClosedFacilitySlot([`sauna|${DATE}`], cal)).toBeNull();
  });

  it('境界の 0時 / 23時 も指定できる', () => {
    const edge = calWith([`room_27|${DATE}|0`, `room_27|${DATE}|23`]);
    expect(isFacilitySlotClosed('room_27', DATE, '0', edge)).toBe(true);
    expect(isFacilitySlotClosed('room_27', DATE, 0, edge)).toBe(true);
    expect(isFacilitySlotClosed('room_27', DATE, '23', edge)).toBe(true);
    expect(isFacilitySlotClosed('room_27', DATE, '1', edge)).toBe(false);
  });
});

describe('サウナ連動（sauna ⇄ sauna_share）', () => {
  // 同じ物理サウナを、通常日は sauna・ふたみの日は sauna_share の2 roomId で運用している。
  // 片方への停止指定がもう片方に効かないと「サウナを止めたのにふたみの日から予約できる」穴になる。

  it('sauna の終日停止が sauna_share にも効く', () => {
    const cal = calWith([`sauna|${DATE}`]);
    expect(isFacilitySlotClosed('sauna_share', DATE, '10', cal)).toBe(true);
    expect(findClosedFacilitySlot(planSlots('sauna_share', DATE, [10, 11]), cal))
      .toBe(`sauna_share|${DATE}|10`);
  });

  it('sauna_share の終日停止が sauna にも効く', () => {
    const cal = calWith([`sauna_share|${DATE}`]);
    expect(isFacilitySlotClosed('sauna', DATE, '17', cal)).toBe(true);
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, [17, 18, 19]), cal))
      .toBe(`sauna|${DATE}|17`);
  });

  it('時間指定も双方向に効く', () => {
    const fromRegular = calWith([`sauna|${DATE}|15`]);
    expect(isFacilitySlotClosed('sauna_share', DATE, '15', fromRegular)).toBe(true);
    expect(isFacilitySlotClosed('sauna_share', DATE, '16', fromRegular)).toBe(false);

    const fromShared = calWith([`sauna_share|${DATE}|15`]);
    expect(isFacilitySlotClosed('sauna', DATE, '15', fromShared)).toBe(true);
    expect(isFacilitySlotClosed('sauna', DATE, '16', fromShared)).toBe(false);
  });

  it('連動はサウナ限定（room_6_1 が room_6_2 に波及しない）', () => {
    const cal = calWith([`room_6_1|${DATE}`]);
    expect(isFacilitySlotClosed('room_6_2', DATE, '10', cal)).toBe(false);
    expect(isFacilitySlotClosed('room_6_1', DATE, '10', cal)).toBe(true);
  });
});

describe('他の施設は巻き込まれない', () => {
  const cal = calWith([`sauna|${DATE}`, `sauna|${DATE}|10`]);

  it.each(['room_27', 'room_6_1', 'room_exp', 'room_train', 'room_kitchen',
           'camp_1', 'lodge_a', 'lodge_b', 'midori', 'court_1', 'court_wall'])(
    'サウナ停止で %s は止まらない', roomId => {
      expect(isFacilitySlotClosed(roomId, DATE, '10', cal)).toBe(false);
      expect(isFacilitySlotClosed(roomId, DATE, null, cal)).toBe(false);
    });

  it('他施設だけのスロット群は findClosedFacilitySlot が null', () => {
    expect(findClosedFacilitySlot([
      `room_27|${DATE}|10`, `camp_1|${DATE}|15`, `lodge_a|${DATE}|16`, `midori|${DATE}|8`,
    ], cal)).toBeNull();
  });

  it('room_27 を止めてもサウナは止まらない（逆方向）', () => {
    const roomCal = calWith([`room_27|${DATE}`]);
    expect(isFacilitySlotClosed('sauna', DATE, '10', roomCal)).toBe(false);
    expect(isFacilitySlotClosed('sauna_share', DATE, '10', roomCal)).toBe(false);
  });

  it('混在スロットでは当たった最初のキーを返す', () => {
    expect(findClosedFacilitySlot([
      `room_27|${DATE}|10`, `camp_1|${DATE}|15`, `sauna|${DATE}|11`, `sauna|${DATE}|12`,
    ], cal)).toBe(`sauna|${DATE}|11`);
  });

  it('連泊スロットは停止日にかかった1本だけが当たる', () => {
    const stayCal = calWith([`lodge_a|${OTHER_DATE}`]);
    const slots = [
      `lodge_a|${DATE}|16`, `lodge_a|${DATE}|17`,
      `lodge_a|${OTHER_DATE}|8`, `lodge_a|${OTHER_DATE}|9`,
    ];
    expect(findClosedFacilitySlot(slots, stayCal)).toBe(`lodge_a|${OTHER_DATE}|8`);
    expect(findClosedFacilitySlot(slots.slice(0, 2), stayCal)).toBeNull();
  });
});

describe('facilityClosed が空／未設定なら導入前と完全に同じ動作（回帰）', () => {
  const empty = calWith([]);

  it('空配列は常に false / null', () => {
    for (const h of SAUNA_ALL_HOURS) {
      expect(isFacilitySlotClosed('sauna', DATE, h, empty)).toBe(false);
    }
    expect(findClosedFacilitySlot(planSlots('sauna', DATE, SAUNA_ALL_HOURS), empty)).toBeNull();
  });

  it('facilityClosed 未設定のカレンダー（旧データ）でも落ちずに false / null', () => {
    const legacy = { defaultClosedDays: [2], forceOpen: [], forceClosed: [] } as any;
    expect(isFacilitySlotClosed('sauna', DATE, '10', legacy)).toBe(false);
    expect(findClosedFacilitySlot([`sauna|${DATE}|10`], legacy)).toBeNull();
  });

  it('businessCalendarFromData が facilityClosed 未設定を空配列にする', () => {
    expect(businessCalendarFromData({}).facilityClosed).toEqual([]);
    expect(businessCalendarFromData(null).facilityClosed).toEqual([]);
    expect(businessCalendarFromData(undefined).facilityClosed).toEqual([]);
  });

  it('日付単位の定休判定は facilityClosed の有無に影響されない', () => {
    const withFacility = {
      defaultClosedDays: [2], forceOpen: [], forceClosed: [],
      facilityClosed: [`sauna|2026-08-04`],
    };
    // 2026-08-04 は火曜（定休日）。サウナ停止を入れても定休判定は変わらない
    expect(isClosedDay('2026-08-04', withFacility)).toBe(true);
    expect(isClosedDay('2026-08-05', withFacility)).toBe(false);
    expect(findClosedDayInServiceDates(['2026-08-05'], withFacility)).toBeNull();
  });

  it('空スロット・非配列でも落ちない', () => {
    const cal = calWith([`sauna|${DATE}`]);
    expect(findClosedFacilitySlot([], cal)).toBeNull();
    expect(findClosedFacilitySlot(null as any, cal)).toBeNull();
    expect(findClosedFacilitySlot(undefined as any, cal)).toBeNull();
  });
});

describe('businessCalendarFromData が不正な facilityClosed 要素を捨てる', () => {
  it('契約外の形式は保存データから除外される', () => {
    const result = businessCalendarFromData({
      facilityClosed: [
        // ── 有効 ──
        `sauna|${DATE}`,
        `sauna|${DATE}|10`,
        `court_wall|${DATE}|0`,
        `room_27|${DATE}|23`,
        // ── 無効 ──
        'sauna',                       // 区切りが足りない
        `sauna|${DATE}|10|extra`,      // 要素が多い
        `sauna|2026-02-30`,            // 存在しない日付
        `sauna|2026-9-20`,             // ゼロ埋めなし日付
        `sauna|20260920`,              // 区切りなし日付
        `sauna|${DATE}|24`,            // hour 範囲外
        `sauna|${DATE}|-1`,            // 負の hour
        `sauna|${DATE}|1.5`,           // 小数 hour
        `sauna|${DATE}|08`,            // ゼロ埋め hour（契約は「ゼロ埋めしない」）
        `sauna|${DATE}|`,              // hour 空
        `nonexistent_room|${DATE}`,    // VALID_ROOM_IDS 外
        `SAUNA|${DATE}`,               // 大文字（roomId は完全一致）
        `|${DATE}`,                    // roomId 空
        '',
        123,
        null,
        undefined,
        { roomId: 'sauna' },
        [`sauna|${DATE}`],
      ],
    });
    expect(result.facilityClosed).toEqual([
      `sauna|${DATE}`,
      `sauna|${DATE}|10`,
      `court_wall|${DATE}|0`,
      `room_27|${DATE}|23`,
    ]);
  });

  it('配列でない facilityClosed は空配列にする', () => {
    expect(businessCalendarFromData({ facilityClosed: 'sauna|2026-09-20' }).facilityClosed).toEqual([]);
    expect(businessCalendarFromData({ facilityClosed: {} }).facilityClosed).toEqual([]);
    expect(businessCalendarFromData({ facilityClosed: null }).facilityClosed).toEqual([]);
    expect(businessCalendarFromData({ facilityClosed: 0 }).facilityClosed).toEqual([]);
  });

  it('捨てられた要素は判定にも効かない（未知roomId / hour 24 は素通り）', () => {
    const cal = businessCalendarFromData({
      facilityClosed: [`nonexistent_room|${DATE}`, `sauna|${DATE}|24`],
    });
    expect(cal.facilityClosed).toEqual([]);
    expect(isFacilitySlotClosed('sauna', DATE, '10', cal)).toBe(false);
    expect(findClosedFacilitySlot([`sauna|${DATE}|10`], cal)).toBeNull();
  });

  it('全12施設グループの roomId が保存できる（プルダウンの全項目）', () => {
    const rooms = [
      'sauna', 'sauna_share',
      'court_1', 'court_2', 'court_3', 'court_4', 'court_5', 'court_wall',
      'midori',
      'room_27', 'room_6_1', 'room_6_2', 'room_6_3', 'room_6_4',
      'room_exp', 'room_train', 'room_kitchen',
      'camp_1', 'camp_2', 'camp_3', 'camp_4', 'camp_5', 'camp_6', 'camp_7', 'camp_8',
      'lodge_a', 'lodge_b',
    ];
    const entries = rooms.map(r => `${r}|${DATE}`);
    expect(businessCalendarFromData({ facilityClosed: entries }).facilityClosed).toEqual(entries);
  });

  it('壊れた要素がカレンダーに直接入っていても例外を投げない', () => {
    const broken = calWith(['', 'sauna', 123 as any, null as any, undefined as any,
                            `sauna|${DATE}|24`, `sauna|${DATE}`]);
    expect(() => isFacilitySlotClosed('sauna', DATE, '10', broken)).not.toThrow();
    expect(isFacilitySlotClosed('sauna', DATE, '10', broken)).toBe(true); // 最後の有効要素は効く
    expect(findClosedFacilitySlot([`sauna|${DATE}|10`], broken)).toBe(`sauna|${DATE}|10`);
  });
});

describe('テニス（HHMM 形式のスロットキー）', () => {
  it('終日キーが HHMM スロットを止める', () => {
    const cal = calWith([`court_1|${DATE}`]);
    expect(findClosedFacilitySlot([`court_1|${DATE}|0800`, `court_1|${DATE}|0830`], cal))
      .toBe(`court_1|${DATE}|0800`);
    expect(isFacilitySlotClosed('court_1', DATE, '0800', cal)).toBe(true);
    expect(isFacilitySlotClosed('court_1', DATE, '2130', cal)).toBe(true);
  });

  it('時間指定は HHMM の先頭2桁を時として突き合わせる', () => {
    const cal = calWith([`court_1|${DATE}|8`]);
    expect(findClosedFacilitySlot([`court_1|${DATE}|0800`], cal)).toBe(`court_1|${DATE}|0800`);
    expect(findClosedFacilitySlot([`court_1|${DATE}|0830`], cal)).toBe(`court_1|${DATE}|0830`);
    expect(findClosedFacilitySlot([`court_1|${DATE}|0900`, `court_1|${DATE}|0930`], cal)).toBeNull();
  });

  it('壁打ちコート（court_wall）も同じ形式で止まる', () => {
    const cal = calWith([`court_wall|${DATE}`]);
    expect(findClosedFacilitySlot([`court_wall|${DATE}|1800`, `court_wall|${DATE}|1830`], cal))
      .toBe(`court_wall|${DATE}|1800`);
    // コートA〜Eは巻き込まれない（独立施設）
    expect(findClosedFacilitySlot([`court_1|${DATE}|1800`], cal)).toBeNull();
  });

  it('旧staff形式（整数時・コロン形式）のキーも時として解釈される', () => {
    const cal = calWith([`court_1|${DATE}|8`]);
    expect(findClosedFacilitySlot([`court_1|${DATE}|8`], cal)).toBe(`court_1|${DATE}|8`);
    expect(findClosedFacilitySlot([`court_1|${DATE}|08`], cal)).toBe(`court_1|${DATE}|08`);
    expect(findClosedFacilitySlot([`court_1|${DATE}|8:30`], cal)).toBe(`court_1|${DATE}|8:30`);
    expect(findClosedFacilitySlot([`court_1|${DATE}|08:30`], cal)).toBe(`court_1|${DATE}|08:30`);
  });

  it('解釈できない時間部分は時間指定の停止に当たらない（終日停止では止まる）', () => {
    const hourCal = calWith([`court_1|${DATE}|8`]);
    expect(findClosedFacilitySlot([`court_1|${DATE}|abcd`], hourCal)).toBeNull();
    const allDayCal = calWith([`court_1|${DATE}`]);
    expect(findClosedFacilitySlot([`court_1|${DATE}|abcd`], allDayCal)).toBe(`court_1|${DATE}|abcd`);
  });
});

describe('件数が多くても判定できる（上限 2000 件 × 長期宿泊スロット）', () => {
  it('2000件の停止指定と1000件のスロットで正しく当たる', () => {
    const entries: string[] = [];
    const base = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 1999; i++) {
      const d = new Date(base.getTime());
      d.setUTCDate(d.getUTCDate() + (i % 300));
      entries.push(`camp_${(i % 8) + 1}|${d.toISOString().slice(0, 10)}|${i % 24}`);
    }
    entries.push(`sauna|${DATE}|17`);
    const cal = calWith(entries);
    expect(cal.facilityClosed.length).toBe(2000);

    const slots: string[] = [];
    for (let i = 0; i < 999; i++) slots.push(`lodge_a|2026-05-01|${i % 24}`);
    slots.push(`sauna|${DATE}|17`);

    expect(findClosedFacilitySlot(slots, cal)).toBe(`sauna|${DATE}|17`);
    expect(findClosedFacilitySlot(slots.slice(0, 999), cal)).toBeNull();
  });
});
