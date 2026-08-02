// 純粋関数フォーマッタ
//
// 2026-05-05 新設（/gfu Phase A-3 / B-1 部分切出し）。
// 副作用ゼロ・依存ゼロの整形関数群。jest ユニットテスト対象。

export interface CustomerLike {
  zip?: string;
  address1?: string;
  address2?: string;
}

/**
 * 顧客住所を 1行表記に整形する。
 * 例: { zip: '791-3120', address1: '愛媛県伊予市双海町', address2: '高野川123' }
 *     → '〒791-3120 愛媛県伊予市双海町 高野川123'
 */
export function formatCustomerAddress(c: CustomerLike | null | undefined): string {
  if (!c) return '';
  const zip = (c.zip || '').toString().trim();
  const a1 = (c.address1 || '').toString().trim();
  const a2 = (c.address2 || '').toString().trim();
  if (!a1 && !a2) return '';
  const zipPart = zip ? `〒${zip} ` : '';
  return `${zipPart}${a1}${a2 ? ' ' + a2 : ''}`.trim();
}

export interface SaunaOptionsLike {
  towels?: number;
  tarpTent?: number;
  ice20kg?: number;
}

/**
 * サウナオプションを '／' 区切り表記に整形する。
 * 例: { towels: 2, ice20kg: 1 } → 'タオル×2／氷20kg'
 *     null/undefined/空 → ''
 */
export function formatSaunaOptions(opts: SaunaOptionsLike | null | undefined): string {
  if (!opts) return '';
  const parts: string[] = [];
  if ((opts.towels ?? 0) > 0) parts.push(`タオル×${opts.towels}`);
  if ((opts.tarpTent ?? 0) > 0) parts.push('タープテント');
  if ((opts.ice20kg ?? 0) > 0) parts.push(`氷${(opts.ice20kg ?? 0) * 20}kg`);
  return parts.join('／');
}

/**
 * 表示用予約番号を生成する。
 *
 * 2026-05-13 新設（要望#8 桁数短縮）。Firestore Auto ID（20文字 base62: a-z A-Z 0-9）は
 * 「複雑で長い」というクレームが運営から寄せられたため、人間可読な短縮版を
 * 別フィールド `displayId` として保持する。内部参照は引き続き `id`（Auto ID）。
 *
 * 形式: `F-XXXXXX` （F=Futami、Auto ID 先頭6文字を `toUpperCase()` で大文字化）
 *
 * 注意: 元の Auto ID は base62 (62文字種) だが、`toUpperCase()` で大小英字が
 * 同じ文字に潰れるため、生成空間は base36（36文字種）相当に圧縮される。
 * 衝突可能性: 36^6 ≈ 21億通り。1日100件・5年運用（18万件）で誕生日逆算 ≈ 0.001%。
 * 実用上は許容範囲。衝突が顕在化するスケール（年100万件）に達したら、
 * generateDisplayId 内で衝突検知 + 再試行に切替えるか、桁数を8文字に拡張する。
 */
export function generateDisplayId(autoId: string): string {
  if (!autoId) return '';
  // 0/O・1/I 等の紛らわしい文字が含まれる可能性はあるが、運営の口頭伝達は
  // 大文字統一で混乱を避ける（電話で「エフ・ハイフン・エー・ビー・シー…」と読む）。
  return 'F-' + autoId.substring(0, 6).toUpperCase();
}

// ============================================================================
// 予約人数の表記（2026-08-03 新設・運営要望④「通知メールに予約人数が無い」）
// ============================================================================
//
// 人数は「施設ごとに入力欄が違い、payload 上の置き場所も分かれている」ため、
// メール本文のテンプレートに三項演算子を足していくと読めなくなる。
// 「どこから拾うか（source 選択）」と「どう書くか（整形）」の両方をここに閉じ込め、
// mail.ts のテンプレートは partyText を1行差し込むだけにする。
//
//   宿泊 stay_*        … guests{adult,elementary,child}（画面の3区分ステッパー）
//   キャンプ camp_stay … roomIds = 区画。guestCount は「区画数」であって人数ではない
//   サウナ sauna_*     … guestCount（ふたみの日 plan_sauna_futami は座席数＝人数）
//   テニス/みどり      … pricing.sportGuestEstimate（行政報告用の目安人数）
//   職員画面（createdBy='staff'）… 全プラン共通で guests.adult に単純人数が入る
//   上記以外（日帰り各室・ロッジ）… 公開画面に人数の入力欄が無い＝データが存在しない
//
// ★ guests は「入力欄が無いプランでも {adult:1,elementary:0,child:0} が必ず送られる」
//   （index.html selectPlan の初期値がそのまま payload に載る）。これを人数として
//   出すと、運営が確認できない「1名」を全予約に印字することになる。したがって
//   guests を人数として採用するのは「入力欄が実在するプラン」に限定する。

/** validation.ts の MAX_GUESTS と同値。これを超える値は壊れたデータとして無視する。 */
const MAX_PARTY_SIZE = 150;
/** キャンプ場の区画数上限（camp_1〜camp_8）。 */
const MAX_CAMP_SITES = 8;
/** サウナ1枠の定員。 */
const MAX_SAUNA_SEATS = 8;

export interface GuestBreakdownLike {
  adult?: unknown;
  elementary?: unknown;
  child?: unknown;
}

