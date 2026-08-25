// 予約入力バリデーションのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import { validateReservationBody, validateUpdateFields, isCustomerEmailRequired } from '../src/lib/validation';

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

  // 2026-08-25 要望④：職員（検証済みBearer）だけ受付期間の上限を免除する
  it('職員(isStaff)は90日/365日の上限を超えて予約できる', () => {
    const body = {
      ...baseValid(),
      planId: 'tennis_full',
      roomIds: ['court_1'],
      slots: ['court_1|2027-09-01|10'],
      startDate: '2027-09-01',
      endDate: '2027-09-01',
    };
    // 公開経路は従来どおり拒否
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(false);
    // 職員は通る
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW, isStaff: true }))
      .toEqual({ ok: true });
  });

  it('職員でも過去日は拒否する（打ち間違いを静かに通さない）', () => {
    const body = {
      ...baseValid(),
      planId: 'tennis_full',
      roomIds: ['court_1'],
      slots: ['court_1|2026-05-01|10'],
      startDate: '2026-05-01',
      endDate: '2026-05-01',
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW, isStaff: true }))
      .toEqual({ ok: false, error: 'booking_in_past' });
  });

  it('職員でも endDate の30日ガードは効く', () => {
    const body = {
      ...baseValid(),
      planId: 'tennis_full',
      roomIds: ['court_1'],
      slots: ['court_1|2027-09-01|10'],
      startDate: '2027-09-01',
      endDate: '2027-11-01',
    };
    const r = validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW, isStaff: true });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('invalid_date_range');
  });

  // 2026-08-25 要望⑩：フリガナは任意フィールド
  it('customer.kana は任意（未入力・空文字でも通る）', () => {
    const base = baseValid();
    expect(validateReservationBody(base, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: true });
    const withEmpty = { ...base, customer: { ...base.customer, kana: '' } };
    expect(validateReservationBody(withEmpty, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: true });
    const withKana = { ...base, customer: { ...base.customer, kana: 'ヤマダ タロウ' } };
    expect(validateReservationBody(withKana, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: true });
    // ひらがな・英字も弾かない（現場の書き方を新たに拒否しないため）
    const hira = { ...base, customer: { ...base.customer, kana: 'やまだ たろう' } };
    expect(validateReservationBody(hira, { validRoomIds: VALID_ROOMS, now: FIXED_NOW })).toEqual({ ok: true });
  });

  it('customer.kana は50文字超と改行を拒否する', () => {
    const base = baseValid();
    const long = { ...base, customer: { ...base.customer, kana: 'ア'.repeat(51) } };
    expect(validateReservationBody(long, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_customer_kana' });
    const nl = { ...base, customer: { ...base.customer, kana: 'ヤマダ\nBcc: evil@example.com' } };
    expect(validateReservationBody(nl, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_customer_kana' });
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

describe('validateReservationBody — 実在日・過去日・書込み上限', () => {
  it.each(['2026-02-30', '2026-13-01', '2026-00-10'])('実在しない日付 %s を拒否', badDate => {
    const body = { ...baseValid(), startDate: badDate, endDate: badDate };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_date_format' });
  });

  it('日本時間の今日より前はbooking_in_past', () => {
    const body = {
      ...baseValid(),
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      slots: ['room_27|2026-05-04|10'],
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'booking_in_past' });
  });

  it('slot 500件は予約doc込みでtransaction上限を超えるため拒否', () => {
    const slots = Array.from({ length: 500 }, (_, i) => 'room_27|2026-05-10|' + i);
    expect(validateReservationBody({ ...baseValid(), slots }, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_slots' });
  });
});

describe('validateReservationBody — メール件名制御文字', () => {
  it.each(['山田\r\nBcc: victim@example.com', '山田\n偽件名'])('顧客名の改行 %p を拒否', name => {
    const body = { ...baseValid(), customer: { ...baseValid().customer, name } };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_customer_name' });
  });
});

describe('validateReservationBody — 人数型（保存型XSS対策）', () => {
  it('正常なguestsとguestCountは通過', () => {
    const body: any = {
      ...baseValid(),
      guests: { adult: 2, elementary: 1, child: 0 },
      guestCount: 3,
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }).ok).toBe(true);
  });

  it.each([
    '<img src=x onerror=alert(1)>',
    -1,
    1.5,
    151,
    Number.NaN,
  ])('guests内の不正値 %p を拒否', value => {
    const body: any = {
      ...baseValid(),
      guests: { adult: value, elementary: 0, child: 0 },
    };
    expect(validateReservationBody(body, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_guest_count' });
  });

  it('guestsの配列・余分なキー・合計151人を拒否', () => {
    const cases: any[] = [
      [],
      { adult: 1, elementary: 0, child: 0, html: '<script>' },
      { adult: 100, elementary: 51, child: 0 },
    ];
    for (const guests of cases) {
      expect(validateReservationBody({ ...baseValid(), guests }, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
        .toEqual({ ok: false, error: 'invalid_guest_count' });
    }
  });

  it.each(['<svg/onload=alert(1)>', 0, 1.5, 151])('不正guestCount %p を拒否', guestCount => {
    expect(validateReservationBody({ ...baseValid(), guestCount }, { validRoomIds: VALID_ROOMS, now: FIXED_NOW }))
      .toEqual({ ok: false, error: 'invalid_guest_count' });
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

  // 2026-08-25 要望⑧（職員の予約修正）で日常的に叩く経路になるため、
  // ★4「allowedFields をそのまま透過させるパターン禁止」に沿って詰め替えを検証する。
  it('customer は検証済みキーだけを通す（未知キーは捨てる）', () => {
    const r = validateUpdateFields({
      customer: { name: '新名', kana: 'シンメイ', evil: 'x', __proto__: { polluted: true } },
    });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ customer: { name: '新名', kana: 'シンメイ' } });
  });
  it('payment も検証済みキーだけを通す', () => {
    const r = validateUpdateFields({ payment: { status: 'paid', method: 'cash', amount: 999999 } });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ payment: { status: 'paid', method: 'cash' } });
  });
  it('customer が未知キーだけなら invalid_customer', () => {
    expect(validateUpdateFields({ customer: { evil: 'x' } })).toEqual({ ok: false, error: 'invalid_customer' });
  });
  it('拒否：customer.kana 51文字 / 改行', () => {
    expect(validateUpdateFields({ customer: { kana: 'ア'.repeat(51) } }))
      .toEqual({ ok: false, error: 'invalid_customer_kana' });
    expect(validateUpdateFields({ customer: { kana: 'ヤマダ\nBcc: evil@example.com' } }))
      .toEqual({ ok: false, error: 'invalid_customer_kana' });
  });
  it('拒否：customer.isMember が真偽値でない', () => {
    expect(validateUpdateFields({ customer: { isMember: 'yes' } }))
      .toEqual({ ok: false, error: 'invalid_customer_isMember' });
  });
});

// ─────────────────────────────────────────
// サウナのメール必須（2026-08-16 運営要望③）
// ─────────────────────────────────────────
describe('isCustomerEmailRequired — サウナはメール必須・職員入力は除外', () => {
  it('通常サウナ（sauna_1〜4 / roomIds:sauna）は公開画面から必須', () => {
    for (const planId of ['sauna_1', 'sauna_2', 'sauna_3', 'sauna_4']) {
      expect(isCustomerEmailRequired({ planId, roomIds: ['sauna'] }, 'web')).toBe(true);
    }
  });

  it('ふたみの日サウナ（plan_sauna_futami / sauna_share）も必須', () => {
    expect(isCustomerEmailRequired({ planId: 'plan_sauna_futami', roomIds: ['sauna_share'] }, 'web')).toBe(true);
  });

  it('planId を知らなくても roomIds がサウナなら必須（判定の取りこぼし防止）', () => {
    expect(isCustomerEmailRequired({ planId: 'sauna_future_plan', roomIds: ['sauna'] }, 'web')).toBe(true);
    expect(isCustomerEmailRequired({ roomIds: ['sauna_share'] }, 'web')).toBe(true);
  });

  it('★職員入力（電話受付）は必須にしない＝運営の代理入力を止めない', () => {
    expect(isCustomerEmailRequired({ planId: 'sauna_1', roomIds: ['sauna'] }, 'staff')).toBe(false);
    expect(isCustomerEmailRequired({ planId: 'plan_sauna_futami', roomIds: ['sauna_share'] }, 'staff')).toBe(false);
  });

  it('サウナ以外は従来どおり任意のまま（既存の予約導線を変えない）', () => {
    expect(isCustomerEmailRequired({ planId: 'stay_6', roomIds: ['room_6_1'] }, 'web')).toBe(false);
    expect(isCustomerEmailRequired({ planId: 'day_27_pm', roomIds: ['room_27'] }, 'web')).toBe(false);
    expect(isCustomerEmailRequired({ planId: 'tennis_full', roomIds: ['court_1'] }, 'web')).toBe(false);
    expect(isCustomerEmailRequired({ planId: 'camp_stay', roomIds: ['camp_1'] }, 'web')).toBe(false);
  });
});
