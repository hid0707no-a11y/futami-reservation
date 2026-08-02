// 休館・停止設定の「影響予約」判定（純粋関数のみ・Firestore に触らない）
//
// 2026-08-02 新設。元は handlers/availability.ts に直書きされていた dry-run のロジックを
// lib へ切り出したもの（handlers は入力検証とレスポンス整形だけ、の3層分割に揃える）。
// Firestore を読む側は services/calendarImpact.ts。
//
// 何のための判定か：
//   2026-09-24 に臨時休業日を追加した際、その日に既に入っていた有料予約が取り残された
//   （画面からは消えたのに予約自体は生きていた）。保存前に「この設定にすると矛盾する
//   既存予約」を職員へ見せるための読取専用の突合。

import {
  BusinessCalendar,
  findClosedFacilitySlot,
  isRealIsoDate,
  parseFacilityClosedEntry,
} from './businessDays';

/** 壊れた startDate/endDate で日付展開が暴走しないための上限。 */
export const MAX_RESERVATION_SPAN_DAYS = 400;

/**
 * 走査の前後に見込む余裕日数。
 * 予約は startDate でしか範囲を絞れないので、「判定対象日に endDate だけがかかる宿泊」を
 * 取りこぼさないよう、判定対象日の手前へこの日数ぶん遡って読む。
 * 宿泊プランの上限は reservationPlans.ts の maxNights（既定14泊）なので 60 日あれば
 * 職員手入力の長期予約まで含めて十分な余裕がある。
 */
export const RESERVATION_LOOKBACK_DAYS = 60;

/** dry-run 1回あたりの読み取り上限（超えたら truncated を立てて職員に伝える）。 */
export const DRY_RUN_SCAN_LIMIT = 3000;

/** 影響予約の返却上限（件数だけは count で全数を返す）。 */
export const DRY_RUN_AFFECTED_LIMIT = 50;

/** 職員画面に返す1件分。 */
export interface AffectedReservation {
  displayId: string;
  planId: string;
  roomIds: string[];
  startDate: string;
  customerName: string;
  total: number | null;
}

/** Firestore の予約ドキュメント（any）から必要な形だけ取り出したもの。 */
export interface ReservationLike {
  id: string;
  status: string;
  slots: string[];
  roomIds: string[];
  startDate: unknown;
  endDate: unknown;
  data: any;
}

