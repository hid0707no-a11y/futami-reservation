// Public reservation plan security catalogue.
//
// The browser owns presentation, but the server must own BOTH the inventory
// shape (here) AND pricing (lib/pricingServer.ts, added 2026-07-20 for #17).
// A caller-provided planId/roomIds/slots tuple is accepted only when it can be
// reduced to one canonical reservation described here; the resulting canonical
// plan/slots then drive the server-authoritative price recomputation so a
// client-declared pricing.total (e.g. tampered to 1 yen) is never trusted.

const STAY_HOURS = [16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const CAMP_HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const SIX_TATAMI_ROOMS = ['room_6_1', 'room_6_2', 'room_6_3', 'room_6_4'] as const;
const ALL_STAY_ROOMS = [...SIX_TATAMI_ROOMS, 'room_27', 'room_exp'] as const;
const CAMP_ROOMS = ['camp_1', 'camp_2', 'camp_3', 'camp_4', 'camp_5', 'camp_6', 'camp_7', 'camp_8'] as const;
const LODGE_ROOMS = ['lodge_a', 'lodge_b'] as const;
const COURT_ROOMS = ['court_1', 'court_2', 'court_3', 'court_4', 'court_5'] as const;
// 壁打ち練習用の半面コート（1つのみ）。コートA〜Eとは別の独立施設なので専用在庫。
// 同時間帯に全面(court_1〜5)と併存可・半面2件目は同一slotキー競合で409になる。
const WALL_COURT_ROOMS = ['court_wall'] as const;

type RuleKind = 'overnight' | 'fixed_day' | 'hourly_day' | 'tennis' | 'futami_sauna';

interface PlanRule {
  kind: RuleKind;
  rooms: readonly string[];
  hours?: readonly number[];
  maxRooms: number;
  maxNights?: number;
  requireAllRooms?: boolean;
}

const rule = (
  kind: RuleKind,
  rooms: readonly string[],
  hours: readonly number[] | undefined,
  maxRooms = 1,
  extra: Pick<PlanRule, 'maxNights' | 'requireAllRooms'> = {},
): PlanRule => ({ kind, rooms, hours, maxRooms, ...extra });

export const RESERVATION_PLAN_RULES: Readonly<Record<string, PlanRule>> = {
  stay_6: rule('overnight', SIX_TATAMI_ROOMS, STAY_HOURS, 4, { maxNights: 14 }),
  stay_27: rule('overnight', ['room_27'], STAY_HOURS, 1, { maxNights: 14 }),
  stay_exp: rule('overnight', ['room_exp'], STAY_HOURS, 1, { maxNights: 14 }),
  stay_all: rule('overnight', ALL_STAY_ROOMS, STAY_HOURS, ALL_STAY_ROOMS.length, {
    maxNights: 14,
    requireAllRooms: true,
  }),

  day_6_all: rule('fixed_day', SIX_TATAMI_ROOMS, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
  day_27_am: rule('fixed_day', ['room_27'], [8, 9, 10, 11]),
  day_27_pm: rule('fixed_day', ['room_27'], [12, 13, 14, 15, 16]),
  day_27_eve: rule('fixed_day', ['room_27'], [17, 18, 19, 20, 21]),
  day_27_daytime: rule('fixed_day', ['room_27'], [8, 9, 10, 11, 12, 13, 14, 15, 16]),
  day_27_all: rule('fixed_day', ['room_27'], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
  day_exp_am: rule('fixed_day', ['room_exp'], [8, 9, 10, 11]),
  day_exp_pm: rule('fixed_day', ['room_exp'], [12, 13, 14, 15, 16]),
  day_exp_eve: rule('fixed_day', ['room_exp'], [17, 18, 19, 20, 21]),
  day_exp_daytime: rule('fixed_day', ['room_exp'], [8, 9, 10, 11, 12, 13, 14, 15, 16]),
  day_exp_all: rule('fixed_day', ['room_exp'], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
  day_train_am: rule('fixed_day', ['room_train'], [8, 9, 10, 11]),
  day_train_pm: rule('fixed_day', ['room_train'], [12, 13, 14, 15, 16]),
  day_train_eve: rule('fixed_day', ['room_train'], [17, 18, 19, 20, 21]),
  day_train_daytime: rule('fixed_day', ['room_train'], [8, 9, 10, 11, 12, 13, 14, 15, 16]),
  day_train_all: rule('fixed_day', ['room_train'], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
  day_kitchen: rule('fixed_day', ['room_kitchen'], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),

  // ★区画上限は 8（＝全区画。2026-08-25 運営要望③で 3 から解放）。
  //   泊数は maxNights:3 のままだが、1区画1泊が23slotなので 8区画×3泊=552slot となり
  //   validation.ts の slots 上限(499)と Firestore トランザクションの 500 writes を超える。
  //   実運用の上限は「8区画なら2泊 / 7区画なら3泊」（運営合意済み）で、
  //   公開画面は index.html の getMaxNights() が transactionCap から自動で泊数を下げる。
  camp_stay: rule('overnight', CAMP_ROOMS, CAMP_HOURS, 8, { maxNights: 3 }),
  lodge_stay: rule('overnight', LODGE_ROOMS, STAY_HOURS, 1, { maxNights: 14 }),
  lodge_day: rule('hourly_day', LODGE_ROOMS, [10, 11, 12, 13, 14, 15]),
  tennis_full: rule('tennis', COURT_ROOMS, undefined, COURT_ROOMS.length),
  tennis_half: rule('tennis', WALL_COURT_ROOMS, undefined, 1),

  midori_am: rule('fixed_day', ['midori'], [8, 9, 10, 11]),
  midori_pm: rule('fixed_day', ['midori'], [12, 13, 14, 15, 16]),
  midori_day: rule('fixed_day', ['midori'], [8, 9, 10, 11, 12, 13, 14, 15, 16]),
  midori_eve: rule('fixed_day', ['midori'], [17, 18, 19, 20, 21]),

  sauna_1: rule('fixed_day', ['sauna'], [10, 11]),
  sauna_2: rule('fixed_day', ['sauna'], [12, 13, 14]),
  sauna_3: rule('fixed_day', ['sauna'], [15, 16]),
  sauna_4: rule('fixed_day', ['sauna'], [17, 18, 19]),
  plan_sauna_futami: rule('futami_sauna', ['sauna_share'], undefined),
};

const FUTAMI_SAUNA_HOURS: readonly (readonly number[])[] = [
  [10, 11],
  [12, 13, 14],
  [15, 16],
  [17, 18, 19],
];

export interface CanonicalReservation {
  planId: string;
  kind: RuleKind;
  roomIds: string[];
  slots: string[];
  startDate: string;
  endDate: string;
  nights: number;
  serviceDates: string[];
}

export type CanonicalReservationResult =
  | { ok: true; value: CanonicalReservation }
  | { ok: false; error: string; detail?: string };

function addDaysUtc(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === a.length && b.every(v => set.has(v));
}

function validateRooms(roomIds: string[], planRule: PlanRule): CanonicalReservationResult | null {
  if (new Set(roomIds).size !== roomIds.length) {
    return { ok: false, error: 'duplicate_roomId' };
  }
  if (roomIds.length === 0 || roomIds.length > planRule.maxRooms
      || roomIds.some(id => !planRule.rooms.includes(id))) {
    return { ok: false, error: 'plan_room_mismatch' };
  }
  if (planRule.requireAllRooms && !sameStringSet(roomIds, planRule.rooms)) {
    return { ok: false, error: 'plan_room_mismatch', detail: 'all_rooms_required' };
  }
  return null;
}

function expectedFixedSlots(roomIds: string[], date: string, hours: readonly number[]): string[] {
  const result: string[] = [];
  for (const roomId of roomIds) {
    for (const hour of hours) result.push(`${roomId}|${date}|${hour}`);
  }
  return result;
}

function expectedOvernightSlots(
  roomIds: string[],
  startDate: string,
  nights: number,
  hours: readonly number[],
): string[] {
  const result: string[] = [];
  const checkinHour = hours[0];
  for (const roomId of roomIds) {
    for (let night = 0; night < nights; night++) {
      const checkinDate = addDaysUtc(startDate, night);
      const checkoutDate = addDaysUtc(startDate, night + 1);
      for (const hour of hours) {
        result.push(`${roomId}|${hour < checkinHour ? checkoutDate : checkinDate}|${hour}`);
      }
    }
  }
  return result;
}

function validateHourlyDaySlots(
  slots: string[],
  roomId: string,
  date: string,
  allowedHours: readonly number[],
): string[] | null {
  const normalized: string[] = [];
  for (const slot of slots) {
    const [slotRoom, slotDate, time] = slot.split('|');
    if (slotRoom !== roomId || slotDate !== date || !/^(?:[0-9]|1[0-9]|2[0-3])$/.test(time || '')) return null;
    const hour = Number(time);
    if (!allowedHours.includes(hour)) return null;
    normalized.push(`${roomId}|${date}|${hour}`);
  }
  return normalized.length > 0 && new Set(normalized).size === normalized.length ? normalized : null;
}

// テニス枠として受理する 30分刻みの時刻。
// ★下限は 8:30（2026-08-25 運営要望⑦）。公園の開場が8:30なので 8:00〜9:00 の枠を廃止した。
//   画面（index.html の hourlyRange.startMin / staff.html の allowedHours）だけを直しても
//   API直叩きと旧キャッシュ画面から 0800 が通るため、在庫の正本であるここでも弾く。
//   ★既存の 0800 予約データは壊れない＝canonicalize は createReservation でしか走らず、
//     保存済み予約の再検証・スプシ同期・キャンセルはこの関数を通らない。
const TENNIS_FIRST_START_MIN = 8 * 60 + 30; // 08:30
const TENNIS_LAST_START_MIN = 21 * 60 + 30; // 21:30（終了22:00）

function tennisMinutes(time: string): number | null {
  if (!/^\d{4}$/.test(time)) return null;
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const total = hour * 60 + minute;
  return (minute === 0 || minute === 30)
    && total >= TENNIS_FIRST_START_MIN && total <= TENNIS_LAST_START_MIN ? total : null;
}

function hhmm(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return String(hour).padStart(2, '0') + String(minute).padStart(2, '0');
}

function normalizeTennisSlots(
  inputPlanId: string,
  roomIds: string[],
  slots: string[],
  date: string,
): string[] | null {
  const byRoom = new Map<string, string[]>();
  for (const roomId of roomIds) byRoom.set(roomId, []);

  const legacyIntegerFormat = inputPlanId === 'tennis'
    && slots.every(slot => /^(?:[8-9]|1[0-9]|2[01])$/.test(slot.split('|')[2] || ''));

  for (const slot of slots) {
    const [roomId, slotDate, time] = slot.split('|');
    if (!byRoom.has(roomId) || slotDate !== date || !time) return null;
    if (legacyIntegerFormat) {
      const start = Number(time) * 60;
      byRoom.get(roomId)?.push(hhmm(start), hhmm(start + 30));
    } else {
      if (tennisMinutes(time) === null) return null;
      byRoom.get(roomId)?.push(time);
    }
  }

  let reference: string[] | null = null;
  const canonical: string[] = [];
  for (const roomId of roomIds) {
    const times = byRoom.get(roomId) || [];
    const unique = Array.from(new Set(times));
    if (unique.length !== times.length || unique.length === 0 || unique.length % 2 !== 0) return null;
    unique.sort((a, b) => (tennisMinutes(a) || 0) - (tennisMinutes(b) || 0));
    for (let i = 0; i < unique.length; i += 2) {
      const first = tennisMinutes(unique[i]);
      const second = tennisMinutes(unique[i + 1]);
      if (first === null || second === null || second - first !== 30) return null;
    }
    if (reference === null) reference = unique;
    else if (!sameStringSet(reference, unique)) return null;
    for (const time of unique) canonical.push(`${roomId}|${date}|${time}`);
  }
  return canonical;
}

/**
 * Validate and canonicalize the inventory-bearing part of a reservation.
 * Call this only after validateReservationBody has completed basic validation.
 */
export function canonicalizeReservation(body: any): CanonicalReservationResult {
  const inputPlanId = body?.planId;
  if (typeof inputPlanId !== 'string') return { ok: false, error: 'invalid_planId' };
  const canonicalPlanId = inputPlanId === 'tennis' ? 'tennis_full' : inputPlanId;
  // 通常objectは __proto__/constructor/toString 等を継承する。own property確認なしで
  // planRuleとして扱うと、無認証入力でTypeError→500を起こせる。
  if (!Object.prototype.hasOwnProperty.call(RESERVATION_PLAN_RULES, canonicalPlanId)) {
    return { ok: false, error: 'invalid_planId' };
  }
  const planRule = RESERVATION_PLAN_RULES[canonicalPlanId];

  const roomIds = Array.isArray(body?.roomIds) ? body.roomIds.slice() : [];
  const slots = Array.isArray(body?.slots) ? body.slots.slice() : [];
  const startDate = body?.startDate;
  const rawEndDate = body?.endDate;
  if (!isRealIsoDate(startDate) || !isRealIsoDate(rawEndDate)) {
    return { ok: false, error: 'invalid_date_format' };
  }
  const roomError = validateRooms(roomIds, planRule);
  if (roomError) return roomError;

  const rawNights = body?.nights ?? 0;
  let nights = 0;
  let endDate = startDate;
  let serviceDates = [startDate];

  if (planRule.kind === 'overnight') {
    if (typeof rawNights !== 'number' || !Number.isInteger(rawNights)
        || rawNights < 1 || rawNights > (planRule.maxNights || 14)) {
      return { ok: false, error: 'invalid_nights' };
    }
    nights = rawNights;
    endDate = addDaysUtc(startDate, nights);
    if (rawEndDate !== endDate) return { ok: false, error: 'plan_date_mismatch' };
    serviceDates = Array.from({ length: nights }, (_, i) => addDaysUtc(startDate, i));
  } else {
    // Backward-compatible with cached public HTML which sent nights=1/end=start+1
    // for all single-day plans. Canonical storage is always nights=0/end=start.
    const legacyEndDate = addDaysUtc(startDate, 1);
    const validPair = (rawNights === 0 && rawEndDate === startDate)
      || (rawNights === 1 && rawEndDate === legacyEndDate);
    if (!validPair) return { ok: false, error: 'plan_date_mismatch' };
  }

  let canonicalSlots: string[] | null = null;
  if (planRule.kind === 'overnight') {
    canonicalSlots = expectedOvernightSlots(roomIds, startDate, nights, planRule.hours || []);
    if (!sameStringSet(slots, canonicalSlots)) canonicalSlots = null;
  } else if (planRule.kind === 'fixed_day') {
    canonicalSlots = expectedFixedSlots(roomIds, startDate, planRule.hours || []);
    if (!sameStringSet(slots, canonicalSlots)) canonicalSlots = null;
  } else if (planRule.kind === 'hourly_day') {
    // 旧公開HTMLは選択時間に関係なく全6時間を送っていた。slotだけでは「全時間を
    // 本当に選んだ予約」と区別できないため、修正版クライアントを明示する。
    if (body?.inventoryVersion !== 2) {
      return { ok: false, error: 'client_update_required', detail: 'lodge_day_inventory_v2' };
    }
    canonicalSlots = validateHourlyDaySlots(slots, roomIds[0], startDate, planRule.hours || []);
  } else if (planRule.kind === 'tennis') {
    canonicalSlots = normalizeTennisSlots(inputPlanId, roomIds, slots, startDate);
  } else {
    for (const hours of FUTAMI_SAUNA_HOURS) {
      const expected = expectedFixedSlots(roomIds, startDate, hours);
      if (sameStringSet(slots, expected)) {
        canonicalSlots = expected;
        break;
      }
    }
  }

  if (!canonicalSlots) return { ok: false, error: 'plan_slot_mismatch' };

  return {
    ok: true,
    value: {
      planId: canonicalPlanId,
      kind: planRule.kind,
      roomIds,
      slots: canonicalSlots,
      startDate,
      endDate,
      nights,
      serviceDates,
    },
  };
}
