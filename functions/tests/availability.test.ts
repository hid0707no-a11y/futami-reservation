// 空き状況レベル判定（2026-08-01 運営要望②）
//
// pricing.test.ts と同じく、フロント側の純粋関数ライブラリを Node から読んで検証する。

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Availability = require('../../assets/js/availability.js');

import {
  BusinessCalendar,
  businessCalendarFromData,
  findClosedFacilitySlot,
  isFacilitySlotClosed as serverIsFacilitySlotClosed,
} from '../src/lib/businessDays';

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

// ─────────────────────────────────────────────
// 施設ごとの停止（facilityClosed）— 公開ページ側の純粋関数
// ─────────────────────────────────────────────
//
// 2026-08-02 追加。運営要望「サウナだけをその日は予約不可にしたい」。
// index.html の isSlotFree() / isTennisSlotFree() / getAvailabilityLevel() が
// この関数を呼ぶ（HTML の <script> にロジックを増やさない現場の掟）。
//
// ★このブロックで最も大事なのは末尾のパリティテスト：
//   フロントとサーバで判定がずれると「画面では空きに見えるのに予約すると400」になる。

const frontClosed = (
  facilityClosed: unknown,
  roomId: unknown,
  date: unknown,
  hour?: unknown,
): boolean => Availability.isFacilitySlotClosed(facilityClosed, roomId, date, hour);

/** サウナ A〜D の時（index.html PLANS / functions の reservationPlans.ts と一致） */
const SAUNA_PLANS: Array<[string, number[]]> = [
  ['A 10:00-12:00', [10, 11]],
  ['B 12:30-14:30', [12, 13, 14]],
  ['C 15:00-17:00', [15, 16]],
  ['D 17:30-19:30', [17, 18, 19]],
];
const D = '2026-09-20';

describe('availability.js isFacilitySlotClosed — 終日停止', () => {
  const cal = [`sauna|${D}`];

  it.each(SAUNA_PLANS)('サウナ%sの全時間が止まる', (_name, hours) => {
    for (const h of hours) expect(frontClosed(cal, 'sauna', D, h)).toBe(true);
  });

  it('別日・別施設は止まらない', () => {
    expect(frontClosed(cal, 'sauna', '2026-09-21', 10)).toBe(false);
    expect(frontClosed(cal, 'room_27', D, 10)).toBe(false);
    expect(frontClosed(cal, 'camp_1', D, 14)).toBe(false);
  });

  it('hour 未指定でも終日停止なら true（カレンダーの日セル判定用）', () => {
    expect(frontClosed(cal, 'sauna', D)).toBe(true);
    expect(frontClosed(cal, 'sauna', D, null)).toBe(true);
  });
});

describe('availability.js isFacilitySlotClosed — 時間指定の停止', () => {
  const cal = [`sauna|${D}|10`];

  it('10時だけ止まり12時は空いている', () => {
    expect(frontClosed(cal, 'sauna', D, 10)).toBe(true);
    expect(frontClosed(cal, 'sauna', D, '10')).toBe(true);
    expect(frontClosed(cal, 'sauna', D, 11)).toBe(false);
    expect(frontClosed(cal, 'sauna', D, 12)).toBe(false);
  });

  it('A枠だけがカレンダーから消える（B/C/D は残る）', () => {
    const blocked = SAUNA_PLANS.filter(([, hours]) =>
      hours.some(h => frontClosed(cal, 'sauna', D, h)));
    expect(blocked.map(([name]) => name)).toEqual(['A 10:00-12:00']);
  });

  it('hour 未指定は時間指定の停止に当たらない', () => {
    expect(frontClosed(cal, 'sauna', D)).toBe(false);
    expect(frontClosed(cal, 'sauna', D, null)).toBe(false);
  });

  it('テニスの HHMM キーは先頭2桁を時として扱う', () => {
    const tennis = [`court_1|${D}|8`];
    expect(frontClosed(tennis, 'court_1', D, '0800')).toBe(true);
    expect(frontClosed(tennis, 'court_1', D, '0830')).toBe(true);
    expect(frontClosed(tennis, 'court_1', D, '0900')).toBe(false);
    expect(frontClosed([`court_1|${D}`], 'court_1', D, '2130')).toBe(true);
  });
});

