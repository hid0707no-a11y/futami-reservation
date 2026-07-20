// サーバ側 権威的 料金計算（#17 根治）。
//
// 2026-07-20 新設。従来サーバは createReservation で `pricing: pricing || null` と
// クライアント申告値を無変換保存していたため、total:1 に改ざんした POST がそのまま
// 1円の confirmed 予約になりスプシの「ご請求金額」へ直通していた（44所見 M3 / #17）。
// 本モジュールは canonical 化済みの予約（planId/roomIds/slots/nights/startDate）と、
// クライアントが申告する「サービス選択の事実」（市民区分・照明有無・オプション数量）
// だけを入力に、料金を **サーバが権威的に再計算** する純関数群を提供する。
//
// 設計原則（reservationPlans.ts の「server must own the inventory shape」を料金へ拡張）：
//  - 金額はすべてサーバ計算。クライアントの total / basePrice / lightingFee 等の
//    「金額フィールド」は一切信用しない。
//  - 平日割・祝日はサーバが日付から自律判定する（constants.JP_HOLIDAYS_2026_2027）。
//    クライアントの weekdayDiscount フラグは信用しない。
//  - 市民区分(isResident)・照明有無(useLighting)・照明時間数・オプション数量・サウナ人数は
//    「サービス選択の事実申告」としてクライアント値を採用してよい（虚偽は窓口で対面確認される
//    性質。isResident と同じ信頼モデル）。ただし金額はその事実からサーバが計算する。
//  - 一部プランは料金に効く選択事実がペイロードに素で載っていない：
//      * midori 各プランの「学生区分(isStudent)」
//      * lodge_stay の「シーツ枚数」
//    これらはフロント改修を避けるため、サーバが列挙する **正当価格の有限集合** に対して
//    クライアント申告 total をスナップして復元する（下記 snap ロジック）。保存される total は
//    常にサーバが算出した正当価格集合の要素になり、任意の改ざん値（1円等）は既定値へ収束する。
//  - 価格表は本ファイルの TS 定数として保持（デプロイバンドル外の実行時ファイル読込はしない）。
//    docs/pricing.json との突合（ドリフト検出）は functions/tests/pricingServer.test.ts で行う。
//
// 価格計算のコア純関数（calculateStayPrice / calculateHourlyTennisPrice / calculateCampPrice）は
// フロントの assets/js/pricing.js と **同一入力で完全一致** する（パリティテストで担保）。

import { JP_HOLIDAYS_2026_2027 } from '../constants';
import type { CanonicalReservation } from './reservationPlans';

// ─────────────────────────────────────────────
// 価格表（SSOT はサーバ内 TS 定数・docs/pricing.json と突合）
// ─────────────────────────────────────────────

/** 宿泊系（人数加算あり）。roomCount 倍率は multiSelect のときだけ roomIds.length。 */
interface StayPricing {
  type: 'stay';
  basePrice: number;
  extraAdult: number;
  extraChild: number;
  extraInfant: number;
  /** 複数室選択で room 数を倍率にするか（stay_6 のみ true。stay_all は 6室占有でも束価格なので false）。 */
  multiSelect: boolean;
}
/** 固定料金（1室・日帰りコマ／通し等）。金額は室数・人数に依存しない。 */
interface FlatPricing {
  type: 'flat';
  basePrice: number;
}
/** みどりの広場（市民/市外×一般/学生。夜間のみ任意照明）。 */
interface MidoriPricing {
  type: 'midori';
  resident: number;
  nonResident: number;
  studentResident: number;
  studentNonResident: number;
  /** 夜間照明の単価（midori_eve のみ・時間指定 0〜5）。無い枠は 0。 */
  lightingPrice: number;
  lightingMaxHours: number;
  guestEstimateMax: number;
}
/** キャンプ（区画数×泊数）。 */
interface CampPricing {
  type: 'camp';
  basePrice: number;
}
/** ロッジ宿泊（棟×泊数＋シーツ）。 */
interface LodgeStayPricing {
  type: 'lodge_stay';
  basePrice: number;
  sheetPrice: number;
  sheetMax: number;
}
/** 時間単価（ロッジ日帰り）。金額は選択時間数×単価。 */
interface HourlyFlatPricing {
  type: 'hourly_flat';
  basePrice: number;
}
/**
 * テニス（30分開始1時間枠×コート数。平日割はサーバ判定）。
 * 一面貸切(tennis_full)と半面練習(tennis_half)の両方。空間貸し運用（2026-04-12 上村確認・
 * docs/pricing.json resolvedConfirmations）のため **人数は料金に一切掛けない**。半面は
 * court_1 の1面のみ貸出（reservationPlans.HALF_COURT_ROOMS）なので courtCount は常に 1。
 */
