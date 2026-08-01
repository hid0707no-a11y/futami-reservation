// 空き状況レベル判定（2026-08-01 運営要望②）
//
// pricing.test.ts と同じく、フロント側の純粋関数ライブラリを Node から読んで検証する。

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Availability = require('../../assets/js/availability.js');

const level = (free: number, total: number): string =>
  Availability.dayAvailabilityLevel(free, total);

describe('サウナ（4枠）— 運営要望②の受け入れ条件', () => {
  it('4枠すべて空き → ◎（ok）', () => expect(level(4, 4)).toBe('ok'));
  it('1枠埋まった時点で ○（few）', () => expect(level(3, 4)).toBe('few'));
  it('2枠埋まった時点で △（some）', () => expect(level(2, 4)).toBe('some'));
  it('残り1枠で ▲ 残りわずか（last）', () => expect(level(1, 4)).toBe('last'));
  it('満員で ×（full）', () => expect(level(0, 4)).toBe('full'));

  it('旧実装のバグ（2枠空きでも◎）が再発しないこと', () => {
    expect(level(2, 4)).not.toBe('ok');
  });
});

describe('1プランしかない施設（キャンプ場・6畳日帰り・厨房）', () => {
  it('空きは ◎ のまま（▲に化けない＝判定順の保証）', () => {
    expect(level(1, 1)).toBe('ok');
  });
  it('埋まれば ×', () => expect(level(0, 1)).toBe('full'));
});

describe('2プランの施設（ロッジ・テニス）', () => {
  it('2枠空き → ◎', () => expect(level(2, 2)).toBe('ok'));
  it('残り1枠 → ▲（○より強く出す。few より last を優先）', () => {
    expect(level(1, 2)).toBe('last');
  });
  it('0枠 → ×', () => expect(level(0, 2)).toBe('full'));
});

describe('5プランの施設（27畳・体験学習室・研修室）', () => {
  it.each([
    [5, 'ok'],
    [4, 'few'],
    [3, 'some'],
    [2, 'some'],
    [1, 'last'],
    [0, 'full'],
  ])('空き%i枠 → %s', (free, expected) => {
    expect(level(free as number, 5)).toBe(expected);
  });
});

describe('異常値は「空きあり」と誤認させない（満室側に倒す）', () => {
  it.each([
    ['total=0', 0, 0],
    ['total が負', 1, -1],
    ['free が負', -1, 4],
    ['free が NaN', NaN, 4],
    ['total が NaN', 2, NaN],
    ['free が undefined', undefined, 4],
    ['total が undefined', 2, undefined],
    ['free が null', null, 4],
  ])('%s → full', (_name, free, total) => {
    expect(level(free as any, total as any)).toBe('full');
  });

  it('free が total を超えていても ◎ に丸める（データ不整合で落ちない）', () => {
    expect(level(9, 4)).toBe('ok');
  });
});

describe('levelLabel', () => {
  it('全レベルに日本語ラベルがある', () => {
    expect(Availability.levelLabel('ok')).toBe('空きあり');
    expect(Availability.levelLabel('few')).toBe('やや空きあり');
    expect(Availability.levelLabel('some')).toBe('半分ほど埋まり');
    expect(Availability.levelLabel('last')).toBe('残りわずか');
    expect(Availability.levelLabel('full')).toBe('満室');
    expect(Availability.levelLabel('closed')).toBe('定休日');
    expect(Availability.levelLabel('unknown')).toBe('確認中');
  });

  it('未知のレベルは「確認中」に落とす', () => {
    expect(Availability.levelLabel('nonexistent')).toBe('確認中');
  });

  it('dayAvailabilityLevel が返す全値にラベルが存在する', () => {
    const produced = new Set<string>();
    for (let total = 1; total <= 6; total++) {
      for (let free = 0; free <= total; free++) produced.add(level(free, total));
    }
    produced.forEach(l => {
      expect(Object.prototype.hasOwnProperty.call(Availability.LEVEL_LABELS, l)).toBe(true);
    });
  });
});
