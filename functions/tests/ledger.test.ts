// 月俯瞰台帳のセル表記（2026-08-16 運営要望①②）
//
// availability.test.ts / pricing.test.ts と同じく、フロント側の純粋関数ライブラリを
// Node から読んで検証する。

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ledger = require('../../assets/js/ledger.js');

interface Res {
  planId?: string;
  startDate?: string;
  endDate?: string;
  roomIds?: string[];
}

const stay = (planId: string, startDate: string, endDate: string): Res =>
  ({ planId, startDate, endDate });
const day = (planId: string, date: string): Res =>
  ({ planId, startDate: date, endDate: date });

const role = (r: Res, date: string): string => Ledger.reservationRoleOnDate(r, date);
const marks = (list: Res[], date: string) => Ledger.ledgerCellMarks(list, date);
const lineTexts = (list: Res[], date: string): string[] =>
  Ledger.ledgerCellLines(marks(list, date)).map((l: any) => l.text);
const level = (list: Res[], date: string): string => Ledger.ledgerCellLevel(marks(list, date));

describe('運営要望① — 1泊2日は「1」が両日に出ない', () => {
  const oneNight = stay('stay_6', '2026-08-01', '2026-08-02');

  it('チェックイン日は IN', () => {
    expect(role(oneNight, '2026-08-01')).toBe('in');
    expect(lineTexts([oneNight], '2026-08-01')).toEqual(['IN']);
  });

  it('チェックアウト日は OUT（数字の「1」は出ない）', () => {
    expect(role(oneNight, '2026-08-02')).toBe('out');
    expect(lineTexts([oneNight], '2026-08-02')).toEqual(['out']);
  });

  it('チェックアウト日は「利用がある日」として数えない（＝新しい宿泊を受けられる）', () => {
    expect(Ledger.activeCount(marks([oneNight], '2026-08-02'))).toBe(0);
    expect(level([oneNight], '2026-08-02')).toBe('out-only');
  });

  it('連泊の中日は 泊', () => {
    const twoNights = stay('stay_27', '2026-08-01', '2026-08-03');
    expect(role(twoNights, '2026-08-01')).toBe('in');
    expect(role(twoNights, '2026-08-02')).toBe('mid');
    expect(role(twoNights, '2026-08-03')).toBe('out');
    expect(lineTexts([twoNights], '2026-08-02')).toEqual(['泊']);
  });
});

describe('要望①の本丸 — 現行台帳の「2」の正体（朝OUT＋夕方IN）', () => {
  // 1部屋＝1行なので、同じ行の同じ日に2件並ぶのは「出る組＋入る組」しかない。
  // 従来はここが「2」と表示され、2組が泊まっているように読めていた。
  const leaving = stay('stay_6', '2026-08-01', '2026-08-02');
  const arriving = stay('stay_6', '2026-08-02', '2026-08-03');
  const cell = [leaving, arriving];

  it('上から時系列（朝出る → 夕方入る）で2段になる', () => {
    expect(lineTexts(cell, '2026-08-02')).toEqual(['out', 'IN']);
  });

  it('その日の受入件数は1件として数える（旧表示の 2 は二重計上だった）', () => {
    expect(Ledger.activeCount(marks(cell, '2026-08-02'))).toBe(1);
    expect(level(cell, '2026-08-02')).toBe('some');
  });

  it('総件数（詳細ポップアップを開けるか）は2件のまま', () => {
    expect(Ledger.totalCount(marks(cell, '2026-08-02'))).toBe(2);
  });
});

describe('運営要望② — 日帰りは数字でなく「日」', () => {
  it('ふれあいの館の日帰りプランは day', () => {
    expect(role(day('day_6_all', '2026-08-05'), '2026-08-05')).toBe('day');
    expect(role(day('day_27_pm', '2026-08-05'), '2026-08-05')).toBe('day');
    expect(role(day('day_exp_am', '2026-08-05'), '2026-08-05')).toBe('day');
    expect(lineTexts([day('day_6_all', '2026-08-05')], '2026-08-05')).toEqual(['日']);
  });

  it('ロッジ日帰りも day（ロッジ行は宿泊と日帰りが混ざる）', () => {
    expect(role(day('lodge_day', '2026-08-05'), '2026-08-05')).toBe('day');
  });

  it('同じ日に日帰りが複数入れば件数を添える（27畳の午前＋午後＋夜間）', () => {
    const list = [day('day_27_am', '2026-08-05'), day('day_27_pm', '2026-08-05'), day('day_27_eve', '2026-08-05')];
    expect(lineTexts(list, '2026-08-05')).toEqual(['日3']);
    expect(level(list, '2026-08-05')).toBe('many');
  });

  it('宿泊と日帰りが同じ日に並ぶ（ロッジ：朝OUT → 日帰り → 夕方IN）', () => {
    const list = [
      stay('lodge_stay', '2026-08-04', '2026-08-05'),
      day('lodge_day', '2026-08-05'),
      stay('lodge_stay', '2026-08-05', '2026-08-06'),
    ];
    expect(lineTexts(list, '2026-08-05')).toEqual(['out', '日', 'IN']);
  });
});