interface TennisPricing {
  type: 'tennis';
  /** 貸出単位。保存 pricing.tennis.courtType としてそのまま出力（index.html と同一値）。 */
  courtType: 'full' | 'half';
  residentPrice: number;
  nonResidentPrice: number;
  weekdayDiscountResident: number;
  weekdayDiscountNonResident: number;
  lightingPrice: number;
  guestEstimateMax: number;
}
/** 通常サウナ（1グループ固定＋オプション）。 */
interface SaunaPricing {
  type: 'sauna';
  basePrice: number;
}
/** ふたみの日サウナ（1人単価×人数＋オプション）。 */
interface FutamiSaunaPricing {
  type: 'futami_sauna';
  pricePerPerson: number;
}

export type PlanPricing =
  | StayPricing | FlatPricing | MidoriPricing | CampPricing | LodgeStayPricing
  | HourlyFlatPricing | TennisPricing | SaunaPricing | FutamiSaunaPricing;

// サウナオプション単価と数量上限（docs/pricing.json sauna.options と同期）。
export const SAUNA_OPTION_PRICES = {
  towel: 550,
  tarpTent: 1100,
  ice20kg: 4400,
} as const;
export const SAUNA_OPTION_MAX = {
  towels: 8,
  tarpTent: 1,
  ice20kg: 5,
} as const;

const STAY_ROOMS_MULTI = { type: 'stay', extraAdult: 1580, extraChild: 1050, extraInfant: 790 } as const;

// planId → 料金定義。RESERVATION_PLAN_RULES の全 planId を必ず網羅すること
// （網羅ガードテスト functions/tests/pricingServer.test.ts が将来のプラン追加漏れを検出する）。
export const SERVER_PLAN_PRICING: Readonly<Record<string, PlanPricing>> = {
  // ── 宿泊 ──
  stay_6: { ...STAY_ROOMS_MULTI, basePrice: 2310, multiSelect: true },
  stay_27: { ...STAY_ROOMS_MULTI, basePrice: 9430, multiSelect: false },
  stay_exp: { ...STAY_ROOMS_MULTI, basePrice: 9430, multiSelect: false },
  stay_all: { ...STAY_ROOMS_MULTI, basePrice: 28100, multiSelect: false },

  // ── 日帰り（固定料金・室別）──
  day_6_all: { type: 'flat', basePrice: 1680 },
  day_27_am: { type: 'flat', basePrice: 1790 },
  day_27_pm: { type: 'flat', basePrice: 2620 },
  day_27_eve: { type: 'flat', basePrice: 2620 },
  day_27_daytime: { type: 'flat', basePrice: 4410 },
  day_27_all: { type: 'flat', basePrice: 6080 },
  day_exp_am: { type: 'flat', basePrice: 1790 },
  day_exp_pm: { type: 'flat', basePrice: 2620 },
  day_exp_eve: { type: 'flat', basePrice: 2620 },
  day_exp_daytime: { type: 'flat', basePrice: 4410 },
  day_exp_all: { type: 'flat', basePrice: 6080 },
  day_train_am: { type: 'flat', basePrice: 2620 },
  day_train_pm: { type: 'flat', basePrice: 3880 },
  day_train_eve: { type: 'flat', basePrice: 3880 },
  day_train_daytime: { type: 'flat', basePrice: 6500 },
  day_train_all: { type: 'flat', basePrice: 8910 },
  day_kitchen: { type: 'flat', basePrice: 2310 },

  // ── アウトドア ──
  camp_stay: { type: 'camp', basePrice: 790 },
  lodge_stay: { type: 'lodge_stay', basePrice: 4720, sheetPrice: 340, sheetMax: 10 },
  lodge_day: { type: 'hourly_flat', basePrice: 330 },

  // ── テニス ──
  tennis_full: {
    type: 'tennis', courtType: 'full',
    residentPrice: 630, nonResidentPrice: 760,
    weekdayDiscountResident: 320, weekdayDiscountNonResident: 380,
    lightingPrice: 630, guestEstimateMax: 10,
  },
  // 半面練習（2026-07-20 復活）。単価は docs/pricing.json tennis.half ＝ index.html tennis_half。
  // 平日割は 120/140（半額が元から10円の倍数のため丸めなし）。照明は全面と共通の 630円/時・
  // コート単位で、17時以降は平日割対象外＝割引しない（tennis_full と同一方式）。
  tennis_half: {
    type: 'tennis', courtType: 'half',
    residentPrice: 240, nonResidentPrice: 280,
    weekdayDiscountResident: 120, weekdayDiscountNonResident: 140,
    lightingPrice: 630, guestEstimateMax: 10,
  },

  // ── みどりの広場 ──
  midori_am: { type: 'midori', resident: 1890, nonResident: 2200, studentResident: 1050, studentNonResident: 1260, lightingPrice: 0, lightingMaxHours: 0, guestEstimateMax: 150 },
  midori_pm: { type: 'midori', resident: 2730, nonResident: 3250, studentResident: 1580, studentNonResident: 1890, lightingPrice: 0, lightingMaxHours: 0, guestEstimateMax: 150 },
  midori_day: { type: 'midori', resident: 4620, nonResident: 5450, studentResident: 2630, studentNonResident: 3150, lightingPrice: 0, lightingMaxHours: 0, guestEstimateMax: 150 },
  midori_eve: { type: 'midori', resident: 2730, nonResident: 3250, studentResident: 1580, studentNonResident: 1890, lightingPrice: 1890, lightingMaxHours: 5, guestEstimateMax: 150 },

  // ── サウナ ──
  sauna_1: { type: 'sauna', basePrice: 13200 },
  sauna_2: { type: 'sauna', basePrice: 13200 },
  sauna_3: { type: 'sauna', basePrice: 13200 },
  sauna_4: { type: 'sauna', basePrice: 13200 },
  plan_sauna_futami: { type: 'futami_sauna', pricePerPerson: 2300 },
};

