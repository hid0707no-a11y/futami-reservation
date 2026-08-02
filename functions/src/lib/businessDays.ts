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
//
// 2026-08-02 追加：facilityClosed（施設単位の停止）。
// 上の3つは「公園ぜんぶをその日閉じる」ものしか表現できず、「サウナだけその日止める」は
// ダミー予約を入れて塞ぐ運用になっていた（→運営宛メールの大量送信・行政報告用スプシへの
// 架空売上の計上という副作用が出ていた）。facilityClosed は在庫を1件も作らずに止める。
// フロント側の同一ロジックは assets/js/availability.js の NisshoAvailability.isFacilitySlotClosed。

import { db } from './firestore';
import { VALID_ROOM_IDS } from '../constants';

export interface BusinessCalendar {
  defaultClosedDays: number[];
  forceOpen: string[];
  forceClosed: string[];
  /**
   * 施設単位の停止指定（2026-08-02 追加）。
   * 「サウナだけをその日は受け付けない」を、ダミー予約を入れずに表現するための1本。
   * 要素は次の2形式のみ：
   *   "roomId|YYYY-MM-DD"        … その部屋をその日は終日停止
   *   "roomId|YYYY-MM-DD|hour"   … その部屋のその時間だけ停止（hour はゼロ埋めしない 0〜23）
   * 空配列／未設定なら従来と完全に同じ挙動（全ての判定が素通り）。
   */
  facilityClosed: string[];
}

export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 壊れた startDate/endDate で日付展開が暴走しないための上限（damage control）。 */
const MAX_SERVICE_DATE_SPAN_DAYS = 400;

/**
 * 保存済み予約の startDate/endDate から「サービス提供日」を復元する。
 *
 * ★規約は reservationPlans.ts が作る canonical.serviceDates と同じ＝**チェックアウト日は含めない**。
 *     単日プラン（endDate === startDate） → [startDate]
 *     宿泊（endDate > startDate）          → startDate 〜 endDate-1（= 泊まった日だけ）
 * canonical が手元にない経路（changeCampSites など、保存済みドキュメントしか無い所）で
 * findClosedFacilitySlot に渡す serviceDates を作るために使う。
 */
export function serviceDatesFromRange(startDate: unknown, endDate: unknown): string[] {
  if (!isRealIsoDate(startDate)) return [];
  if (!isRealIsoDate(endDate) || endDate <= startDate) return [startDate];
  const dates: string[] = [];
  const cursor = new Date(startDate + 'T00:00:00Z');
  const lastNight = new Date(endDate + 'T00:00:00Z');
  lastNight.setUTCDate(lastNight.getUTCDate() - 1);   // ★チェックアウト日の前日まで
  for (let i = 0; i < MAX_SERVICE_DATE_SPAN_DAYS && cursor.getTime() <= lastNight.getTime(); i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// ─────────────────────────────────────────────
// 施設単位の停止（facilityClosed）
// ─────────────────────────────────────────────
//
// サウナは同じ物理サウナを2つの roomId で運用している：
//   通常日          → roomId = 'sauna'
//   ふたみの日(毎月23日前後) → roomId = 'sauna_share'
// よって片方への停止指定は必ずもう片方にも効かせる。効かせないと「sauna を止めたのに
// ふたみの日プランからは予約できる」という穴になる。
// createReservation.ts の alternateSaunaKeys（在庫の排他）と同じ思想。
const FACILITY_ALIASES: Readonly<Record<string, string>> = {
  sauna: 'sauna_share',
  sauna_share: 'sauna',
};

/** roomId 本体＋連動 roomId（サウナのみ）を返す。 */
function facilityAliases(roomId: string): string[] {
  const alias = Object.prototype.hasOwnProperty.call(FACILITY_ALIASES, roomId)
    ? FACILITY_ALIASES[roomId]
    : undefined;
  return alias ? [roomId, alias] : [roomId];
}

interface FacilityClosedEntry {
  roomId: string;
  date: string;
  /** null = 終日停止 */
  hour: number | null;
}

/**
 * facilityClosed の1要素を解釈する。契約外の形は null（＝捨てる）。
 * hour は slots コレクションのキーと同形式＝ゼロ埋めしない 0〜23 の整数文字列のみ許可する
 * （"08" を許すとサーバとフロントで正規化がずれ、片方だけ停止が効く状態を作る）。
 */
export function parseFacilityClosedEntry(value: unknown): FacilityClosedEntry | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('|');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const roomId = parts[0];
  const date = parts[1];
  if (!roomId || !VALID_ROOM_IDS.has(roomId)) return null;
  if (!isRealIsoDate(date)) return null;
  if (parts.length === 2) return { roomId, date, hour: null };
  const hourPart = parts[2];
  if (!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hourPart || '')) return null;
  return { roomId, date, hour: Number(hourPart) };
}

/** facilityClosed の1要素として保存してよい文字列か（availability の POST 検証用）。 */
export function isValidFacilityClosedEntry(value: unknown): value is string {
  return parseFacilityClosedEntry(value) !== null;
}

/** facilityClosed の最大件数（1施設×1年×24時間でも足りる余裕を見た上限）。 */
export const FACILITY_CLOSED_MAX = 2000;

/** POST /businessCalendar の facilityClosed が丸ごと保存してよい形か。 */
export function isValidFacilityClosedList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= FACILITY_CLOSED_MAX
    && value.every(isValidFacilityClosedEntry);
}

/**
 * slotKey の時間部分を「時」に正規化する。
 *   通常室・サウナ … "10" / "8"（ゼロ埋めなし整数）
 *   テニス         … "0800" / "0830"（HHMM）→ 先頭2桁を時として解釈
 *   旧staff形式    … "08" / "8:30" も同様に時だけ取る
 * 解釈できなければ null（＝時間指定の停止には当たらない。終日停止の判定は別途行う）。
 */