describe('キャンプ場（8区画を1行に集約）— 件数が消えない', () => {
  it('複数区画のチェックインは IN3 のように件数を添える', () => {
    const list = [
      stay('camp_stay', '2026-08-10', '2026-08-11'),
      stay('camp_stay', '2026-08-10', '2026-08-11'),
      stay('camp_stay', '2026-08-10', '2026-08-12'),
    ];
    expect(lineTexts(list, '2026-08-10')).toEqual(['IN3']);
    expect(lineTexts(list, '2026-08-11')).toEqual(['out2', '泊']);
  });

  it('4件以上は従来どおり満（full）色', () => {
    const list = Array.from({ length: 4 }, () => stay('camp_stay', '2026-08-10', '2026-08-11'));
    expect(level(list, '2026-08-10')).toBe('full');
  });
});

describe('色レベルのしきい値は従来の月俯瞰と同じ', () => {
  const on = (n: number) => Array.from({ length: n }, () => day('day_6_all', '2026-08-05'));
  it('0件 → empty', () => expect(level([], '2026-08-05')).toBe('empty'));
  it('1件 → some', () => expect(level(on(1), '2026-08-05')).toBe('some'));
  it('2件 → many', () => expect(level(on(2), '2026-08-05')).toBe('many'));
  it('3件 → many', () => expect(level(on(3), '2026-08-05')).toBe('many'));
  it('4件 → full', () => expect(level(on(4), '2026-08-05')).toBe('full'));
});

describe('壊れた・古いデータで台帳が消えないこと（安全側フォールバック）', () => {
  it('知らない planId は other＝従来どおり件数として残る', () => {
    expect(role({ planId: 'brand_new_plan_2027', startDate: '2026-08-01', endDate: '2026-08-01' }, '2026-08-01'))
      .toBe('other');
    expect(Ledger.activeCount(marks([{ planId: 'brand_new_plan_2027', startDate: '2026-08-01', endDate: '2026-08-01' }], '2026-08-01')))
      .toBe(1);
  });

  it('planId が無い予約も消えない（other として数える）', () => {
    expect(role({ startDate: '2026-08-01', endDate: '2026-08-02' } as Res, '2026-08-01')).toBe('other');
  });

  it('宿泊なのに endDate === startDate の旧データは IN 扱い（OUTだけの幽霊にしない）', () => {
    expect(role(stay('stay_6', '2026-08-01', '2026-08-01'), '2026-08-01')).toBe('in');
  });

  it('範囲外の日付は other（呼び出し側の occupancy マップと食い違っても壊れない）', () => {
    expect(role(stay('stay_6', '2026-08-01', '2026-08-02'), '2026-08-09')).toBe('other');
  });

  it('reservations が配列でなくても落ちない', () => {
    expect(Ledger.ledgerCellMarks(null, '2026-08-01')).toEqual({ in: 0, mid: 0, out: 0, day: 0, other: 0 });
  });
});

describe('複数施設をまとめた行の色（capacity・2026-08-17 レビュー指摘）', () => {
  // キャンプ場は camp_1〜camp_8 の8区画を1行に集約している。1部屋1行のしきい値
  // （4件以上＝満）をそのまま当てると、半分空いている日が赤「満」になり、
  // 運営が予約を断りかねない。
  const campers = (n: number, date: string): Res[] =>
    Array.from({ length: n }, () => stay('camp_stay', date, '2026-08-11'));
  const campLevel = (n: number): string =>
    Ledger.ledgerCellLevel(marks(campers(n, '2026-08-10'), '2026-08-10'), 8);

  it('8区画中4件は「多め」であって「満」ではない', () => {
    expect(campLevel(4)).toBe('many');
  });

  it('半分に満たなければ「一部予約」', () => {
    expect(campLevel(1)).toBe('some');
    expect(campLevel(3)).toBe('some');
  });

  it('全区画が埋まって初めて「満」', () => {
    expect(campLevel(7)).toBe('many');
    expect(campLevel(8)).toBe('full');
  });

  it('capacity 省略・1 は従来どおり（1部屋1行の見慣れた色を変えない）', () => {
    const one = stay('stay_6', '2026-08-10', '2026-08-11');
    expect(level([one], '2026-08-10')).toBe('some');
    expect(Ledger.ledgerCellLevel(marks([one], '2026-08-10'), 1)).toBe('some');
    // 旧しきい値（2〜3件＝多め / 4件以上＝満）も維持
    expect(Ledger.ledgerCellLevel({ in: 2, mid: 0, out: 0, day: 0, other: 0 })).toBe('many');
    expect(Ledger.ledgerCellLevel({ in: 4, mid: 0, out: 0, day: 0, other: 0 })).toBe('full');
  });

  it('capacity を渡してもチェックアウトだけの日は out-only のまま', () => {
    const leaving = stay('camp_stay', '2026-08-09', '2026-08-10');
    expect(Ledger.ledgerCellLevel(marks([leaving], '2026-08-10'), 8)).toBe('out-only');
  });
});

