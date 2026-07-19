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

/**
 * config/business_calendar をキャッシュなしで直読みする。
 * 予約確定直前の判定に使うため、futamiDays の #16 と同じく fresh 読みに統一。
 */
export async function getBusinessCalendarFresh(): Promise<BusinessCalendar> {
  const doc = await db.doc('config/business_calendar').get();
  const d = (doc.exists ? doc.data() : {}) as any;
  return {
    defaultClosedDays: Array.isArray(d?.defaultClosedDays) ? d.defaultClosedDays : [2],
    forceOpen: Array.isArray(d?.forceOpen) ? d.forceOpen : [],
    forceClosed: Array.isArray(d?.forceClosed) ? d.forceClosed : [],
  };
}

export function isClosedDay(dateStr: string, cal: BusinessCalendar): boolean {
  if (cal.forceClosed.includes(dateStr)) return true;
  if (cal.forceOpen.includes(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  return cal.defaultClosedDays.includes(d.getDay());
}

/**
 * slot の時刻部が「宿泊のチェックアウト翌朝スロット」かを判定する。
 *
 * 宿泊/キャンプの翌朝スロットは endDate に載る（expandStaySlots が checkinHour 未満の
 * 時刻を翌日送りするため）。その時刻は整数時で、stay=0〜9 / camp=0〜12 の早朝帯に限られる。
 * よって「整数時（コロン無し）かつ 0〜12」だけを翌朝スロットとみなす。
 * テニスは "HH:MM"（コロン有り）＝単日サービスなので常に false（翌朝免除の対象外）。
 */
function isCheckoutMorningSlotTime(timeStr: string | undefined): boolean {
  if (!timeStr || timeStr.indexOf(':') !== -1) return false;
  const h = parseInt(timeStr, 10);
  return Number.isInteger(h) && h >= 0 && h <= 12;
}

/**
 * 予約が定休日にかかっていれば、その日付（YYYY-MM-DD）を返す。かからなければ null。
 *
 * 検査対象 = チェックイン日（startDate）＋ 全 slot 日付。
 * ただし endDate 上の「本物のチェックアウト翌朝スロット」（整数早朝時 0〜12）だけは
 * 定休日でも許容する（フロント getMaxNights / proceedToConfirm と同じく、
 * チェックアウト日が定休日でも連泊は成立する仕様に合わせる）。
 *
 * ⚠️ この免除は必ず「slot の時刻」で判定する（2026-07-19 自己レビュー2巡目で厳格化）。
 * endDate を日付だけで無条件除外すると、
 *   (a) 単日予約（テニス "HH:MM"）で startDate=営業日・endDate=slot=定休日 と直叩き、
 *   (b) startDate 側にダミー slot を1つ足して endDate 当日の日中/夜 slot を紛れ込ませる、
 * のいずれでも定休日予約が confirmed 化できてしまう。時刻ベースなら endDate 上の
 * 日中/夜スロット（hour>=13 やテニスの HH:MM）は免除されず検査される。
 */
export function findClosedDayInReservation(
  slots: string[],
  startDate: string,
  endDate: string,
  cal: BusinessCalendar,
): string | null {
  const dates = new Set<string>([startDate]);
  for (const key of slots) {
    const parts = key.split('|');
    const d = parts[1];
    if (!d) continue;
    // endDate 上の早朝チェックアウト slot だけ定休日でも許容。それ以外は必ず検査。
    if (d === endDate && endDate > startDate && isCheckoutMorningSlotTime(parts[2])) continue;
    dates.add(d);
  }
  for (const d of Array.from(dates).sort()) {
    if (isClosedDay(d, cal)) return d;
  }
  return null;
}
