// 予約入力バリデーションのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import { validateReservationBody, validateUpdateFields } from '../src/lib/validation';

const VALID_ROOMS = new Set([
  'room_27', 'room_6_1', 'court_1', 'court_2', 'midori', 'sauna', 'camp_1', 'camp_2', 'lodge_a',
]);

const FIXED_NOW = new Date('2026-05-05T00:00:00+09:00');

const baseValid = () => ({
  planId: 'normal_27',
  roomIds: ['room_27'],
  slots: ['room_27|2026-05-10|10'],
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  customer: {
    name: '山田 太郎',
    phone: '090-1234-5678',
    email: 'taro@example.com',
  },
});

describe('validateReservationBody — 通過ケース', () => {
  it('最小構成（住所なし）で通過する', () => {
    const r = validateReservationBody(baseValid(), { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });

  it('住所3点（zip/address1/address2）込みでも通過する', () => {
    const body = baseValid();
    body.customer = {
      ...body.customer,
      zip: '791-3120',
      address1: '愛媛県伊予市双海町',
      address2: '高野川123',
    } as any;
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });

  it('宿泊系（room_27）は365日先まで予約可', () => {
    const body = baseValid();
    body.startDate = '2027-04-01';
    body.endDate = '2027-04-02';
    body.slots = ['room_27|2027-04-01|10'];
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });
});

describe('validateReservationBody — 拒否ケース', () => {
  it('planId が文字列でない', () => {
    const body: any = { ...baseValid(), planId: 123 };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_planId' });
  });

  it('planId が101文字以上', () => {
    const body: any = { ...baseValid(), planId: 'x'.repeat(101) };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_planId' });
  });

  it('roomIds が空配列', () => {
    const body = { ...baseValid(), roomIds: [] };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_roomIds' });
  });

  it('roomIds に未知のIDが混入', () => {
    const body = { ...baseValid(), roomIds: ['room_27', 'room_evil'] };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_roomId', detail: 'room_evil' });
  });

  it('slots が空配列', () => {
    const body = { ...baseValid(), slots: [] };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_slots' });
  });

  it('slot要素に51文字以上の文字列', () => {
    const body = { ...baseValid(), slots: ['x'.repeat(51)] };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_slot_format' });
  });

  it('日付フォーマット不正', () => {
    const body = { ...baseValid(), startDate: '2026/05/10' };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_date_format' });
  });

  it('テニス（非宿泊系）は90日先までで、それ以上は booking_too_far', () => {
    // FIXED_NOW=2026-05-05 から 91日後＝2026-08-04 を超える日付
    const body = {
      ...baseValid(),
      planId: 'tennis_full',
      roomIds: ['court_1'],
      slots: ['court_1|2026-09-01|10'],
      startDate: '2026-09-01',
      endDate: '2026-09-01',
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('booking_too_far');
    expect((r as any).detail).toContain('90日');
  });

  it('customer.name 欠落', () => {
    const body = { ...baseValid(), customer: { phone: '090', email: 'a@b.c' } };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_name' });
  });

  it('customer.phone 欠落', () => {
    const body = { ...baseValid(), customer: { name: '山田', email: 'a@b.c' } };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_phone' });
  });

  it('customer.email が101文字以上', () => {
    const body = baseValid();
    body.customer.email = 'a'.repeat(95) + '@b.com';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_email' });
  });

  it('customer.zip が11文字以上', () => {
    const body: any = baseValid();
    body.customer.zip = '12345-67890';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_zip' });
  });

  it('note が501文字以上', () => {
    const body: any = { ...baseValid(), note: 'x'.repeat(501) };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_note' });
  });
});

// 2026-07-19 セキュリティバッチ：メール形式・日付範囲の追加検証
describe('validateReservationBody — メール形式検証（フィッシング増幅対策）', () => {
  it('正：通常のメールアドレスは通過', () => {
    const body = baseValid();
    body.customer.email = 'user.name+tag@example.co.jp';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });

  it('拒否：@ が無い', () => {
    const body = baseValid();
    body.customer.email = 'not-an-email';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_email' });
  });

  it('拒否：カンマで複数宛先化（BCC 悪用の温床）', () => {
    const body = baseValid();
    body.customer.email = 'victim@example.com,attacker@evil.com';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_email' });
  });

  it('拒否：改行を含む（ヘッダ汚染狙い）', () => {
    const body = baseValid();
    body.customer.email = 'a@b.com\nBcc: x@y.com';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_customer_email' });
  });

  it('メール空文字（任意項目）は通過', () => {
    const body = baseValid();
    body.customer.email = '';
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });
});

describe('validateReservationBody — endDate 範囲サニティ（在庫占有対策）', () => {
  it('拒否：endDate が startDate から30日を超える（大量 slot 占有）', () => {
    const body = {
      ...baseValid(),
      startDate: '2026-05-10',
      endDate: '2026-08-10', // 92日先
      slots: ['room_27|2026-05-10|10'],
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_date_range', detail: expect.any(String) });
  });

  it('拒否：endDate が startDate より前（逆転）', () => {
    const body = {
      ...baseValid(),
      startDate: '2026-05-10',
      endDate: '2026-05-09',
      slots: ['room_27|2026-05-10|10'],
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect((r as any).error).toBe('invalid_date_range');
  });

  it('正：14泊（宿泊上限）は通過する', () => {
    const body = {
      ...baseValid(),
      startDate: '2026-05-10',
      endDate: '2026-05-24',
      slots: ['room_27|2026-05-10|10'],
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });
});

// #3 slot 突合・混在カテゴリ検査
describe('validateReservationBody — slot 突合（#3）', () => {
  it('正：テニス複数slot（court_1・同日30分単位）が通過する', () => {
    const body = {
      ...baseValid(), planId: 'tennis', roomIds: ['court_1'],
      slots: ['court_1|2026-05-10|10:00', 'court_1|2026-05-10|10:30'],
      startDate: '2026-05-10', endDate: '2026-05-10',
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(true);
  });
  it('正：宿泊の翌朝またぎ（endDate のスロット）が通過する', () => {
    const body = {
      ...baseValid(), roomIds: ['room_27'],
      slots: ['room_27|2026-05-10|16', 'room_27|2026-05-11|9'],
      startDate: '2026-05-10', endDate: '2026-05-11',
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(true);
  });
  it('正：キャンプ複数区画（camp_1・camp_2）が通過する', () => {
    const body = {
      ...baseValid(), planId: 'camp', roomIds: ['camp_1', 'camp_2'],
      slots: ['camp_1|2026-05-10|14', 'camp_2|2026-05-10|14'],
      startDate: '2026-05-10', endDate: '2026-05-10',
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(true);
  });
  it('拒否：slot の roomId が roomIds に含まれない（取り違え）', () => {
    const body = {
      ...baseValid(), roomIds: ['room_27'],
      slots: ['court_1|2026-05-10|10'], // court_1 は roomIds 外
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'slot_room_mismatch', detail: 'court_1|2026-05-10|10' });
  });
  it('拒否：court_* と他カテゴリの混在ペイロード（二重予約の温床）', () => {
    const body = {
      ...baseValid(), roomIds: ['court_1', 'camp_1'],
      slots: ['court_1|2026-05-10|10', 'camp_1|2026-05-10|14'],
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_roomIds', detail: 'tennis_mixed' });
  });
  it('拒否：slot 日付が startDate〜endDate の範囲外', () => {
    const body = {
      ...baseValid(), roomIds: ['room_27'],
      slots: ['room_27|2026-05-20|10'],
      startDate: '2026-05-10', endDate: '2026-05-10',
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'slot_date_out_of_range', detail: 'room_27|2026-05-20|10' });
  });
  it('拒否：slot 重複', () => {
    const body = {
      ...baseValid(), roomIds: ['room_27'],
      slots: ['room_27|2026-05-10|10', 'room_27|2026-05-10|10'],
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'duplicate_slot', detail: 'room_27|2026-05-10|10' });
  });
  it('拒否：slot が3分割でない（形式不正）', () => {
    const body = { ...baseValid(), roomIds: ['room_27'], slots: ['room_27|2026-05-10'] };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW });
    expect(r).toEqual({ ok: false, error: 'invalid_slot_format', detail: 'room_27|2026-05-10' });
  });
});

// #17 pricing サニティ
describe('validateReservationBody — pricing サニティ（#17）', () => {
  it('正：pricing 未指定は通過（既存挙動）', () => {
    expect(validateReservationBody(baseValid(), { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(true);
  });
  it('正：pricing.total が正の数なら通過', () => {
    const b: any = { ...baseValid(), pricing: { total: 5000 } };
    expect(validateReservationBody(b, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(true);
  });
  it('拒否：pricing.total = 0（total:0 確定の悪用防止）', () => {
    const b: any = { ...baseValid(), pricing: { total: 0 } };
    expect(validateReservationBody(b, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: false, error: 'invalid_pricing_total' });
  });
  it('拒否：pricing.total が負', () => {
    const b: any = { ...baseValid(), pricing: { total: -100 } };
    expect(validateReservationBody(b, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: false, error: 'invalid_pricing_total' });
  });
  it('拒否：pricing.total が数値でない', () => {
    const b: any = { ...baseValid(), pricing: { total: '5000' } };
    expect(validateReservationBody(b, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: false, error: 'invalid_pricing_total' });
  });
});

// #2 部分更新フィールド検証
describe('validateUpdateFields（#2）', () => {
  it('正：status / note / customer / payment を検証して updates に格納', () => {
    const r = validateUpdateFields({ status: 'checked_in', note: 'メモ', customer: { name: '新名' }, payment: { status: 'paid' } });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ status: 'checked_in', note: 'メモ', customer: { name: '新名' }, payment: { status: 'paid' } });
  });
  it('正：note=null（クリア）も許容', () => {
    const r = validateUpdateFields({ note: null });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ note: null });
  });
  it('拒否：更新フィールドが一つも無い', () => {
    expect(validateUpdateFields({ id: 'x' })).toEqual({ ok: false, error: 'no_updatable_fields' });
  });
  it('拒否：note 501文字', () => {
    expect(validateUpdateFields({ note: 'x'.repeat(501) })).toEqual({ ok: false, error: 'invalid_note' });
  });
  it('拒否：customer がオブジェクトでない', () => {
    expect(validateUpdateFields({ customer: 'evil' })).toEqual({ ok: false, error: 'invalid_customer' });
  });
  it('拒否：customer.name 51文字', () => {
    expect(validateUpdateFields({ customer: { name: 'x'.repeat(51) } })).toEqual({ ok: false, error: 'invalid_customer_name' });
  });
  it('拒否：status が30文字超', () => {
    expect(validateUpdateFields({ status: 'x'.repeat(31) })).toEqual({ ok: false, error: 'invalid_status' });
  });
});
