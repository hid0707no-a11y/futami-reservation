// 予約入力バリデーションのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import { validateReservationBody } from '../src/lib/validation';

const VALID_ROOMS = new Set([
  'room_27', 'room_6_1', 'court_1', 'midori', 'sauna', 'camp_1', 'lodge_a',
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
