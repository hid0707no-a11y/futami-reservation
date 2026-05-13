// 価格計算 純粋関数ライブラリのユニットテスト（assets/js/pricing.js）
//
// 2026-05-13 新設（Evaluator 不足3 への対応）。
// index.html 内に inline で書かれていた純粋関数を assets/js/pricing.js に切り出し、
// Jest テストの対象にした。これにより：
//  - 複数選択UIで roomCount を倍率にしたロジック
//  - テニス平日割の固定値 vs フォールバック計算
//  - 連泊スロット展開（チェックイン時刻より前は翌日扱い）
//  などが CI で守られる。
//
// テスト対象は素のJS（CommonJS export）なので jsdom 不要。jest の default 環境で動く。

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NisshoPricing = require('../../assets/js/pricing.js');

describe('addDays', () => {
  it('翌日を返す', () => {
    expect(NisshoPricing.addDays('2026-05-13', 1)).toBe('2026-05-14');
  });

  it('月またぎ', () => {
    expect(NisshoPricing.addDays('2026-05-31', 1)).toBe('2026-06-01');
  });

  it('年またぎ', () => {
    expect(NisshoPricing.addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('うるう年（2028-02-28 + 1）', () => {
    expect(NisshoPricing.addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('0日加算は同じ日付', () => {
    expect(NisshoPricing.addDays('2026-05-13', 0)).toBe('2026-05-13');
  });

  it('負の加算（前日）', () => {
    expect(NisshoPricing.addDays('2026-05-13', -1)).toBe('2026-05-12');
  });
});

describe('addMinutes', () => {
  it('30分加算', () => {
    expect(NisshoPricing.addMinutes('0900', 30)).toBe('0930');
  });

  it('時繰り上がり', () => {
    expect(NisshoPricing.addMinutes('0930', 30)).toBe('1000');
  });

  it('24時跨ぎは mod 24 正規化（旧版は "2430" 桁あふれを返していた・2026-05-13 修正）', () => {
    expect(NisshoPricing.addMinutes('2330', 60)).toBe('0030');
    expect(NisshoPricing.addMinutes('2330', 30)).toBe('0000');
    expect(NisshoPricing.addMinutes('2300', 120)).toBe('0100');
  });

  it('現営業時間（8:00-22:00 + 30分枠）の範囲では 24時跨ぎは発生しない（実害ゼロ確認）', () => {
    // テニスは 8:00-22:00 範囲。最大 +30 分でも 22:30 で収まる
    expect(NisshoPricing.addMinutes('2200', 30)).toBe('2230');
    expect(NisshoPricing.addMinutes('2130', 30)).toBe('2200');
  });

  it('負の加算（過去時刻）も正規化', () => {
    expect(NisshoPricing.addMinutes('0030', -60)).toBe('2330');
  });
});

describe('formatDate', () => {
  it('5月13日(水)', () => {
    expect(NisshoPricing.formatDate('2026-05-13')).toBe('5月13日(水)');
  });

  it('空文字を渡しても安全', () => {
    expect(NisshoPricing.formatDate('')).toBe('');
  });
});

describe('expandStaySlots', () => {
  // 宿泊（16:00〜翌10:00 = slots=[16..23, 0..9]）の典型例
  const stayPlan = {
    slots: [16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  };

  it('1泊なら 18件（16-23 = 8件・翌日 0-9 = 10件）が展開される', () => {
    const result = NisshoPricing.expandStaySlots(stayPlan, '2026-05-13', 1);
    expect(result).toHaveLength(18);
    // チェックイン時刻 16 は当日
    expect(result[0]).toEqual({ date: '2026-05-13', hour: 16 });
    // 0:00 はチェックイン時刻 16 より前なので翌日扱い
    const slot0 = result.find((s: { date: string; hour: number }) => s.hour === 0);
    expect(slot0?.date).toBe('2026-05-14');
  });

  it('2泊なら 36件（18件×2）が展開される', () => {
    const result = NisshoPricing.expandStaySlots(stayPlan, '2026-05-13', 2);
    expect(result).toHaveLength(36);
  });

  it('slots 空のプランは空配列', () => {
    expect(NisshoPricing.expandStaySlots({ slots: [] }, '2026-05-13', 1)).toEqual([]);
  });

  it('slots 未定義のプランも空配列（防御的）', () => {
    expect(NisshoPricing.expandStaySlots({}, '2026-05-13', 1)).toEqual([]);
  });
});

describe('calculateStayPrice', () => {
  const stay6 = { basePrice: 2310, extraAdult: 1580, extraChild: 1050, extraInfant: 790 };

  it('1部屋・1泊・大人3名（人数加算込み）', () => {
    // (2310 + 1580*3) * 1 = 7050
    expect(NisshoPricing.calculateStayPrice(stay6, {
      roomCount: 1, nights: 1, guestsAdult: 3, guestsChild: 0, guestsInfant: 0,
    })).toBe(7050);
  });

  it('複数選択 UI：2部屋・1泊・大人6名（要望#7 の典型ペイロード）', () => {
    // (2310*2 + 1580*6) * 1 = 4620 + 9480 = 14100
    expect(NisshoPricing.calculateStayPrice(stay6, {
      roomCount: 2, nights: 1, guestsAdult: 6, guestsChild: 0, guestsInfant: 0,
    })).toBe(14100);
  });

  it('連泊：1部屋・3泊・大人2名', () => {
    // (2310 + 1580*2) * 3 = 5470 * 3 = 16410
    expect(NisshoPricing.calculateStayPrice(stay6, {
      roomCount: 1, nights: 3, guestsAdult: 2, guestsChild: 0, guestsInfant: 0,
    })).toBe(16410);
  });

  it('小学生・未就学児加算', () => {
    // 2310 + 1050*2 + 790*1 = 5200
    expect(NisshoPricing.calculateStayPrice(stay6, {
      roomCount: 1, nights: 1, guestsAdult: 0, guestsChild: 2, guestsInfant: 1,
    })).toBe(5200);
  });

  it('roomCount=0 / nights=0 はそれぞれ 1 にフォールバック（料金 0 計上事故防止）', () => {
    expect(NisshoPricing.calculateStayPrice(stay6, {
      roomCount: 0, nights: 0, guestsAdult: 1, guestsChild: 0, guestsInfant: 0,
    })).toBe(2310 + 1580);
  });
});

describe('calculateHourlyTennisPrice', () => {
  const tennis = {
    residentPrice: 630, nonResidentPrice: 760,
    weekdayDiscount: true,
    weekdayDiscountResident: 320, weekdayDiscountNonResident: 380,
    lightingPrice: 630,
  };

  it('市民・通常時間1時間（30分2枠で1時間）→ residentPrice × 1', () => {
    expect(NisshoPricing.calculateHourlyTennisPrice(tennis, {
      hours: ['0900', '0930'],
      isResident: true,
      useLighting: false,
      courtCount: 1,
      isWeekdayDiscountHour: () => false,
    })).toBe(1260); // 630 × 2 枠
  });

  it('市民・平日割2枠 → weekdayDiscountResident × 2', () => {
    expect(NisshoPricing.calculateHourlyTennisPrice(tennis, {
      hours: ['1000', '1030'],
      isResident: true,
      useLighting: false,
      courtCount: 1,
      isWeekdayDiscountHour: () => true,
    })).toBe(640); // 320 × 2
  });

  it('複数コート（要望#7）：コート数倍率', () => {
    // 通常 630 × 2 枠 × 3 コート = 3780
    expect(NisshoPricing.calculateHourlyTennisPrice(tennis, {
      hours: ['0900', '0930'],
      isResident: true,
      useLighting: false,
      courtCount: 3,
      isWeekdayDiscountHour: () => false,
    })).toBe(3780);
  });

  it('夜間照明 ON・コート単位課金', () => {
    // 760 × 2 枠 + 630（照明） × 2 枠 = 1520 + 1260 = 2780
    expect(NisshoPricing.calculateHourlyTennisPrice(tennis, {
      hours: ['1800', '1830'],
      isResident: false,
      useLighting: true,
      courtCount: 1,
      isWeekdayDiscountHour: () => false,
    })).toBe(2780);
  });

  it('weekdayDiscountResident 未設定なら Math.ceil(price*0.5/10)*10 フォールバック', () => {
    const plan = { residentPrice: 630, nonResidentPrice: 760, weekdayDiscount: true };
    // fallback = Math.ceil(630*0.5/10)*10 = Math.ceil(31.5)*10 = 320
    expect(NisshoPricing.calculateHourlyTennisPrice(plan, {
      hours: ['0900'],
      isResident: true,
      useLighting: false,
      courtCount: 1,
      isWeekdayDiscountHour: () => true,
    })).toBe(320);
  });

  it('時間 0 件なら 0 を返す', () => {
    expect(NisshoPricing.calculateHourlyTennisPrice(tennis, {
      hours: [],
      isResident: true,
      useLighting: false,
      courtCount: 1,
      isWeekdayDiscountHour: () => false,
    })).toBe(0);
  });
});

describe('calculateCampPrice', () => {
  const camp = { basePrice: 790 };

  it('3区画・2泊 = 4740', () => {
    expect(NisshoPricing.calculateCampPrice(camp, { siteCount: 3, nights: 2 })).toBe(4740);
  });

  it('区画 0 は 0 円（料金確定前の表示用）', () => {
    expect(NisshoPricing.calculateCampPrice(camp, { siteCount: 0, nights: 1 })).toBe(0);
  });

  it('テント追加（旧50円/張）は廃止済（要望#10）— calculateCampPrice には反映されないことを保証', () => {
    // 引数に tentCount 等が無いことが要望#10 の物理的な廃止を保証
    expect(NisshoPricing.calculateCampPrice(camp, { siteCount: 1, nights: 1, tentCount: 100 } as any))
      .toBe(790); // tentCount は無視される
  });
});
