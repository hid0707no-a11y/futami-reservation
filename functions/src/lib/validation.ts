// 予約入力バリデーション（純粋関数版）
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// 旧 index.ts:401 の validateReservationInput(body, res) は副作用（res.status().json()）と返り値が混在していた。
// pure な validateReservationBody(body) に分離し、index.ts 側は薄いラッパで res 送信を担当する形に。
//
// 結果：
//  - { ok: true } 通過
//  - { ok: false, error: 'xxx', detail?: 'yyy' } バリデーション失敗

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_GUESTS = 150;
const HEADER_CONTROL_RE = /[\r\n]/;

function isRealDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

// メールは単一アドレスの形式を強制（2026-07-19）：長さのみの検証だと、無認証の
// createReservation 経由で任意文字列が nodemailer の to: に渡り、公式ドメインから
// 第三者宛に「予約確認」風メールを送らせるフィッシング増幅に使える。
// 空白（改行含む）・カンマ・セミコロン・山括弧・二重引用符を拒否＝複数宛先化とヘッダ/表示名汚染を封じる。
// アポストロフィ（'）は o'brien@example.com 等の RFC 適法 local-part に現れ、かつ注入ベクタでは
// ないため許容する（自己レビュー #6 の回帰是正：既存メールの再保存を阻害しない）。
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const STAY_ROOMS = new Set([
  'room_27', 'room_6_1', 'room_6_2', 'room_6_3', 'room_6_4',
  'room_exp', 'room_train', 'room_kitchen',
]);

export interface ValidationOk {
  ok: true;
}

