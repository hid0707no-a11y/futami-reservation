/**
 * サウナ予約の日付・時間枠・人数の変更（職員のみ・2026-10-16 運営要望②）
 *
 * 運営の声：「予約内容の変更の際、一度キャンセルして入力し直しているので、
 *   すべての項目の変更が運営者権限でいじれるようにしたい」
 *
 * お客様情報・備考・お支払いは従来どおり updateReservation が直す。ここが受け持つのは
 * 在庫（slots）の取り直しが要る「日付・時間枠・人数」だけ。
 *
 * ★キャンセル→取り直しとの違い：予約ID・予約番号（displayId）・作成日時・お客様情報が残る。
 *   取り直すと予約番号が変わり、お客様に伝えた番号と台帳が食い違っていた。
 * ★通常日 ⇄ ふたみの日 の切替はサーバが決める（日付が config/special_days に入っているか）。
 *   画面の申告は信用しない＝createReservation と同じ。
 * ★料金：職員が作った予約（pricing=null）は null のまま。公開画面で作られた予約は、
 *   保存済みのオプション（タオル等）と市民区分を引き継いでサーバで計算し直す
 *   （ふたみの日は人数で金額が変わるため、古い金額を残すと台帳の「合計金額」がずれる）。
 *
 * ここは純粋関数だけ。Firestore の読み書きは handlers/changeSaunaReservation.ts。
 */

import { canonicalizeReservation, CanonicalReservation } from './reservationPlans';
import { isRealIsoDate } from './businessDays';
import { computeServerPricing } from './pricingServer';

/** 時間枠（A〜D）。ふたみの日も同じ4枠（reservationPlans の FUTAMI_SAUNA_HOURS と同じ時間）。 */
export const SAUNA_FRAME_HOURS: Readonly<Record<string, readonly number[]>> = {
  sauna_1: [10, 11],      // A 10:00-12:00
  sauna_2: [12, 13, 14],  // B 12:30-14:30
  sauna_3: [15, 16],      // C 15:00-17:00
  sauna_4: [17, 18, 19],  // D 17:30-19:30
};

export interface SaunaChangeRequest {
  id: string;
  startDate: string;
  frame: string;      // sauna_1〜sauna_4
  guestCount: number; // 1〜8（ふたみの日は 2〜8）
}

export type SaunaChangeValidation =
  | { ok: true; value: SaunaChangeRequest }
  | { ok: false; error: string; detail?: string };

/**
 * 入力検証（★4：型・長さ・ホワイトリスト）。body の他のキーは読まない＝素通しにしない。
 * 受付期間（90日）と4時間前の締切は職員なので見ない（要望①）。過去日だけは職員でも拒否する
 * （createReservation と同じ＝年の打ち間違いを静かに通さない）。
 */
export function validateSaunaChangeBody(body: any, now: Date = new Date()): SaunaChangeValidation {
  const id = body?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return { ok: false, error: 'id_required' };
  }
  const startDate = body?.startDate;
  if (!isRealIsoDate(startDate)) return { ok: false, error: 'invalid_date_format' };
  const todayJst = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (startDate < todayJst) return { ok: false, error: 'booking_in_past' };

  const frame = body?.frame;
  if (typeof frame !== 'string' || !Object.prototype.hasOwnProperty.call(SAUNA_FRAME_HOURS, frame)) {
    return { ok: false, error: 'invalid_frame' };
  }
  const guestCount = body?.guestCount;
  if (!Number.isSafeInteger(guestCount) || guestCount < 1 || guestCount > 8) {
    return { ok: false, error: 'invalid_guest_count', detail: '1〜8人' };
  }
  return { ok: true, value: { id, startDate, frame, guestCount } };
}

/** 保存済みの予約がサウナ（通常 or ふたみの日）か。他の施設はこの経路で触らせない。 */
export function isStoredSaunaReservation(cur: any): boolean {
  const roomIds = Array.isArray(cur?.roomIds) ? cur.roomIds : [];
  if (roomIds.length !== 1) return false;
  const planId = cur?.planId;
  if (roomIds[0] === 'sauna') return typeof planId === 'string' && /^sauna_[1-4]$/.test(planId);
  if (roomIds[0] === 'sauna_share') return planId === 'plan_sauna_futami';
  return false;
}

export type SaunaTargetResult =
  | { ok: true; value: CanonicalReservation }
  | { ok: false; error: string; detail?: string };

/**
 * 変更後の予約を、createReservation と同じ canonicalize で組み立てる
 * （在庫キーの作り方を2か所に持たない）。
 */
export function buildSaunaTarget(req: SaunaChangeRequest, isFutamiDay: boolean): SaunaTargetResult {
  if (isFutamiDay && req.guestCount < 2) {
    return { ok: false, error: 'invalid_guest_count', detail: 'ふたみの日は2〜8人' };
  }
  const room = isFutamiDay ? 'sauna_share' : 'sauna';
  const hours = SAUNA_FRAME_HOURS[req.frame];
  const result = canonicalizeReservation({
    planId: isFutamiDay ? 'plan_sauna_futami' : req.frame,
    roomIds: [room],
    slots: hours.map(h => `${room}|${req.startDate}|${h}`),
    startDate: req.startDate,
    endDate: req.startDate,
    nights: 0,
  });
  if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
  return { ok: true, value: result.value };
}

/** 通常サウナとふたみの日は同じ時間に同時に入れない＝反対側のキーも空きを確かめる。 */
export function oppositeSaunaKeys(slots: readonly string[]): string[] {
  return slots.map(key => {
    const [room, date, hour] = key.split('|');
    return `${room === 'sauna' ? 'sauna_share' : 'sauna'}|${date}|${hour}`;
  });
}

/** 旧slotと新slotの差分。重なる slot は消さずに残す（同じ予約が持ち続ける）。 */
export function diffSlots(oldSlots: readonly string[], newSlots: readonly string[]) {
  const oldSet = new Set(oldSlots);
  const newSet = new Set(newSlots);
  return {
    toDelete: oldSlots.filter(k => !newSet.has(k)),
    toWrite: newSlots.filter(k => !oldSet.has(k)),
  };
}

/**
 * 変更後の料金。職員が作った予約（pricing=null）は null のまま
 * （市民/市外が分からないので埋めない＝createReservation と同じ方針）。
 */
export function recomputeSaunaPricing(cur: any, target: CanonicalReservation, guestCount: number): any | null {
  if (!cur?.pricing || typeof cur.pricing !== 'object') return null;
  return computeServerPricing(target, {
    guests: cur.guests || undefined,
    isResident: cur.customer?.isMember === true,
    declaredPricing: { saunaOptions: cur.pricing.saunaOptions || {} },
    guestCount,
  }).pricing;
}