// 2026-08-25 要望③：キャンプの区画上限を 3→8 へ解放したことで、
// 「1予約が複数区画を取る」形が日常的に起こる。件数で色を決めると満室が空きに見える。
describe('複数区画を1予約で取る日の色（要望③・2026-08-25）', () => {
  const campWith = (rooms: string[], date: string): Res =>
    ({ planId: 'camp_stay', startDate: date, endDate: '2026-08-11', roomIds: rooms });
  const allEight = ['camp_1', 'camp_2', 'camp_3', 'camp_4', 'camp_5', 'camp_6', 'camp_7', 'camp_8'];

  it('1組が8区画すべてを取った日は「満」（件数1でも空きに見せない）', () => {
    const list = [campWith(allEight, '2026-08-10')];
    const m = marks(list, '2026-08-10');
    // 従来どおり件数で判定すると「一部予約」に見えてしまう＝これが直した問題
    expect(Ledger.ledgerCellLevel(m, 8)).toBe('some');
    // 埋まった区画数を渡せば「満」
    const units = Ledger.ledgerActiveUnits(list, '2026-08-10');
    expect(units).toBe(8);
    expect(Ledger.ledgerCellLevel(m, 8, units)).toBe('full');
  });

  it('2組で 5区画 + 3区画 なら満（重複なし）', () => {
    const list = [
      campWith(['camp_1', 'camp_2', 'camp_3', 'camp_4', 'camp_5'], '2026-08-10'),
      campWith(['camp_6', 'camp_7', 'camp_8'], '2026-08-10'),
    ];
    expect(Ledger.ledgerActiveUnits(list, '2026-08-10')).toBe(8);
    expect(Ledger.ledgerCellLevel(marks(list, '2026-08-10'), 8, Ledger.ledgerActiveUnits(list, '2026-08-10'))).toBe('full');
  });

  it('4区画なら「多め」、3区画なら「一部予約」', () => {
    const four = [campWith(['camp_1', 'camp_2', 'camp_3', 'camp_4'], '2026-08-10')];
    expect(Ledger.ledgerCellLevel(marks(four, '2026-08-10'), 8, Ledger.ledgerActiveUnits(four, '2026-08-10'))).toBe('many');
    const three = [campWith(['camp_1', 'camp_2', 'camp_3'], '2026-08-10')];
    expect(Ledger.ledgerCellLevel(marks(three, '2026-08-10'), 8, Ledger.ledgerActiveUnits(three, '2026-08-10'))).toBe('some');
  });

  it('チェックアウトだけの区画は埋まっていないものとして数える', () => {
    const leaving: Res = { planId: 'camp_stay', startDate: '2026-08-09', endDate: '2026-08-10', roomIds: allEight };
    expect(Ledger.ledgerActiveUnits([leaving], '2026-08-10')).toBe(0);
    expect(Ledger.ledgerCellLevel(marks([leaving], '2026-08-10'), 8, 0)).toBe('out-only');
  });

  it('roomIds を持たない旧データは1件として数える（0件にして空きに見せない）', () => {
    const legacy = stay('camp_stay', '2026-08-10', '2026-08-11');
    expect(Ledger.ledgerActiveUnits([legacy], '2026-08-10')).toBe(1);
  });

  it('1部屋1行（capacity=1）は activeUnits を渡しても従来どおり', () => {
    const one: Res = { planId: 'stay_6', startDate: '2026-08-10', endDate: '2026-08-11', roomIds: ['room_6_1'] };
    expect(Ledger.ledgerCellLevel(marks([one], '2026-08-10'), 1, 1)).toBe('some');
  });
});

describe('プラン分類がサーバ側カタログと食い違っていないこと', () => {
  // functions/src/lib/reservationPlans.ts の kind:'overnight' が STAY、それ以外が DAY。
  // 片方に足し忘れると台帳の IN/OUT がその施設だけ出なくなるため、ここで固定する。
  const { RESERVATION_PLAN_RULES } = require('../src/lib/reservationPlans');

  it('サーバの overnight プランは全て STAY_PLAN_IDS に載っている', () => {
    const overnight = Object.keys(RESERVATION_PLAN_RULES)
      .filter(id => RESERVATION_PLAN_RULES[id].kind === 'overnight');
    expect(overnight.sort()).toEqual([...Ledger.STAY_PLAN_IDS].sort());
  });

  it('サーバの非overnightプランは全て DAY_PLAN_IDS に載っている', () => {
    const others = Object.keys(RESERVATION_PLAN_RULES)
      .filter(id => RESERVATION_PLAN_RULES[id].kind !== 'overnight');
    for (const id of others) {
      expect(Ledger.isDayPlan(id)).toBe(true);
    }
  });

  it('同じ planId が STAY と DAY の両方に入っていない', () => {
    for (const id of Ledger.STAY_PLAN_IDS) {
      expect(Ledger.isDayPlan(id)).toBe(false);
    }
  });
});
