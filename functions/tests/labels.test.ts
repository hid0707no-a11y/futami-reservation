// ふたみの日サウナの通知メールのプラン名（2026-09-23 運営要望）
//
// 「プラン：貸切サウナ（ふたみの日）」だけでは A〜D のどの枠か読めなかった。
// 通常の貸切サウナと同じ枠名と時間帯を足す＝「貸切サウナ D（17:30-19:30）（ふたみの日）」。
// 対象はお客様宛の自動返信メールと管理者宛の予約受付通知メール（createReservation のふたみの日ルート）。

import { canonicalizeReservation } from '../src/lib/reservationPlans';
import { planLabel, futamiSaunaPlanLabel } from '../src/lib/labels';

const FUTAMI_DATE = '2026-10-23';
const futamiSlots = (hours: number[]) => hours.map(h => `sauna_share|${FUTAMI_DATE}|${h}`);

describe('futamiSaunaPlanLabel：ふたみの日サウナのプラン名に枠名と時間帯を出す', () => {
  it('運営の依頼文どおり：D枠は「貸切サウナ D（17:30-19:30）（ふたみの日）」', () => {
    expect(futamiSaunaPlanLabel(futamiSlots([17, 18, 19]))).toBe('貸切サウナ D（17:30-19:30）（ふたみの日）');
  });

  it.each([
    [[10, 11], '貸切サウナ A（10:00-12:00）（ふたみの日）'],
    [[12, 13, 14], '貸切サウナ B（12:30-14:30）（ふたみの日）'],
    [[15, 16], '貸切サウナ C（15:00-17:00）（ふたみの日）'],
    [[17, 18, 19], '貸切サウナ D（17:30-19:30）（ふたみの日）'],
  ])('slots の時 %j → %s（通常の貸切サウナと同じ枠名・時間帯）', (hours, label) => {
    expect(futamiSaunaPlanLabel(futamiSlots(hours))).toBe(label);
  });

  it('slots の並び順に依存しない', () => {
    expect(futamiSaunaPlanLabel(futamiSlots([19, 17, 18]))).toBe('貸切サウナ D（17:30-19:30）（ふたみの日）');
  });

  it('枠に一致しない・形が崩れている時は従来の表記に倒す（メールは止めない）', () => {
    const fallback = planLabel('plan_sauna_futami');
    expect(fallback).toBe('貸切サウナ（ふたみの日）');
    expect(futamiSaunaPlanLabel(futamiSlots([17, 18]))).toBe(fallback);              // 枠の途中まで
    expect(futamiSaunaPlanLabel(futamiSlots([15, 16, 17, 18, 19]))).toBe(fallback);  // 2枠またぎ
    expect(futamiSaunaPlanLabel([])).toBe(fallback);
    expect(futamiSaunaPlanLabel(undefined)).toBe(fallback);
    expect(futamiSaunaPlanLabel(['broken'])).toBe(fallback);
    expect(futamiSaunaPlanLabel([17, 18, 19])).toBe(fallback);                       // キーでなく数値
  });

  it('★在庫の入口（canonicalizeReservation）が受理するふたみの日の枠には、必ず枠名が付く', () => {
    // 枠の時間帯を reservationPlans.ts で変えた時に、ラベルだけ黙って「（ふたみの日）」に戻るのを止める。
    for (const hours of [[10, 11], [12, 13, 14], [15, 16], [17, 18, 19]]) {
      const r = canonicalizeReservation({
        planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
        slots: futamiSlots(hours),
        startDate: FUTAMI_DATE, endDate: FUTAMI_DATE, nights: 0,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(futamiSaunaPlanLabel(r.value.slots)).toMatch(/^貸切サウナ [A-D]（\d{2}:\d{2}-\d{2}:\d{2}）（ふたみの日）$/);
    }
  });
});