// ─────────────────────────────────────────────
// コア純関数（assets/js/pricing.js と同一ロジック＝パリティテストで担保）
// ─────────────────────────────────────────────

export interface StayCalcPlan { basePrice: number; extraAdult?: number; extraChild?: number; extraInfant?: number; }
export interface StayCalcOpts { roomCount?: number; nights?: number; guestsAdult?: number; guestsChild?: number; guestsInfant?: number; }

/** 宿泊料金：(基本料金×室数 + 人数加算) × 泊数。pricing.js.calculateStayPrice と一致。 */
export function calculateStayPrice(plan: StayCalcPlan, opts: StayCalcOpts): number {
  const roomCount = Math.max(1, opts.roomCount || 1);
  const nights = Math.max(1, opts.nights || 1);
  const baseCost = plan.basePrice * roomCount;
  const adultCost = (plan.extraAdult || 0) * (opts.guestsAdult || 0);
  const childCost = (plan.extraChild || 0) * (opts.guestsChild || 0);
  const infantCost = (plan.extraInfant || 0) * (opts.guestsInfant || 0);
  return (baseCost + adultCost + childCost + infantCost) * nights;
}

export interface TennisCalcPlan {
  residentPrice: number; nonResidentPrice: number;
  weekdayDiscount?: boolean;
  weekdayDiscountResident?: number; weekdayDiscountNonResident?: number;
  lightingPrice?: number;
}
export interface TennisCalcOpts {
  hours: string[];
  isResident?: boolean;
  useLighting?: boolean;
  courtCount?: number;
  isWeekdayDiscountHour?: (h: string) => boolean;
}

/** テニス料金：枠(1時間)ごと × コート数、照明はコート単位。pricing.js.calculateHourlyTennisPrice と一致。 */
export function calculateHourlyTennisPrice(plan: TennisCalcPlan, opts: TennisCalcOpts): number {
  const hours = Array.isArray(opts.hours) ? opts.hours : [];
  const courtCount = Math.max(1, opts.courtCount || 1);
  const normalPrice = opts.isResident ? plan.residentPrice : plan.nonResidentPrice;
  const fallbackDiscount = Math.ceil(normalPrice * 0.5 / 10) * 10;
  const discountPrice = opts.isResident
    ? (plan.weekdayDiscountResident != null ? plan.weekdayDiscountResident : fallbackDiscount)
    : (plan.weekdayDiscountNonResident != null ? plan.weekdayDiscountNonResident : fallbackDiscount);
  let total = 0;
  for (const h of hours) {
    const isDiscounted = plan.weekdayDiscount && opts.isWeekdayDiscountHour && opts.isWeekdayDiscountHour(h);
    total += (isDiscounted ? discountPrice : normalPrice) * courtCount;
  }
  if (opts.useLighting && plan.lightingPrice) {
    total += plan.lightingPrice * hours.length * courtCount;
  }
  return total;
}

