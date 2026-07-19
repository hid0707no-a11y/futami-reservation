import {
  businessCalendarFromData,
  findClosedDayInServiceDates,
  isClosedDay,
} from '../src/lib/businessDays';

describe('businessDays', () => {
  const cal = {
    defaultClosedDays: [2],
    forceOpen: ['2026-08-04'],
    forceClosed: ['2026-08-05'],
  };

  it('forceClosedを最優先しforceOpenで定休日を営業日にする', () => {
    expect(isClosedDay('2026-08-05', cal)).toBe(true);
    expect(isClosedDay('2026-08-04', cal)).toBe(false);
    expect(isClosedDay('2026-08-11', cal)).toBe(true);
  });

  it('中間宿泊日の定休日を検出しcheckout日は検査対象外にできる', () => {
    expect(findClosedDayInServiceDates(['2026-08-03','2026-08-04','2026-08-05'], {
      defaultClosedDays: [2], forceOpen: [], forceClosed: [],
    })).toBe('2026-08-04');
    expect(findClosedDayInServiceDates(['2026-08-03'], {
      defaultClosedDays: [2], forceOpen: [], forceClosed: [],
    })).toBeNull();
  });

  it('欠落設定は安全な既定値へ正規化する', () => {
    expect(businessCalendarFromData(null)).toEqual({
      defaultClosedDays: [2], forceOpen: [], forceClosed: [],
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
    });
  });

  it('曜日設定の重複は除去し、空配列は「定休なし」として保持する', () => {
    expect(businessCalendarFromData({ defaultClosedDays: [2, 2, 6] }).defaultClosedDays)
      .toEqual([2, 6]);
    expect(businessCalendarFromData({ defaultClosedDays: [] }).defaultClosedDays)
      .toEqual([]);
  });
});