describe('availability.js — サウナ連動（sauna ⇄ sauna_share）', () => {
  // ふたみの日（毎月23日前後）は同じ物理サウナを sauna_share で運用する。
  // 片方の停止指定がもう片方に効かないと、ふたみの日だけ予約できてしまう。
  it('sauna の停止が sauna_share に効く', () => {
    expect(frontClosed([`sauna|${D}`], 'sauna_share', D, 10)).toBe(true);
    expect(frontClosed([`sauna|${D}|15`], 'sauna_share', D, 15)).toBe(true);
    expect(frontClosed([`sauna|${D}|15`], 'sauna_share', D, 16)).toBe(false);
  });

  it('sauna_share の停止が sauna に効く', () => {
    expect(frontClosed([`sauna_share|${D}`], 'sauna', D, 17)).toBe(true);
    expect(frontClosed([`sauna_share|${D}|17`], 'sauna', D, 17)).toBe(true);
    expect(frontClosed([`sauna_share|${D}|17`], 'sauna', D, 18)).toBe(false);
  });

  it('連動はサウナ限定（他施設に波及しない）', () => {
    expect(frontClosed([`room_6_1|${D}`], 'room_6_2', D, 10)).toBe(false);
    expect(frontClosed([`lodge_a|${D}`], 'lodge_b', D, 16)).toBe(false);
    expect(frontClosed([`court_1|${D}`], 'court_2', D, '0800')).toBe(false);
  });
});

describe('availability.js — 導入前と同じ動作に倒す（回帰・防御）', () => {
  it.each([
    ['未設定(undefined)', undefined],
    ['null', null],
    ['空配列', []],
    ['配列でない文字列', `sauna|${D}`],
    ['オブジェクト', { 0: `sauna|${D}` }],
    ['数値', 0],
  ])('facilityClosed が %s なら常に false', (_name, fc) => {
    expect(frontClosed(fc, 'sauna', D, 10)).toBe(false);
    expect(frontClosed(fc, 'sauna', D)).toBe(false);
  });

  it('roomId / date が空なら false', () => {
    expect(frontClosed([`sauna|${D}`], '', D, 10)).toBe(false);
    expect(frontClosed([`sauna|${D}`], 'sauna', '', 10)).toBe(false);
    expect(frontClosed([`sauna|${D}`], null, D, 10)).toBe(false);
  });

  it('壊れた要素は無視し、有効な要素だけが効く', () => {
    const dirty = ['', 'sauna', 123, null, undefined, { a: 1 },
                   `sauna|${D}|99`, `sauna|${D}|abc`, `sauna|${D}|10`];
    expect(() => frontClosed(dirty, 'sauna', D, 10)).not.toThrow();
    expect(frontClosed(dirty, 'sauna', D, 10)).toBe(true);
    expect(frontClosed(dirty, 'sauna', D, 11)).toBe(false);
  });

  it('既存 API を壊していない（dayAvailabilityLevel / levelLabel が健在）', () => {
    expect(typeof Availability.isFacilitySlotClosed).toBe('function');
    expect(level(4, 4)).toBe('ok');
    expect(Availability.levelLabel('full')).toBe('満室');
  });
});

// ─────────────────────────────────────────────
// ★パリティ：assets/js/availability.js ⇄ functions/src/lib/businessDays.ts
// ─────────────────────────────────────────────
//
// 本番の流れ：Firestore の生データ → businessCalendarFromData で正規化 → GET /businessCalendar
//            → index.html が保持 → availability.js が判定
// サーバは同じ正規化済みカレンダーで createReservation を判定する。
// よって「正規化済みカレンダー」に対しては両者が完全一致していなければならない。

/** 生データを本番と同じ経路で正規化し、両実装に同じ入力を与えて突き合わせる */
function parity(rawEntries: unknown[], roomId: string, date: string, hour: unknown): boolean {
  const cal: BusinessCalendar = businessCalendarFromData({ facilityClosed: rawEntries });
  const server = serverIsFacilitySlotClosed(roomId, date, hour as any, cal);
  const front = frontClosed(cal.facilityClosed, roomId, date, hour);
  expect({ where: `${roomId}|${date}|${String(hour)}`, front })
    .toEqual({ where: `${roomId}|${date}|${String(hour)}`, front: server });
  return server;
}