export interface CampCalcOpts { siteCount?: number; nights?: number; }

/** キャンプ料金：単価 × 区画数 × 泊数。pricing.js.calculateCampPrice と一致。 */
export function calculateCampPrice(plan: { basePrice: number }, opts: CampCalcOpts): number {
  const siteCount = Math.max(0, opts.siteCount || 0);
  const nights = Math.max(1, opts.nights || 1);
  return plan.basePrice * siteCount * nights;
}

// ─────────────────────────────────────────────
// 平日割・祝日（サーバ自律判定）
// ─────────────────────────────────────────────

/** 日本の祝日か（2026-2027 テーブル・範囲外は false）。index.html isJapaneseHoliday と同義。 */
export function isJapaneseHoliday(dateStr: string): boolean {
  return !!dateStr && JP_HOLIDAYS_2026_2027.has(dateStr);
}

/**
 * テニス平日割の対象枠か：平日(月〜金)かつ祝日でなく、1時間枠 [startKey, startKey+60] が
 * 8:30-17:00 に完全に収まる。index.html isTennisWeekdayDiscountSlot と同義（曜日は UTC で決定的に）。
 */
export function isTennisWeekdayDiscountSlot(dateStr: string, startKey: string): boolean {
  if (!dateStr) return false;
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (isJapaneseHoliday(dateStr)) return false;
  if (typeof startKey !== 'string' || !/^\d{4}$/.test(startKey)) return false;
  const slotStart = parseInt(startKey.slice(0, 2), 10) * 60 + parseInt(startKey.slice(2), 10);
  const slotEnd = slotStart + 60;
  return slotStart >= 8 * 60 + 30 && slotEnd <= 17 * 60;
}

// ─────────────────────────────────────────────
// 入力補助
// ─────────────────────────────────────────────

function toSafeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}
function clampInt(v: unknown, min: number, max: number): number {
  const n = toSafeInt(v);
  if (n === null) return min < 0 ? 0 : min;
  return Math.max(min, Math.min(max, n));
}
/** クライアント申告 total を「有効な正の有限数」に限って取り出す（それ以外は null）。 */
function declaredTotalOf(declaredPricing: any): number | null {
  const t = declaredPricing?.total;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

/** テニス canonical slots（court|date|HHMM の30分ペア）から「1時間課金枠」の開始キー列を復元する。 */
export function tennisHourKeysFromSlots(slots: string[], roomIds: string[]): string[] {
  const firstCourt = roomIds[0];
  const times = slots
    .filter(s => s.split('|')[0] === firstCourt)
    .map(s => s.split('|')[2])
    .filter(t => /^\d{4}$/.test(t))
    .sort();
  // canonicalize 済みなので偶数個・(h, h+30) ペア。各ペアの先頭が1時間枠の開始キー。
  const hourKeys: string[] = [];
  for (let i = 0; i + 1 < times.length; i += 2) hourKeys.push(times[i]);
  return hourKeys;
}

// ─────────────────────────────────────────────
// 出力形状（既存コンシューマ互換：sheets.ts / mail / format）
// ─────────────────────────────────────────────

export interface ServerPricingTennis {
  courtType: 'full' | 'half';
  isResident: boolean;
  totalHours: number;
  weekdayDiscountHours: number;
  useLighting: boolean;
  lightingFee: number;
}
export interface ServerPricingMidori {
  slot: 'eve';
  lightingHours: number;
  lightingFee: number;
}
export interface ServerPricingSaunaOptions {
  towels: number;
  tarpTent: number;
  ice20kg: number;
}
export interface ServerPricing {
  basePrice: number;
  personFee: number;
  optionFee: number;
  total: number;
  tennis: ServerPricingTennis | null;
  midori: ServerPricingMidori | null;
  sportGuestEstimate: number | null;
  saunaOptions?: ServerPricingSaunaOptions;
}
export interface PricingMismatch {
  claimedTotal: number;
  computedTotal: number;
}
export interface ComputeServerPricingResult {
  pricing: ServerPricing;
  mismatch: PricingMismatch | null;
}

export interface ClientSelectionInputs {
  /** { adult(中学生以上), elementary(小学生), child(小学生未満) }（validation 済み・宿泊料金に使用）。 */
  guests?: { adult?: number; elementary?: number; child?: number } | null;
  /** 市民区分（customer.isMember）。サービス選択の事実として採用。 */
  isResident?: boolean;
  /** クライアント申告 pricing（金額は信用せず、選択事実の抽出と total 照合にのみ使用）。 */
  declaredPricing?: any | null;
  /** ふたみの日サウナの人数 / キャンプ区画数（handler が渡す）。 */
  guestCount?: number | null;
}

function emptyPricing(total = 0, optionFee = 0): ServerPricing {
  return { basePrice: 0, personFee: 0, optionFee, total, tennis: null, midori: null, sportGuestEstimate: null };
}

function validateSportGuestEstimate(declaredPricing: any, max: number): number | null {
  const raw = declaredPricing?.sportGuestEstimate;
  if (raw == null) return null;
  const n = toSafeInt(raw);
  // 計算に使わない引き継ぎ項目。範囲外は 0 に落とす（行政報告用の目安・料金非影響）。
  if (n === null || n < 0 || n > max) return 0;
  return n;
}

function readSaunaOptions(declaredPricing: any): ServerPricingSaunaOptions {
  const o = declaredPricing?.saunaOptions || {};
  return {
    towels: clampInt(o.towels, 0, SAUNA_OPTION_MAX.towels),
    tarpTent: clampInt(o.tarpTent, 0, SAUNA_OPTION_MAX.tarpTent),
    ice20kg: clampInt(o.ice20kg, 0, SAUNA_OPTION_MAX.ice20kg),
  };
}
function saunaOptionsFee(o: ServerPricingSaunaOptions): number {
  return o.towels * SAUNA_OPTION_PRICES.towel
    + o.tarpTent * SAUNA_OPTION_PRICES.tarpTent
    + o.ice20kg * SAUNA_OPTION_PRICES.ice20kg;
}

// ─────────────────────────────────────────────
// 権威計算オーケストレーター
// ─────────────────────────────────────────────

/**
 * canonical 予約＋クライアント選択事実から、サーバ権威の pricing オブジェクトを構築する。
 * 返り値 pricing は必ずサーバ計算値。mismatch はクライアント申告 total が
 * サーバ計算値と異なる場合のみ（拒否はしない・呼出側が併記＋構造化ログする）。
 */
export function computeServerPricing(
  canonical: CanonicalReservation,
  inputs: ClientSelectionInputs,
): ComputeServerPricingResult {
  const table = SERVER_PLAN_PRICING[canonical.planId];
  const declared = inputs.declaredPricing || null;
  const declaredTotal = declaredTotalOf(declared);
  const isResident = inputs.isResident === true;

  let pricing: ServerPricing;

  if (!table) {
    // canonicalize が RULES 内 planId を保証するため通常到達しない（網羅ガードテストが将来漏れを検出）。
    // 保険：total 0 で保存し、金額破損を防ぐ。
    pricing = emptyPricing(0, 0);
  } else if (table.type === 'stay') {
    const roomCount = table.multiSelect ? canonical.roomIds.length : 1;
    const g = inputs.guests || {};
    // guests 配列は validation 済みだが保険で clamp（adult=中学生以上, elementary=小学生, child=小学生未満）。
    const total = calculateStayPrice(table, {
      roomCount,
      nights: canonical.nights,
      guestsAdult: clampInt(g.adult, 0, 150),
      guestsChild: clampInt(g.elementary, 0, 150),
      guestsInfant: clampInt(g.child, 0, 150),
    });
    pricing = emptyPricing(total);
  } else if (table.type === 'flat') {
    pricing = emptyPricing(table.basePrice);
  } else if (table.type === 'camp') {
    const total = calculateCampPrice(table, { siteCount: canonical.roomIds.length, nights: canonical.nights });
    pricing = emptyPricing(total);
  } else if (table.type === 'hourly_flat') {
    // ロッジ日帰り：単価 × 選択時間数（canonical.slots は roomId|date|hour の整数時）。
    pricing = emptyPricing(table.basePrice * canonical.slots.length);
  } else if (table.type === 'lodge_stay') {
    // シーツ枚数はペイロードに素で載らない選択事実。正当価格集合 {base + 340×s | s∈[0,10]} に
    // 申告 total をスナップして枚数を復元（改ざん値は s=0=base に収束）。
    const base = table.basePrice * Math.max(1, canonical.nights);
    let sheets = 0;
    if (declaredTotal != null) {
      sheets = Math.max(0, Math.min(table.sheetMax, Math.round((declaredTotal - base) / table.sheetPrice)));
    }
    const optionFee = table.sheetPrice * sheets;
    pricing = { ...emptyPricing(base + optionFee, optionFee) };
  } else if (table.type === 'tennis') {
    const courtCount = canonical.roomIds.length;
    const hourKeys = tennisHourKeysFromSlots(canonical.slots, canonical.roomIds);
    const useLighting = declared?.tennis?.useLighting === true;
    const discountedHourKeys = hourKeys.filter(h => isTennisWeekdayDiscountSlot(canonical.startDate, h));
    const total = calculateHourlyTennisPrice(
      { ...table, weekdayDiscount: true },
      {
        hours: hourKeys,
        isResident,
        useLighting,
        courtCount,
        isWeekdayDiscountHour: (h: string) => isTennisWeekdayDiscountSlot(canonical.startDate, h),
      },
    );
    // sheets.ts が読む lightingFee は「コート数を掛けない1面分」（フロント tennisPricingInfo と同一）。
    const lightingFee = useLighting ? table.lightingPrice * hourKeys.length : 0;
    pricing = {
      ...emptyPricing(total),
      tennis: {
        // 全面/半面はサーバが planId 由来の価格表から決める（クライアント申告 courtType は不採用）。
        courtType: table.courtType,
        isResident,
        totalHours: hourKeys.length,
        weekdayDiscountHours: discountedHourKeys.length,
        useLighting,
        lightingFee,
      },
      sportGuestEstimate: validateSportGuestEstimate(declared, table.guestEstimateMax),
    };
  } else if (table.type === 'midori') {
    // 学生区分(isStudent)はペイロードに素で載らない選択事実。正当価格集合 {一般, 学生}(＋サーバ計算の照明)
    // に申告 total をスナップして復元（一致すれば学生、しなければ一般＝改ざん値は一般へ収束）。
    const lightingHours = table.lightingPrice > 0
      ? clampInt(declared?.midori?.lightingHours, 0, table.lightingMaxHours) : 0;
    const lightingFee = table.lightingPrice * lightingHours;
    const baseNonStudent = isResident ? table.resident : table.nonResident;
    const baseStudent = isResident ? table.studentResident : table.studentNonResident;
    const candidateStudent = baseStudent + lightingFee;
    const candidateNonStudent = baseNonStudent + lightingFee;
    const total = (declaredTotal != null && declaredTotal === candidateStudent)
      ? candidateStudent : candidateNonStudent;
    pricing = {
      ...emptyPricing(total),
      midori: table.lightingPrice > 0 ? { slot: 'eve', lightingHours, lightingFee } : null,
      sportGuestEstimate: validateSportGuestEstimate(declared, table.guestEstimateMax),
    };
  } else if (table.type === 'sauna') {
    const opts = readSaunaOptions(declared);
    const optionFee = saunaOptionsFee(opts);
    pricing = { ...emptyPricing(table.basePrice + optionFee, optionFee), saunaOptions: opts };
  } else if (table.type === 'futami_sauna') {
    // ふたみの日：1人単価×人数＋オプション。人数解決は handler(createReservation)の
    // `guestCount ?? guests?.adult ?? 2` と一致させる（handler が 2〜8 で検証・保険で clamp）。
    const rawSeats = inputs.guestCount ?? inputs.guests?.adult ?? 2;
    const seats = Math.max(2, Math.min(8, toSafeInt(rawSeats) ?? 2));
    const opts = readSaunaOptions(declared);
    const optionFee = saunaOptionsFee(opts);
    pricing = { ...emptyPricing(table.pricePerPerson * seats + optionFee, optionFee), saunaOptions: opts };
  } else {
    pricing = emptyPricing(0, 0);
  }

  const mismatch: PricingMismatch | null =
    declaredTotal != null && declaredTotal !== pricing.total
      ? { claimedTotal: declaredTotal, computedTotal: pricing.total }
      : null;

  return { pricing, mismatch };
}
