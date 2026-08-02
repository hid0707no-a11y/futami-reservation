// 施設停止（facilityClosed）まわりの純粋関数
//
// 2026-08-02 新設。敵対的レビュー指摘への対応をここで固定する：
//   [1] 終日停止が「その日にチェックアウトするだけの宿泊」まで拒否していた
//   [2] dry-run の facilityClosed が差分でなく全件判定で、警告が形骸化していた
//   [3] dry-run が reservations を日付で絞らず全件走査していた
//   [5] handlers に厚く乗っていた業務ロジックを lib へ切り出した（ここで Jest から追える）

import {
  BusinessCalendar,
  findClosedFacilitySlot,
  serviceDatesFromRange,
} from '../src/lib/businessDays';
import {
  RESERVATION_LOOKBACK_DAYS,
  addedEntries,
  collectReservationDates,
  judgedDateRange,
  reservationHitsClosedSettings,
  scanRangeForJudgedDates,
  toReservationLike,
} from '../src/lib/facilityImpact';

/** facilityClosed だけを差し替えたカレンダー（他項目は「休みでない」中立値） */
function calWith(facilityClosed: string[]): BusinessCalendar {
  return { defaultClosedDays: [], forceOpen: [], forceClosed: [], facilityClosed };
}

// ─────────────────────────────────────────────
// [1] serviceDates＝チェックアウト日を含まない
// ─────────────────────────────────────────────
describe('serviceDatesFromRange — canonical.serviceDates と同じ規約', () => {
  it('単日プラン（endDate === startDate）は開始日のみ', () => {
    expect(serviceDatesFromRange('2026-09-18', '2026-09-18')).toEqual(['2026-09-18']);
  });

  it('2泊（9/18 IN → 9/20 OUT）は 9/18・9/19 の2日（★9/20 は含まない）', () => {
    expect(serviceDatesFromRange('2026-09-18', '2026-09-20'))
      .toEqual(['2026-09-18', '2026-09-19']);
  });

  it('1泊は開始日のみ', () => {
    expect(serviceDatesFromRange('2026-09-18', '2026-09-19')).toEqual(['2026-09-18']);
  });

  it('endDate が壊れている／逆転していても落ちず開始日だけ返す', () => {
    expect(serviceDatesFromRange('2026-09-18', 'broken')).toEqual(['2026-09-18']);
    expect(serviceDatesFromRange('2026-09-18', undefined)).toEqual(['2026-09-18']);
    expect(serviceDatesFromRange('2026-09-18', '2026-09-10')).toEqual(['2026-09-18']);
    expect(serviceDatesFromRange('broken', '2026-09-20')).toEqual([]);
  });
});

describe('★終日停止はチェックアウト日だけの宿泊を拒否しない（指摘[1]）', () => {
  // 9/18 から2泊（チェックアウト 9/20）。宿泊 slots は翌朝ぶんが翌日側の日付に載るので
  // slots の日付は 9/18・9/19・9/20 の3日、serviceDates は 9/18・9/19 の2日になる。
  const SLOTS = [
    'room_27|2026-09-18|16', 'room_27|2026-09-18|23',
    'room_27|2026-09-19|8',                              // 1泊目の翌朝
    'room_27|2026-09-19|16', 'room_27|2026-09-19|23',
    'room_27|2026-09-20|8',                              // ★チェックアウト日の朝
  ];
  const SERVICE_DATES = serviceDatesFromRange('2026-09-18', '2026-09-20');

  it('チェックアウト日(9/20)の終日停止では予約できる', () => {
    const cal = calWith(['room_27|2026-09-20']);
    expect(findClosedFacilitySlot(SLOTS, cal, SERVICE_DATES)).toBeNull();
  });

  it('宿泊初日(9/18)・中間日(9/19)の終日停止は従来どおり止める', () => {
    expect(findClosedFacilitySlot(SLOTS, calWith(['room_27|2026-09-18']), SERVICE_DATES))
      .toBe('room_27|2026-09-18|16');
    expect(findClosedFacilitySlot(SLOTS, calWith(['room_27|2026-09-19']), SERVICE_DATES))
      .toBe('room_27|2026-09-19|8');
  });

  it('チェックアウト日でも「時間指定」の停止は当たる（朝8時だけ止めたい運用）', () => {
    const cal = calWith(['room_27|2026-09-20|8']);
    expect(findClosedFacilitySlot(SLOTS, cal, SERVICE_DATES)).toBe('room_27|2026-09-20|8');
  });

  it('既存の定休日規約と同じ向き：closed_day もチェックアウト日を検査しない', () => {
    // findClosedDayInServiceDates は serviceDates しか見ない＝9/20 は対象外、という前提に揃えた
    expect(SERVICE_DATES).not.toContain('2026-09-20');
  });
});

