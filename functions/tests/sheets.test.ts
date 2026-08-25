// スプシ同期 純粋ロジックのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import { rowToArray, reservationToRow, SHEET_HEADERS, ReservationRow } from '../src/lib/sheets';
import { SHEET_LAST_COLUMN } from '../src/constants';

/** 列数 → スプシの列記号（1→A, 26→Z, 27→AA）。 */
function columnLetter(n: number): string {
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

describe('SHEET_HEADERS', () => {
  it('27列（A:AA）に固定されている', () => {
    expect(SHEET_HEADERS).toHaveLength(27);
  });

  // ★列を足したのに SHEET_LAST_COLUMN を直し忘れると、増やした列がスプシに
  //   書かれないまま静かに落ちる（clear/update の範囲がこの定数だけで決まるため）。
  //   ★5 の作業手順にある SYNC_CLEAR_RANGE_* は参照0件の死に定数なので当てにしない。
  it('SHEET_LAST_COLUMN が列数と一致している（直し忘れを止める）', () => {
    expect(SHEET_LAST_COLUMN).toBe(columnLetter(SHEET_HEADERS.length));
  });

  it('列名に重複が無い', () => {
    expect(new Set(SHEET_HEADERS).size).toBe(SHEET_HEADERS.length);
  });

  it('最初の5列はメタ情報', () => {
    expect(SHEET_HEADERS.slice(0, 5)).toEqual(['予約ID', '登録日時', 'ステータス', 'プランID', '部屋ID']);
  });

  it('郵便番号と住所は2026-04-27追加（commit 856c194）でメール直後に並ぶ', () => {
    const emailIdx = SHEET_HEADERS.indexOf('メール');
    expect(SHEET_HEADERS[emailIdx + 1]).toBe('郵便番号');
    expect(SHEET_HEADERS[emailIdx + 2]).toBe('住所');
  });

  it('予約番号は2026-05-13追加でZ列（26列目）に並ぶ', () => {
    expect(SHEET_HEADERS[25]).toBe('予約番号');
  });

  // ★2026-08-25 要望⑩。「お名前」の直後ではなく末尾に置いたのは、途中に挿すと
  //   L列以降を参照している外部の集計・ピボットが静かにずれるため。
  it('フリガナは2026-08-25追加で末尾（AA列・27列目）に並ぶ', () => {
    expect(SHEET_HEADERS[SHEET_HEADERS.length - 1]).toBe('フリガナ');
    expect(SHEET_HEADERS[26]).toBe('フリガナ');
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
      customerKana: 'ヤマダタロウ',
    };
    const arr = rowToArray(row);
    expect(arr).toHaveLength(27);
    expect(arr).toHaveLength(SHEET_HEADERS.length); // ヘッダと列数がずれない
    expect(arr[0]).toBe('abc123');
    expect(arr[2]).toBe('confirmed');
    expect(arr[arr.length - 1]).toBe('ヤマダタロウ'); // 末尾は フリガナ（AA列）
    expect(arr[arr.length - 2]).toBe('F-ABC123');    // その手前が 予約番号（Z列）
    expect(arr[arr.length - 3]).toBe('備考テスト');
  });

  it('フリガナ未入力（旧予約）は空文字で埋まり、列がずれない', () => {
    const row = reservationToRow('id-old', {
      status: 'confirmed', planId: 'stay_6', roomIds: ['room_6_1'],
      startDate: '2026-05-10', endDate: '2026-05-11',
      customer: { name: '山田', phone: '090-0000-0000' },
    });
    expect(row.customerKana).toBe('');
    const arr = rowToArray(row);
    expect(arr).toHaveLength(SHEET_HEADERS.length);
    expect(arr[arr.length - 1]).toBe('');
  });

  it('フリガナは customer.kana から拾う', () => {
    const row = reservationToRow('id-new', {
      status: 'confirmed', planId: 'stay_6', roomIds: ['room_6_1'],
      startDate: '2026-05-10', endDate: '2026-05-11',
      customer: { name: '山田 太郎', kana: 'ヤマダ タロウ', phone: '090-0000-0000' },
    });
    expect(row.customerKana).toBe('ヤマダ タロウ');
    expect(rowToArray(row)[SHEET_HEADERS.indexOf('フリガナ')]).toBe('ヤマダ タロウ');
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
