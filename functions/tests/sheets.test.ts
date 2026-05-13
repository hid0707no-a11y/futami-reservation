// スプシ同期 純粋ロジックのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import { rowToArray, reservationToRow, SHEET_HEADERS, ReservationRow } from '../src/lib/sheets';

describe('SHEET_HEADERS', () => {
  it('26列（A:Z）に固定されている（変更時は SYNC_CLEAR_RANGE_* も同期更新が必要）', () => {
    expect(SHEET_HEADERS).toHaveLength(26);
  });

  it('最初の5列はメタ情報', () => {
    expect(SHEET_HEADERS.slice(0, 5)).toEqual(['予約ID', '登録日時', 'ステータス', 'プランID', '部屋ID']);
  });

  it('郵便番号と住所は2026-04-27追加（commit 856c194）でメール直後に並ぶ', () => {
    const emailIdx = SHEET_HEADERS.indexOf('メール');
    expect(SHEET_HEADERS[emailIdx + 1]).toBe('郵便番号');
    expect(SHEET_HEADERS[emailIdx + 2]).toBe('住所');
  });

  it('予約番号は2026-05-13追加で末尾（Z列）に並ぶ', () => {
    expect(SHEET_HEADERS[SHEET_HEADERS.length - 1]).toBe('予約番号');
  });
});

describe('rowToArray', () => {
  it('ReservationRow を SHEET_HEADERS と同じ列順の配列に変換する', () => {
    const row: ReservationRow = {
      id: 'abc123',
      createdAt: '2026-05-05T01:00:00.000Z',
      status: 'confirmed',
      planId: 'normal_27',
      roomIds: 'room_27',
      startDate: '2026-05-10',
      endDate: '2026-05-11',
      nights: 1,
      timeStr: '15,16',
      customerName: '山田太郎',
      customerPhone: '090-1234',
      customerEmail: 'taro@example.com',
      customerZip: '791-3120',
      customerAddress: '愛媛県伊予市双海町 高野川123',
      guestsAdult: 2,
      guestsElementary: 1,
      guestsChild: 0,
      guestsSportEstimate: 0,
      pricingTotal: 12000,
      pricingLightingFee: 0,
      weekdayDiscountHours: 0,
      isResident: '市民',
      createdBy: 'staff',
      saunaOptions: '',
      note: '備考テスト',
      displayId: 'F-ABC123',
    };
    const arr = rowToArray(row);
    expect(arr).toHaveLength(26);
    expect(arr[0]).toBe('abc123');
    expect(arr[2]).toBe('confirmed');
    expect(arr[arr.length - 1]).toBe('F-ABC123'); // 末尾は displayId
    expect(arr[arr.length - 2]).toBe('備考テスト'); // 備考は末尾-1
  });
});

describe('reservationToRow', () => {
  it('Firestore document の最小フィールドを安全にマッピングする', () => {
    const row = reservationToRow('id1', {
      status: 'confirmed',
      planId: 'normal_27',
      roomIds: ['room_27'],
      startDate: '2026-05-10',
      endDate: '2026-05-11',
      nights: 1,
      slots: ['room_27|2026-05-10|15', 'room_27|2026-05-10|16'],
      customer: { name: '山田', phone: '090', email: 't@x.com', isMember: true },
      guests: { adult: 2 },
    });
    expect(row.id).toBe('id1');
    expect(row.timeStr).toBe('15,16');
    expect(row.isResident).toBe('市民');
    expect(row.guestsAdult).toBe(2);
    expect(row.guestsElementary).toBe(0);
  });

  it('isMember=false なら市外', () => {
    const row = reservationToRow('id2', {
      customer: { name: 'X', phone: '0', isMember: false },
      slots: [],
    });
    expect(row.isResident).toBe('市外');
  });

  it('roomIds 配列をカンマ連結する', () => {
    const row = reservationToRow('id3', {
      roomIds: ['camp_1', 'camp_2', 'camp_3'],
      customer: { name: 'X', phone: '0' },
      slots: [],
    });
    expect(row.roomIds).toBe('camp_1,camp_2,camp_3');
  });

  it('customerAddress は formatCustomerAddress 経由から〒部分を除去（住所部分のみスプシ列に出す）', () => {
    const row = reservationToRow('id4', {
      customer: { name: 'X', phone: '0', zip: '791-3120', address1: '愛媛県', address2: '双海町' },
      slots: [],
    });
    expect(row.customerAddress).toBe('愛媛県 双海町');
    expect(row.customerZip).toBe('791-3120');
  });

  it('pricingLightingFee は tennis + midori の合計', () => {
    const row = reservationToRow('id5', {
      customer: { name: 'X', phone: '0' },
      slots: [],
      pricing: { tennis: { lightingFee: 200 }, midori: { lightingFee: 500 } },
    });
    expect(row.pricingLightingFee).toBe(700);
  });

  it('saunaOptions は formatSaunaOptions で／区切りに整形', () => {
    const row = reservationToRow('id6', {
      customer: { name: 'X', phone: '0' },
      slots: [],
      pricing: { saunaOptions: { towels: 2, ice20kg: 1 } },
    });
    expect(row.saunaOptions).toBe('タオル×2／氷20kg');
  });

  it('note は500文字で切り詰める', () => {
    const longNote = 'あ'.repeat(600);
    const row = reservationToRow('id7', {
      customer: { name: 'X', phone: '0' },
      slots: [],
      note: longNote,
    });
    expect(row.note.length).toBe(500);
  });

  it('displayId が Firestore document に保存されていればそれを使う', () => {
    const row = reservationToRow('abc123', {
      customer: { name: 'X', phone: '0' },
      slots: [],
      displayId: 'F-CUSTOM',
    });
    expect(row.displayId).toBe('F-CUSTOM');
  });

  it('displayId 未保存の旧予約は doc.id から fallback 生成（backfill 前の保険）', () => {
    const row = reservationToRow('abcdef123456', {
      customer: { name: 'X', phone: '0' },
      slots: [],
    });
    expect(row.displayId).toBe('F-ABCDEF');
  });
});
