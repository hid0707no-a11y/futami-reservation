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
  const { planId, roomIds, slots, startDate, endDate, customer, note } = body || {};

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
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 500) {
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
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { ok: false, error: 'invalid_date_format' };
  }

  // 予約受付期間（宿泊系365日 / その他90日）
  const isStayCategory = roomIds.every((r: string) => STAY_ROOMS.has(r));
  const maxDays = isStayCategory ? 365 : 90;
  const now = opts.now ?? new Date();
  const maxDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + maxDays);
  const bookingDate = new Date(startDate + 'T00:00:00');
  if (bookingDate > maxDate) {
    return { ok: false, error: 'booking_too_far', detail: `${maxDays}日先まで予約可能です` };
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
  if (!customer?.name || typeof customer.name !== 'string' || customer.name.length > 50) {
    return { ok: false, error: 'invalid_customer_name' };
  }
  if (!customer?.phone || typeof customer.phone !== 'string' || customer.phone.length > 20) {
    return { ok: false, error: 'invalid_customer_phone' };
  }
  if (customer.email && (typeof customer.email !== 'string' || customer.email.length > 100)) {
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

  // note
  if (note && (typeof note !== 'string' || note.length > 500)) {
    return { ok: false, error: 'invalid_note' };
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
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 50)) return { ok: false, error: 'invalid_customer_name' };
    if (c.phone !== undefined && (typeof c.phone !== 'string' || c.phone.length > 20)) return { ok: false, error: 'invalid_customer_phone' };
    if (c.email !== undefined && c.email !== '' && (typeof c.email !== 'string' || c.email.length > 100)) return { ok: false, error: 'invalid_customer_email' };
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