export interface ValidationFail {
  ok: false;
  error: string;
  detail?: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

export interface ValidationOptions {
  /** ホワイトリストの roomId 集合（呼出元で渡す・テスト容易性のため依存注入）。 */
  validRoomIds: ReadonlySet<string>;
  /** 「今日」の起点（デフォルトは現在時刻。テスト時に固定可能）。 */
  now?: Date;
}

export function validateReservationBody(body: any, opts: ValidationOptions): ValidationResult {
  const { planId, roomIds, slots, startDate, endDate, customer, guests, guestCount, note } = body || {};

  // planId
  if (typeof planId !== 'string' || planId.length > 100) {
    return { ok: false, error: 'invalid_planId' };
  }

  // roomIds: ホワイトリスト
  if (!Array.isArray(roomIds) || roomIds.length === 0 || roomIds.length > 10) {
    return { ok: false, error: 'invalid_roomIds' };
  }
  for (const rid of roomIds) {
    if (!opts.validRoomIds.has(rid)) {
      return { ok: false, error: 'invalid_roomId', detail: rid };
    }
  }

  // 混在カテゴリ拒否（#3）：court_* を他カテゴリと混在させると isTennisPayload 判定を外れ、
  // court スロットが通常 slots コレクションに書かれて tennis_slots 排他をすり抜け二重予約になる。
  // camp_* も同様に混在を禁止（isCamp 判定の対称性確保）。
  const hasCourt = roomIds.some((r: any) => typeof r === 'string' && r.startsWith('court_'));
  const allCourt = roomIds.every((r: any) => typeof r === 'string' && r.startsWith('court_'));
  if (hasCourt && !allCourt) {
    return { ok: false, error: 'invalid_roomIds', detail: 'tennis_mixed' };
  }
  const hasCamp = roomIds.some((r: any) => typeof r === 'string' && r.startsWith('camp_'));
  const allCamp = roomIds.every((r: any) => typeof r === 'string' && r.startsWith('camp_'));
  if (hasCamp && !allCamp) {
    return { ok: false, error: 'invalid_roomIds', detail: 'camp_mixed' };
  }

  // slots：構造（roomId|date|time）と roomIds との突合・重複検査（#3）
  // Firestore transaction は予約doc 1件も同時に書くため、slotは最大499件。
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 499) {
    return { ok: false, error: 'invalid_slots' };
  }
  const roomIdSet = new Set<string>(roomIds);
  const seenSlots = new Set<string>();
  for (const s of slots) {
    if (typeof s !== 'string' || s.length > 50) {
      return { ok: false, error: 'invalid_slot_format' };
    }
    const parts = s.split('|');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      return { ok: false, error: 'invalid_slot_format', detail: s };
    }
    // slot の roomId 部は宣言された roomIds に含まれること（取り違え二重予約防止）
    if (!roomIdSet.has(parts[0])) {
      return { ok: false, error: 'slot_room_mismatch', detail: s };
    }
    if (seenSlots.has(s)) {
      return { ok: false, error: 'duplicate_slot', detail: s };
    }
    seenSlots.add(s);
  }

  // 日付フォーマット
  if (typeof startDate !== 'string' || typeof endDate !== 'string'
      || !isRealDate(startDate) || !isRealDate(endDate)) {
    return { ok: false, error: 'invalid_date_format' };
  }

  // 予約受付期間（宿泊系365日 / その他90日）
  const isStayCategory = roomIds.every((r: string) => STAY_ROOMS.has(r));
  const maxDays = isStayCategory ? 365 : 90;
  const now = opts.now ?? new Date();
  const todayJst = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (startDate < todayJst) {
    return { ok: false, error: 'booking_in_past' };
  }
  const maxDate = new Date(todayJst + 'T00:00:00Z');
  maxDate.setUTCDate(maxDate.getUTCDate() + maxDays);
  const bookingDate = new Date(startDate + 'T00:00:00');
  if (bookingDate > maxDate) {
    return { ok: false, error: 'booking_too_far', detail: `${maxDays}日先まで予約可能です` };
  }

  // endDate のサニティ（2026-07-19）：booking_too_far は startDate しか見ないため、
  // endDate を数ヶ月先にして最大500 slot を1リクエストで confirmed 化する在庫占有が通っていた。
  // 逆転禁止＋最長30日（宿泊の連泊上限14泊より十分な余裕を持った全プラン共通上限）。
  const endDateD = new Date(endDate + 'T00:00:00');
  const spanDays = (endDateD.getTime() - bookingDate.getTime()) / 86400000;
  if (!Number.isFinite(spanDays) || spanDays < 0 || spanDays > 30) {
    return { ok: false, error: 'invalid_date_range', detail: 'endDate は startDate から30日以内' };
  }

  // slot の日付は startDate〜endDate の範囲内であること（#3 任意日付の在庫汚染防止）。
  // 宿泊・キャンプの翌朝スロットは endDate（チェックアウト日）に収まる前提。
  for (const s of slots) {
    const slotDate = s.split('|')[1];
    if (slotDate < startDate || slotDate > endDate) {
      return { ok: false, error: 'slot_date_out_of_range', detail: s };
    }
  }

  // customer
  if (!customer?.name || typeof customer.name !== 'string' || customer.name.length > 50
      || HEADER_CONTROL_RE.test(customer.name)) {
    return { ok: false, error: 'invalid_customer_name' };
  }
  if (!customer?.phone || typeof customer.phone !== 'string' || customer.phone.length > 20) {
    return { ok: false, error: 'invalid_customer_phone' };
  }
  if (customer.email && (typeof customer.email !== 'string' || customer.email.length > 100 || !EMAIL_RE.test(customer.email))) {
    return { ok: false, error: 'invalid_customer_email' };
  }
  if (customer.zip && (typeof customer.zip !== 'string' || customer.zip.length > 10)) {
    return { ok: false, error: 'invalid_customer_zip' };
  }
  if (customer.address1 && (typeof customer.address1 !== 'string' || customer.address1.length > 100)) {
    return { ok: false, error: 'invalid_customer_address1' };
  }
  if (customer.address2 && (typeof customer.address2 !== 'string' || customer.address2.length > 100)) {
    return { ok: false, error: 'invalid_customer_address2' };
  }

  // 人数はスタッフ画面で表示される保存データ。文字列を許すと innerHTML sink と結合して
  // 保存型 XSS になるため、受信時点で安全な整数だけに限定する。
  if (guests !== undefined && guests !== null) {
    if (typeof guests !== 'object' || Array.isArray(guests)) {
      return { ok: false, error: 'invalid_guest_count' };
    }
    const allowedKeys = new Set(['adult', 'elementary', 'child']);
    if (Object.keys(guests).some(k => !allowedKeys.has(k))) {
      return { ok: false, error: 'invalid_guest_count' };
    }
    let totalGuests = 0;
    for (const key of allowedKeys) {
      const value = guests[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_GUESTS) {
        return { ok: false, error: 'invalid_guest_count' };
      }
      totalGuests += value;
    }
    if (totalGuests > MAX_GUESTS) return { ok: false, error: 'invalid_guest_count' };
  }
  if (guestCount !== undefined
      && (!Number.isSafeInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUESTS)) {
    return { ok: false, error: 'invalid_guest_count' };
  }

  // note
  if (note && (typeof note !== 'string' || note.length > 500)) {
    return { ok: false, error: 'invalid_note' };
  }

  // #17 pricing.total の最低限サニティ（正の有限数・上限内）。
  // curl 直叩きで total:0/負/NaN/巨額の予約が confirmed 化するのを防ぐ第一防壁。
  // ※ 根治（planId/slots から総額をサーバ再計算し上書き保存）は lib/pricingServer.ts で完了（2026-07-20）。
  //   本サニティは緩めない：ここを通った total も createReservation でサーバ計算値へ上書きされる。
  const pricing = (body || {}).pricing;
  if (pricing != null) {
    const total = pricing.total;
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || total > 10_000_000) {
      return { ok: false, error: 'invalid_pricing_total' };
    }
    // sportGuestEstimate（行政報告用の人数目安・料金非影響の透過フィールド）は、保存型 XSS 増幅や
    // sheets への型汚染を防ぐため、指定時は有限数のみ許可（範囲外→0 の丸めは pricingServer 側で行う）。
    const est = pricing.sportGuestEstimate;
    if (est != null && (typeof est !== 'number' || !Number.isFinite(est))) {
      return { ok: false, error: 'invalid_sport_guest_estimate' };
    }
  }

  return { ok: true };
}

