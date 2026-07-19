// 営業カレンダー判定（定休日チェック・Firestore /config/business_calendar 参照）
//
// 2026-07-19 新設（セキュリティバッチ）。
// 従来、定休日チェックはフロント（index.html の月間カレンダー経路）にしか存在せず、
// 日付検索・日付直接入力・API 直叩きでは定休日に予約が確定できた。
// createReservation の最終防衛としてサーバ側でも判定する。
//
// 判定ロジックは index.html の isClosedDay() と同一仕様：
//   1. forceClosed に含まれる → 休み
//   2. forceOpen に含まれる → 営業
//   3. defaultClosedDays（曜日番号・既定は火曜=2）で判定

import { db } from './firestore';

export interface BusinessCalendar {
  defaultClosedDays: number[];
  forceOpen: string[];
  forceClosed: string[];
}

function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function businessCalendarFromData(data: any): BusinessCalendar {
  const rawClosedDays = data?.defaultClosedDays;
  const defaultClosedDays = Array.isArray(rawClosedDays)
    && rawClosedDays.every((day: unknown) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    ? Array.from(new Set(rawClosedDays as number[]))
    : [2];
  return {
    defaultClosedDays,
    forceOpen: Array.isArray(data?.forceOpen) ? data.forceOpen.filter(isRealIsoDate) : [],
    forceClosed: Array.isArray(data?.forceClosed) ? data.forceClosed.filter(isRealIsoDate) : [],
  };
}

/**
 * config/business_calendar をキャッシュなしで直読みする。
 * 予約確定直前の判定に使うため、futamiDays の #16 と同じく fresh 読みに統一。
 */
export async function getBusinessCalendarFresh(): Promise<BusinessCalendar> {
  const doc = await db.doc('config/business_calendar').get();
  return businessCalendarFromData(doc.exists ? doc.data() : {});
}

export function isClosedDay(dateStr: string, cal: BusinessCalendar): boolean {
  if (cal.forceClosed.includes(dateStr)) return true;
  if (cal.forceOpen.includes(dateStr)) return false;
  // Functions の実行環境・ローカル端末のTZに依存させない。YYYY-MM-DDをUTC日付として扱えば
  // 同じ曜日番号になり、JST端末とCloud Functionsで判定がずれない。
  const d = new Date(dateStr + 'T00:00:00Z');
  return cal.defaultClosedDays.includes(d.getUTCDay());
}

/**
 * 正規化済みのサービス提供日が定休日にかかっていれば、その日付を返す。
 *
 * serviceDates は reservationPlans.ts がプラン定義と泊数から生成する。
 * 単日プランは startDate のみ、宿泊は各宿泊日（startDate〜checkout前日）を含み、
 * checkout 日は含めない。クライアント申告slotの時刻からcheckoutを推測しないため、
 * 午前の日帰り偽装や中間日のslot省略では検査対象を減らせない。
 */
export function findClosedDayInServiceDates(
  serviceDates: string[],
  cal: BusinessCalendar,
): string | null {
  for (const d of Array.from(new Set(serviceDates)).sort()) {
    if (isClosedDay(d, cal)) return d;
  }
  return null;
}
