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

  // slots
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 500) {
    return { ok: false, error: 'invalid_slots' };
  }
  for (const s of slots) {
    if (typeof s !== 'string' || s.length > 50) {
      return { ok: false, error: 'invalid_slot_format' };
    }
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