export function addDaysUtc(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Firestore の生ドキュメントを、判定しやすい形へ正規化する。 */
export function toReservationLike(id: string, data: any): ReservationLike {
  return {
    id,
    status: typeof data?.status === 'string' ? data.status : '',
    slots: Array.isArray(data?.slots)
      ? data.slots.filter((s: unknown): s is string => typeof s === 'string') : [],
    roomIds: Array.isArray(data?.roomIds)
      ? data.roomIds.filter((r: unknown): r is string => typeof r === 'string') : [],
    startDate: data?.startDate,
    endDate: data?.endDate,
    data,
  };
}

/**
 * 予約が占有している日付の集合。
 *
 * ★ここは「サービス提供日」ではなく **占有日**（チェックアウト日を含む）を採る。
 * dry-run は予約をブロックするのではなく職員に警告を出すだけなので、
 * createReservation の判定（businessDays.findClosedFacilitySlot がチェックアウト日を
 * 終日停止から外す）より広く採って取りこぼさない側に倒す。
 *
 * slots の日付（宿泊はチェックアウト日の早朝分を含む）と startDate〜endDate の両方を採る。
 * slots が欠けた古い予約でも startDate〜endDate 側で拾えるようにするため。
 */
export function collectReservationDates(
  startDate: unknown,
  endDate: unknown,
  slots: string[],
): Set<string> {
  const dates = new Set<string>();
  for (const slot of slots) {
    const d = slot.split('|')[1];
    if (isRealIsoDate(d)) dates.add(d);
  }
  if (!isRealIsoDate(startDate)) return dates;
  dates.add(startDate);
  if (!isRealIsoDate(endDate) || endDate < startDate) return dates;
  const cursor = new Date(startDate + 'T00:00:00Z');
  const last = new Date(endDate + 'T00:00:00Z');
  for (let i = 0; i < MAX_RESERVATION_SPAN_DAYS && cursor.getTime() <= last.getTime(); i++) {
    dates.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * 今回判定する日付（＝追加される臨時休業日＋追加される施設停止の日）の min/max。
 * 何も追加されないなら null。走査範囲を絞るために使う。
 */
export function judgedDateRange(
  addedForceClosed: string[],
  addedFacilityClosed: string[],
): { min: string; max: string } | null {
  const dates: string[] = [];
  for (const d of addedForceClosed) if (isRealIsoDate(d)) dates.push(d);
  for (const raw of addedFacilityClosed) {
    const entry = parseFacilityClosedEntry(raw);
    if (entry) dates.push(entry.date);
  }
  if (dates.length === 0) return null;
  // ISO 8601 の YYYY-MM-DD は辞書順＝時系列順
  let min = dates[0];
  let max = dates[0];
  for (const d of dates) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/**
 * startDate だけで絞り込むためのクエリ範囲。
 * 複合インデックスを要求しないよう status は入れず、status の絞り込みはメモリ側で行う。
 */
export function scanRangeForJudgedDates(
  range: { min: string; max: string },
): { from: string; to: string } {
  return { from: addDaysUtc(range.min, -RESERVATION_LOOKBACK_DAYS), to: range.max };
}

/**
 * この予約が、追加される設定と矛盾するか。
 * closedDaySet …「今回追加される」臨時休業日（既に入っている日は渡さないこと）
 * probeCal     … facilityClosed に「今回追加される」停止キーだけを載せたカレンダー
 */
export function reservationHitsClosedSettings(
  reservation: ReservationLike,
  closedDaySet: Set<string>,
  probeCal: BusinessCalendar,
): boolean {
  const dates = collectReservationDates(reservation.startDate, reservation.endDate, reservation.slots);

  if (closedDaySet.size > 0) {
    for (const d of dates) if (closedDaySet.has(d)) return true;
  }
  if (probeCal.facilityClosed.length === 0) return false;

  // slots は時間指定の停止まで当てられる。roomId|date の2要素キーは終日停止用の保険
  //（slots が空／欠けた予約でも部屋×日で当たるようにする）。
  // 第3引数（serviceDates）は渡さない＝終日停止も占有日全件で見る。上の collectReservationDates
  // のコメントどおり、警告は広く出す側に倒すため。
  const probeKeys = reservation.slots.slice();
  for (const roomId of reservation.roomIds) {
    for (const d of dates) probeKeys.push(`${roomId}|${d}`);
  }
  return findClosedFacilitySlot(probeKeys, probeCal) !== null;
}

/** 職員画面に返す形へ整形する。 */
export function toAffectedReservation(reservation: ReservationLike): AffectedReservation {
  const data = reservation.data || {};
  return {
    displayId: typeof data.displayId === 'string' ? data.displayId : reservation.id,
    planId: typeof data.planId === 'string' ? data.planId : '',
    roomIds: reservation.roomIds,
    startDate: typeof data.startDate === 'string' ? data.startDate : '',
    customerName: typeof data.customer?.name === 'string' ? data.customer.name : '',
    total: typeof data.pricing?.total === 'number' ? data.pricing.total : null,
  };
}

/**
 * 「今回追加されるぶん」だけを取り出す。
 *
 * ★差分で見るのが肝。staff2 は保存のたびに CAL_SETTINGS 全体を送ってくるので、
 * 送られてきた配列をまるごと判定すると、過去に承知のうえで残した停止が1件でもある限り
 * 以後すべての操作で同じ警告が出続け、職員が確認ダイアログを読まなくなる（警告の形骸化）。
 * 臨時休業日（forceClosed）は導入時からこの形で、facilityClosed だけが全件判定になっていた。
 */
export function addedEntries(next: string[] | null | undefined, current: string[]): string[] {
  if (!Array.isArray(next)) return [];
  const currentSet = new Set(current);
  return next.filter(v => !currentSet.has(v));
}