export interface UpdateValidationResult {
  ok: boolean;
  error?: string;
  detail?: string;
  updates?: Record<string, any>;
}

/**
 * updateReservation の部分更新フィールドを検証する（#2/#5）。
 * status の「スロット整合を壊す遷移」（→cancelled / cancelled からの復活）は呼出側の
 * トランザクション内で別途拒否する。ここでは型・長さのみ検査し、検証を通ったフィールド
 * だけを updates に格納して返す（未指定フィールドは含めない＝部分更新）。
 * customer/payment は呼出側で既存値とマージする前提でオブジェクト妥当性のみ見る。
 */
export function validateUpdateFields(body: any): UpdateValidationResult {
  const updates: Record<string, any> = {};
  if (body?.status !== undefined) {
    if (typeof body.status !== 'string' || body.status.length === 0 || body.status.length > 30) {
      return { ok: false, error: 'invalid_status' };
    }
    updates.status = body.status;
  }
  if (body?.note !== undefined) {
    if (body.note !== null && (typeof body.note !== 'string' || body.note.length > 500)) {
      return { ok: false, error: 'invalid_note' };
    }
    updates.note = body.note;
  }
  if (body?.customer !== undefined) {
    const c = body.customer;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      return { ok: false, error: 'invalid_customer' };
    }
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 50 || HEADER_CONTROL_RE.test(c.name))) return { ok: false, error: 'invalid_customer_name' };
    if (c.phone !== undefined && (typeof c.phone !== 'string' || c.phone.length > 20)) return { ok: false, error: 'invalid_customer_phone' };
    if (c.email !== undefined && c.email !== '' && (typeof c.email !== 'string' || c.email.length > 100 || !EMAIL_RE.test(c.email))) return { ok: false, error: 'invalid_customer_email' };
    if (c.zip !== undefined && (typeof c.zip !== 'string' || c.zip.length > 10)) return { ok: false, error: 'invalid_customer_zip' };
    if (c.address1 !== undefined && (typeof c.address1 !== 'string' || c.address1.length > 100)) return { ok: false, error: 'invalid_customer_address1' };
    if (c.address2 !== undefined && (typeof c.address2 !== 'string' || c.address2.length > 100)) return { ok: false, error: 'invalid_customer_address2' };
    updates.customer = c;
  }
  if (body?.payment !== undefined) {
    const p = body.payment;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      return { ok: false, error: 'invalid_payment' };
    }
    if (p.method !== undefined && (typeof p.method !== 'string' || p.method.length > 50)) return { ok: false, error: 'invalid_payment_method' };
    if (p.status !== undefined && (typeof p.status !== 'string' || p.status.length > 50)) return { ok: false, error: 'invalid_payment_status' };
    updates.payment = p;
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: 'no_updatable_fields' };
  }
  return { ok: true, updates };
}