describe('後方互換：serviceDates を渡さない呼び方は導入時と同じ挙動', () => {
  const SLOTS = ['lodge_a|2026-09-20|16', 'lodge_a|2026-09-21|8'];

  it('2引数呼び出しは終日キーも slots 全件で突合する（＝チェックアウト日でも止まる）', () => {
    const cal = calWith(['lodge_a|2026-09-21']);
    expect(findClosedFacilitySlot(SLOTS, cal)).toBe('lodge_a|2026-09-21|8');
  });

  it('serviceDates が空配列／壊れた値なら2引数と同じ（止め漏らさない安全側）', () => {
    const cal = calWith(['lodge_a|2026-09-21']);
    expect(findClosedFacilitySlot(SLOTS, cal, [])).toBe('lodge_a|2026-09-21|8');
    expect(findClosedFacilitySlot(SLOTS, cal, null)).toBe('lodge_a|2026-09-21|8');
    expect(findClosedFacilitySlot(SLOTS, cal, undefined)).toBe('lodge_a|2026-09-21|8');
    expect(findClosedFacilitySlot(SLOTS, cal, ['broken', '2026-02-30']))
      .toBe('lodge_a|2026-09-21|8');
  });

  it('facilityClosed が空なら serviceDates の有無に関わらず null（回帰）', () => {
    const empty = calWith([]);
    expect(findClosedFacilitySlot(SLOTS, empty)).toBeNull();
    expect(findClosedFacilitySlot(SLOTS, empty, ['2026-09-20'])).toBeNull();
  });

  it('サウナ連動は serviceDates を渡しても効く', () => {
    const cal = calWith(['sauna|2026-09-20']);
    expect(findClosedFacilitySlot(['sauna_share|2026-09-20|10'], cal, ['2026-09-20']))
      .toBe('sauna_share|2026-09-20|10');
  });
});