function normalizeSlotHour(hour: unknown): number | null {
  if (typeof hour === 'number') {
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  }
  if (typeof hour !== 'string' || hour === '') return null;
  let raw = hour;
  if (/^\d{4}$/.test(raw)) raw = raw.slice(0, 2);           // HHMM
  else if (/^\d{1,2}:\d{2}$/.test(raw)) raw = raw.split(':')[0]; // H:MM（旧形式）
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= 23 ? n : null;
}

/**
 * その部屋・その日・その時間が停止されているか。純粋関数。
 *
 * hour に null / undefined を渡した場合は「終日停止が入っているか」だけを見る
 * （時間単位の停止は、どの時間を訊かれているか分からないので当てない）。
 */
export function isFacilitySlotClosed(
  roomId: string,
  date: string,
  hour: string | number | null | undefined,
  cal: BusinessCalendar,
): boolean {
  const entries = cal?.facilityClosed;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  if (typeof roomId !== 'string' || !roomId || typeof date !== 'string' || !date) return false;
  const targets = new Set(facilityAliases(roomId));
  const targetHour = normalizeSlotHour(hour);
  for (const raw of entries) {
    const entry = parseFacilityClosedEntry(raw);
    if (!entry) continue;
    if (entry.date !== date || !targets.has(entry.roomId)) continue;
    if (entry.hour === null) return true;
    if (targetHour !== null && entry.hour === targetHour) return true;
  }
  return false;
}

/**
 * slotKey 群（"roomId|date|hour" 形式。テニスは "court_x|date|HHMM"）のうち、
 * 停止指定に当たった最初のキーを返す。無ければ null。
 *
 * ─────────────────────────────────────────────
 * ★★ どちらの日を見ているか（この関数で唯一ややこしい所）★★
 * ─────────────────────────────────────────────
 *   終日キー "roomId|date"       → **serviceDates（サービス提供日）** で突合する。
 *   時間キー "roomId|date|hour"  → **slotKeys 全件** で突合する。
 *
 * 分ける理由：宿泊プランの slots はチェックアウト日の早朝（0〜9時）ぶんが翌日側の日付で載る。
 * 例）9/18 から2泊（チェックアウト 9/20）→ slots の日付は 9/18・9/19・9/20 の3日。
 *     serviceDates は 9/18・9/19 の2日（＝泊まった日だけ。reservationPlans.ts が生成）。
 * ここで終日キーまで slots 全件で見ると、room_27 を 9/20 終日停止にしただけで
 * 「9/20 に**チェックアウトするだけ**の宿泊」まで作れなくなる。
 * 既存の定休日判定 findClosedDayInServiceDates が意図的にチェックアウト日を検査対象から
 * 外している規約に、終日停止も揃える。
 * 一方で「9/20 の朝8時だけ止める」という時間指定は、まさにチェックアウト日の早朝を
 * 止めたいケースなので従来どおり slots 全件で当てる。
 *
 * @param serviceDates 省略・null・空なら **従来どおり終日キーも slotKeys 全件で突合**する
 *                     （導入時からの呼び出し `findClosedFacilitySlot(slots, cal)` の後方互換。
 *                       未指定時は「余計に止める＝予約を通さない」安全側に倒れる）。
 *
 * 停止指定は高々2000件・slot は長期宿泊で1000件規模になり得るので、
 * 先に索引（終日 Set / 時間 Set）を組んでから slot 側を1回走査する。
 * 索引作成の時点でサウナの連動 roomId へ展開しておくので、突合は素の文字列一致で済む。
 */
export function findClosedFacilitySlot(
  slotKeys: string[],
  cal: BusinessCalendar,
  serviceDates?: string[] | null,
): string | null {
  const entries = cal?.facilityClosed;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (!Array.isArray(slotKeys) || slotKeys.length === 0) return null;

  const allDay = new Set<string>();
  const byHour = new Set<string>();
  for (const raw of entries) {
    const entry = parseFacilityClosedEntry(raw);
    if (!entry) continue;
    for (const rid of facilityAliases(entry.roomId)) {
      if (entry.hour === null) allDay.add(`${rid}|${entry.date}`);
      else byHour.add(`${rid}|${entry.date}|${entry.hour}`);
    }
  }
  if (allDay.size === 0 && byHour.size === 0) return null;

  // 終日キーを当ててよい日の集合。null = 「日を絞らない」＝ slotKeys の日付をそのまま使う。
  let serviceDateSet: Set<string> | null = null;
  if (Array.isArray(serviceDates)) {
    const s = new Set(serviceDates.filter(isRealIsoDate));
    // 空 or 全部壊れていた場合は「絞れない」とみなして従来動作へ戻す（止め漏らさない側）。
    serviceDateSet = s.size > 0 ? s : null;
  }

  for (const key of slotKeys) {
    if (typeof key !== 'string' || !key) continue;
    const parts = key.split('|');
    const roomId = parts[0];
    const date = parts[1];
    if (!roomId || !date) continue;
    // ① 終日停止：サービス提供日だけを見る（＝チェックアウト日の slot はここを素通りする）
    if ((serviceDateSet === null || serviceDateSet.has(date))
        && allDay.has(`${roomId}|${date}`)) return key;
    // ② 時間指定の停止：slot の日付をそのまま見る（チェックアウト日の早朝ぶんも当たる）
    const hour = normalizeSlotHour(parts[2]);
    if (hour !== null && byHour.has(`${roomId}|${date}|${hour}`)) return key;
  }
  return null;
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
    facilityClosed: Array.isArray(data?.facilityClosed)
      ? (data.facilityClosed as unknown[]).filter(isValidFacilityClosedEntry)
      : [],
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