describe('パリティ：フロントとサーバが同じ入力で同じ判定を返す', () => {
  const ENTRY_SETS: Array<[string, unknown[]]> = [
    ['空', []],
    ['sauna 終日', [`sauna|${D}`]],
    ['sauna 10時', [`sauna|${D}|10`]],
    ['sauna B枠(12/13/14)', [`sauna|${D}|12`, `sauna|${D}|13`, `sauna|${D}|14`]],
    ['sauna_share 終日', [`sauna_share|${D}`]],
    ['sauna_share 17時', [`sauna_share|${D}|17`]],
    ['court_1 終日', [`court_1|${D}`]],
    ['court_1 8時', [`court_1|${D}|8`]],
    ['court_wall 終日', [`court_wall|${D}`]],
    ['room_27 終日', [`room_27|${D}`]],
    ['lodge_a 別日', [`lodge_a|2026-09-21`]],
    ['0時/23時', [`room_27|${D}|0`, `room_27|${D}|23`]],
    ['混在', [`sauna|${D}|10`, `court_1|${D}`, `camp_3|2026-09-21|14`]],
    // ↓ 正規化で全部捨てられるはずの生データ（捨て漏れがあれば両者がずれる）
    ['不正のみ', ['', 'sauna', `sauna|2026-02-30`, `sauna|${D}|24`, `sauna|${D}|08`,
                  `nonexistent|${D}`, 123, null, `sauna|${D}|10|x`]],
    ['不正+有効', [`sauna|${D}|08`, `sauna|${D}|24`, `sauna|${D}|17`]],
  ];

  const PROBES: Array<[string, string, unknown]> = [
    ['sauna', D, 10], ['sauna', D, '10'], ['sauna', D, 11], ['sauna', D, 12],
    ['sauna', D, 8], ['sauna', D, 17], ['sauna', D, 19], ['sauna', D, 0], ['sauna', D, 23],
    ['sauna', D, null], ['sauna', D, undefined],
    ['sauna', '2026-09-21', 10], ['sauna', '2026-09-19', 10],
    ['sauna_share', D, 10], ['sauna_share', D, 12], ['sauna_share', D, 17],
    ['sauna_share', D, null],
    ['court_1', D, '0800'], ['court_1', D, '0830'], ['court_1', D, '0900'],
    ['court_1', D, '2130'], ['court_1', D, null],
    ['court_2', D, '0800'], ['court_wall', D, '1800'],
    ['room_27', D, 8], ['room_27', D, 0], ['room_27', D, 23], ['room_27', D, null],
    ['camp_1', D, 14], ['camp_3', '2026-09-21', 14],
    ['lodge_a', D, 16], ['lodge_a', '2026-09-21', 8], ['lodge_b', '2026-09-21', 8],
    ['midori', D, 8], ['room_kitchen', D, 21],
    // 壊れた時間指定
    ['sauna', D, ''], ['sauna', D, '24'], ['sauna', D, '-1'], ['sauna', D, 'abc'],
    ['sauna', D, 8.5], ['sauna', D, true],
  ];

  it.each(ENTRY_SETS)('%s：全プローブでフロント＝サーバ', (_name, entries) => {
    for (const [roomId, date, hour] of PROBES) parity(entries, roomId, date, hour);
  });

  it('プラン単位でも一致：findClosedFacilitySlot ≠ null ⇔ フロントがどれかのスロットを閉じる', () => {
    const cases: Array<[string, unknown[], string[]]> = [
      ['A枠 / sauna 10時停止', [`sauna|${D}|10`], [`sauna|${D}|10`, `sauna|${D}|11`]],
      ['B枠 / sauna 10時停止', [`sauna|${D}|10`], [`sauna|${D}|12`, `sauna|${D}|13`, `sauna|${D}|14`]],
      ['D枠 / sauna 終日停止', [`sauna|${D}`], [`sauna|${D}|17`, `sauna|${D}|18`, `sauna|${D}|19`]],
      ['ふたみの日A枠 / sauna 終日停止', [`sauna|${D}`], [`sauna_share|${D}|10`, `sauna_share|${D}|11`]],
      ['ふたみの日A枠 / sauna 12時停止', [`sauna|${D}|12`], [`sauna_share|${D}|10`, `sauna_share|${D}|11`]],
      ['通常サウナ / sauna_share 終日停止', [`sauna_share|${D}`], [`sauna|${D}|15`, `sauna|${D}|16`]],
      ['テニス30分 / court_1 終日停止', [`court_1|${D}`], [`court_1|${D}|0800`, `court_1|${D}|0830`]],
      ['テニス30分 / court_1 8時停止', [`court_1|${D}|8`], [`court_1|${D}|0830`, `court_1|${D}|0900`]],
      ['テニス30分 / court_1 8時停止・9時枠', [`court_1|${D}|8`], [`court_1|${D}|0900`, `court_1|${D}|0930`]],
      ['連泊 / lodge_a 翌日停止', [`lodge_a|2026-09-21`], [`lodge_a|${D}|16`, `lodge_a|2026-09-21|8`]],
      ['無関係', [`sauna|${D}`], [`room_27|${D}|8`, `room_27|${D}|9`]],
      ['停止なし', [], [`sauna|${D}|10`, `sauna|${D}|11`]],
    ];
    for (const [name, entries, slots] of cases) {
      const cal = businessCalendarFromData({ facilityClosed: entries });
      const server = findClosedFacilitySlot(slots, cal) !== null;
      const front = slots.some(k => {
        const p = k.split('|');
        return frontClosed(cal.facilityClosed, p[0], p[1], p[2]);
      });
      expect({ name, front }).toEqual({ name, front: server });
    }
  });

  it('★安全側の不変条件：サーバが閉じる枠をフロントが開けて見せることは無い', () => {
    // これが破れると「画面では空きに見えるのに予約すると400」が起きる。
    // 正規化を通さない生データ（手動編集・古い保存値）でも成立させる。
    const RAW: unknown[][] = [
      [`sauna|${D}`], [`sauna|${D}|10`], [`sauna|${D}|08`], [`sauna|${D}|0`],
      [`sauna|2026-02-30`], [`nonexistent|${D}`], [`SAUNA|${D}`],
      [`sauna|${D}|10|extra`], ['sauna'], [''], [123 as any], [null as any],
      [`court_1|${D}|8`], [`court_1|${D}`], [`sauna_share|${D}|17`],
    ];
    let serverClosedHits = 0;
    for (const entries of RAW) {
      const cal: BusinessCalendar = {
        defaultClosedDays: [], forceOpen: [], forceClosed: [],
        facilityClosed: entries as string[],
      };
      for (const [roomId, date, hour] of PROBES) {
        const server = serverIsFacilitySlotClosed(roomId, date, hour as any, cal);
        const front = frontClosed(entries, roomId, date, hour);
        if (server) {
          serverClosedHits++;
          expect({ entries, roomId, date, hour, front }).toEqual(
            { entries, roomId, date, hour, front: true });
        }
      }
    }
    // 空振り（サーバが一度も閉じない＝不変条件が素通り）にならないことを保証する
    expect(serverClosedHits).toBeGreaterThan(10);
  });

  // 唯一の非対称：生データのゼロ埋め hour。
  // 契約は「hour はゼロ埋めしない 0〜23」なのでサーバは "08" を捨て、フロントは 8時として読む。
  // ずれる向きは「フロントが余計に閉じる」＝画面から消えるだけで 400 にはならない安全側。
  // かつ本番には到達しない（POST が 400・GET も businessCalendarFromData で落とす）ことを固定する。
  it('生データのゼロ埋め hour "08" は両者で解釈が違うが、本番データには到達しない', () => {
    const raw = [`sauna|${D}|08`];
    const unnormalized: BusinessCalendar = {
      defaultClosedDays: [], forceOpen: [], forceClosed: [], facilityClosed: raw,
    };
    // 生のままだと解釈が割れる（フロントだけが閉じる＝安全側）
    expect(serverIsFacilitySlotClosed('sauna', D, 8, unnormalized)).toBe(false);
    expect(frontClosed(raw, 'sauna', D, 8)).toBe(true);
    // ただし正規化を通すと消えるので、フロントが受け取る値にはそもそも入らない
    const cal = businessCalendarFromData({ facilityClosed: raw });
    expect(cal.facilityClosed).toEqual([]);
    expect(frontClosed(cal.facilityClosed, 'sauna', D, 8)).toBe(false);
    expect(serverIsFacilitySlotClosed('sauna', D, 8, cal)).toBe(false);
  });
});