// ─────────────────────────────────────────────
// [2] 差分だけを判定する
// ─────────────────────────────────────────────
describe('addedEntries — 現行 config との差分だけを取る（指摘[2]）', () => {
  it('既存に無いものだけ返す', () => {
    expect(addedEntries(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
  });

  it('全部が既存なら空＝警告を出さない（毎回同じ警告が出る形骸化の防止）', () => {
    expect(addedEntries(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('未送信（null / undefined）は「無変更」として空', () => {
    expect(addedEntries(null, ['a'])).toEqual([]);
    expect(addedEntries(undefined, ['a'])).toEqual([]);
  });

  it('現行が空なら送信分がそのまま追加分', () => {
    expect(addedEntries(['sauna|2026-09-20'], [])).toEqual(['sauna|2026-09-20']);
  });

  it('削除（送信配列から消えたもの）は追加分に入らない', () => {
    expect(addedEntries(['a'], ['a', 'b'])).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// [3] 走査範囲の絞り込み
// ─────────────────────────────────────────────
describe('judgedDateRange / scanRangeForJudgedDates — 走査範囲（指摘[3]）', () => {
  it('臨時休業日と施設停止の両方から min/max を出す', () => {
    expect(judgedDateRange(['2026-09-24'], ['sauna|2026-09-20|10', 'room_27|2026-10-01']))
      .toEqual({ min: '2026-09-20', max: '2026-10-01' });
  });

  it('どちらも空なら null（＝1件も読まない）', () => {
    expect(judgedDateRange([], [])).toBeNull();
  });

  it('壊れた要素は範囲に混ぜない', () => {
    expect(judgedDateRange(['broken', '2026-09-20'], ['nonexistent_room|2026-01-01']))
      .toEqual({ min: '2026-09-20', max: '2026-09-20' });
    expect(judgedDateRange(['broken'], ['garbage'])).toBeNull();
  });

  it('宿泊の endDate ぶんの余裕を手前に取る（startDate でしか絞れないため）', () => {
    const r = scanRangeForJudgedDates({ min: '2026-09-20', max: '2026-09-24' });
    expect(r.to).toBe('2026-09-24');
    const from = new Date(r.from + 'T00:00:00Z');
    const min = new Date('2026-09-20T00:00:00Z');
    expect((min.getTime() - from.getTime()) / 86400000).toBe(RESERVATION_LOOKBACK_DAYS);
  });

  it('余裕は宿泊上限（14泊）より十分に広い', () => {
    expect(RESERVATION_LOOKBACK_DAYS).toBeGreaterThan(14);
  });
});

// ─────────────────────────────────────────────
// [5] 切り出した判定本体
// ─────────────────────────────────────────────
describe('collectReservationDates — 占有日（dry-run は広く採る）', () => {
  it('slots の日付と startDate〜endDate の両方を採る（チェックアウト日も含む）', () => {
    const dates = collectReservationDates('2026-09-18', '2026-09-20',
      ['room_27|2026-09-18|16', 'room_27|2026-09-20|8']);
    expect(Array.from(dates).sort())
      .toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  it('slots が空の古い予約でも startDate〜endDate で拾える', () => {
    expect(Array.from(collectReservationDates('2026-09-18', '2026-09-19', [])).sort())
      .toEqual(['2026-09-18', '2026-09-19']);
  });

  it('startDate が壊れていれば slots 由来の日付だけ', () => {
    expect(Array.from(collectReservationDates(undefined, undefined, ['sauna|2026-09-20|10'])))
      .toEqual(['2026-09-20']);
  });
});

describe('reservationHitsClosedSettings', () => {
  const res = toReservationLike('r1', {
    status: 'confirmed', roomIds: ['sauna'],
    slots: ['sauna|2026-09-20|10', 'sauna|2026-09-20|11'],
    startDate: '2026-09-20', endDate: '2026-09-20',
  });

  it('追加された臨時休業日に当たる', () => {
    expect(reservationHitsClosedSettings(res, new Set(['2026-09-20']), calWith([]))).toBe(true);
  });

  it('追加された施設停止に当たる（サウナ連動込み）', () => {
    expect(reservationHitsClosedSettings(res, new Set(), calWith(['sauna_share|2026-09-20'])))
      .toBe(true);
  });

  it('別日・別施設は当たらない', () => {
    expect(reservationHitsClosedSettings(res, new Set(['2026-09-21']), calWith([]))).toBe(false);
    expect(reservationHitsClosedSettings(res, new Set(), calWith(['room_27|2026-09-20'])))
      .toBe(false);
  });

  it('追加分が空なら常に false（＝警告なし）', () => {
    expect(reservationHitsClosedSettings(res, new Set(), calWith([]))).toBe(false);
  });

  it('slots が欠けた予約でも roomIds×占有日で終日停止に当たる', () => {
    const legacy = toReservationLike('old', {
      status: 'confirmed', roomIds: ['sauna'], slots: [],
      startDate: '2026-09-20', endDate: '2026-09-20',
    });
    expect(reservationHitsClosedSettings(legacy, new Set(), calWith(['sauna|2026-09-20'])))
      .toBe(true);
  });
});

describe('toReservationLike — 壊れたドキュメントでも落ちない', () => {
  it('配列でない slots / roomIds は空配列にする', () => {
    const r = toReservationLike('x', { slots: 'nope', roomIds: { a: 1 }, status: 5 });
    expect(r.slots).toEqual([]);
    expect(r.roomIds).toEqual([]);
    expect(r.status).toBe('');
  });

  it('null データでも例外を投げない', () => {
    expect(() => toReservationLike('x', null)).not.toThrow();
  });
});