export interface PartySizeInput {
  planId?: string | null;
  roomIds?: readonly unknown[] | null;
  /** 'staff' なら職員画面の単純人数入力（guests.adult）を人数として採用する。 */
  createdBy?: string | null;
  isCamp?: boolean | null;
  guests?: GuestBreakdownLike | null;
  /** サウナ＝人数、キャンプ＝区画数。プランによって意味が違うので単独では解釈しない。 */
  guestCount?: unknown;
  /** pricing.sportGuestEstimate（テニス・みどりの広場の目安人数）。 */
  sportGuestEstimate?: unknown;
}

export type PartyPlanKind = 'stay' | 'camp' | 'sauna' | 'sport' | 'other';

/** planId から「人数がどこに入るプランか」を判定する。 */
export function partyPlanKind(planId: unknown): PartyPlanKind {
  const id = typeof planId === 'string' ? planId : '';
  if (/^stay_/.test(id)) return 'stay';
  if (id === 'camp_stay') return 'camp';
  if (id === 'plan_sauna_futami' || /^sauna_[1-4]$/.test(id)) return 'sauna';
  if (/^tennis_/.test(id) || /^midori_/.test(id)) return 'sport';
  return 'other';
}

/** 1以上 max 以下の安全な整数だけ通す。それ以外（0・欠測・NaN・巨大値）は null。 */
function countOrNull(value: unknown, max: number = MAX_PARTY_SIZE): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max
    ? value
    : null;
}

/** 0以上の安全な整数だけ通す（区分別人数の加算用）。壊れた値は 0 扱い。 */
function nonNegativeOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PARTY_SIZE
    ? value
    : 0;
}

/** キャンプの区画数。roomIds（camp_N）優先、旧データ向けに guestCount へフォールバック。 */
function campSiteCount(input: PartySizeInput): number | null {
  const isCamp = input.isCamp === true || partyPlanKind(input.planId) === 'camp';
  if (!isCamp) return null;
  const rooms = Array.isArray(input.roomIds) ? input.roomIds : [];
  const fromRooms = rooms.filter(r => typeof r === 'string' && /^camp_[1-8]$/.test(r)).length;
  if (fromRooms > 0) return Math.min(fromRooms, MAX_CAMP_SITES);
  // 2026-04-27 以前の shared_slots 方式のキャンプ予約は roomIds が区画になっていない。
  return countOrNull(input.guestCount, MAX_CAMP_SITES);
}

/** 3区分の内訳表記。全区分0（＝未入力）なら空文字。 */
function formatBreakdown(adult: number, elementary: number, child: number): string {
  const parts: string[] = [];
  if (adult > 0) parts.push(`中学生以上${adult}名`);
  if (elementary > 0) parts.push(`小学生${elementary}名`);
  if (child > 0) parts.push(`小学生未満${child}名`);
  if (parts.length === 0) return '';
  // 1区分だけなら「（計N名）」は同じ数字の繰り返しになるので付けない。
  if (parts.length === 1) return `人数：${parts[0]}`;
  return `人数：${parts.join('／')}（計${adult + elementary + child}名）`;
}

/** 人数の行（1行）。判定できなければ空文字＝行ごと出さない。 */
function formatPeopleLine(input: PartySizeInput): string {
  const kind = partyPlanKind(input.planId);
  const guests = input.guests && typeof input.guests === 'object' ? input.guests : {};
  const adult = nonNegativeOrZero(guests.adult);
  const elementary = nonNegativeOrZero(guests.elementary);
  const child = nonNegativeOrZero(guests.child);
  const total = adult + elementary + child;

  // ① サウナは guestCount が人数そのもの（ふたみの日＝相席の座席数、通常枠＝利用人数）。
  if (kind === 'sauna') {
    const seats = countOrNull(input.guestCount, MAX_SAUNA_SEATS);
    if (seats !== null) return `人数：${seats}名`;
  }

  // ② 職員画面（staff.html）は全プラン共通で単純人数を1つ入力し guests.adult に載せる。
  //    区分別ではないので内訳表記にせず「N名」で出す。
  if (input.createdBy === 'staff' && total >= 1 && total <= MAX_PARTY_SIZE) {
    return `人数：${total}名`;
  }

  // ③ 宿泊のみ公開画面に3区分ステッパーがあり、guests が実入力値。
  if (kind === 'stay' && total >= 1 && total <= MAX_PARTY_SIZE) {
    return formatBreakdown(adult, elementary, child);
  }

  // ④ テニス・みどりの広場は「ご利用予定人数(目安)」だけを聞いている（0＝未回答）。
  const estimate = countOrNull(input.sportGuestEstimate);
  if (estimate !== null) return `ご利用予定人数（目安）：${estimate}名`;

  return '';
}

/**
 * メール本文に差し込む人数表記を組み立てる（複数行になり得る）。
 *
 * 例:
 *   宿泊（web）      → '人数：中学生以上2名／小学生1名（計3名）'
 *   キャンプ（web）  → '区画数：3区画'
 *   キャンプ（職員） → '区画数：3区画\n人数：5名'
 *   サウナ           → '人数：4名'
 *   テニス（web）    → 'ご利用予定人数（目安）：10名'
 *   判定不能         → ''（呼び出し側で行ごと省略する）
 */
export function formatPartyText(input: PartySizeInput | null | undefined): string {
  if (!input) return '';
  const lines: string[] = [];
  const sites = campSiteCount(input);
  if (sites !== null) lines.push(`区画数：${sites}区画`);
  const people = formatPeopleLine(input);
  if (people) lines.push(people);
  return lines.join('\n');
}
