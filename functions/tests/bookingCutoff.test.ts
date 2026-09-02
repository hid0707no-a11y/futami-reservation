// サウナの予約締切（2026-09-02 運営要望・西田さん）
//
// 「今14:58です。15:00予約可能になってる状況に気付きました。
//   各枠予約は4時間前まで予約可能の設定にしていただけたらと思います。」
//
// contact.test.ts と同じく、サーバ側（TS）と画面側（assets/js）の2本の実装が
// ずれていないことも併せて見張る。ずれると「画面では押せるのにサーバが400」になる。

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClientAvailability = require('../../assets/js/availability.js');

import {
  SAUNA_LEAD_MINUTES,
  SAUNA_SLOT_START_MIN,
  saunaStartMinutes,
  isSaunaLeadTimeClosed,
  slotHoursOnDate,
} from '../src/lib/bookingCutoff';

// JST の時刻から Date を作る（テストはどのTZでも同じ結果になること）
const jst = (iso: string): Date => new Date(`${iso}+09:00`);

describe('枠の開始時刻', () => {
  it('A 10:00-12:00 は slots[10,11] で開始 10:00', () => {
    expect(saunaStartMinutes([10, 11])).toBe(10 * 60);
  });
  it('★B 12:30-14:30 は slots[12,...] だが開始は 12:30（先頭の時ではない）', () => {
    expect(saunaStartMinutes([12, 13, 14])).toBe(12 * 60 + 30);
  });
  it('C 15:00-17:00 は開始 15:00', () => {
    expect(saunaStartMinutes([15, 16])).toBe(15 * 60);
  });
  it('★D 17:30-19:30 は slots[17,...] だが開始は 17:30', () => {
    expect(saunaStartMinutes([17, 18, 19])).toBe(17 * 60 + 30);
  });
  it('表に無い時は その時ちょうどとみなす', () => {
    expect(saunaStartMinutes([9])).toBe(9 * 60);
  });
  it('空・未定義は null', () => {
    expect(saunaStartMinutes([])).toBeNull();
    expect(saunaStartMinutes(undefined)).toBeNull();
  });
});

describe('締切の判定（運営が実際に見た状況の再現）', () => {
  it('★14:58 に 15:00 の C 枠 → 締切済み（これが報告された事象）', () => {
    expect(isSaunaLeadTimeClosed([15, 16], '2026-09-02', jst('2026-09-02T14:58:00'))).toBe(true);
  });
  it('ちょうど4時間前（11:00）はまだ予約できる＝「4時間前まで予約可能」', () => {
    expect(isSaunaLeadTimeClosed([15, 16], '2026-09-02', jst('2026-09-02T11:00:00'))).toBe(false);
  });
  it('1分でも過ぎたら（11:01）締切', () => {
    expect(isSaunaLeadTimeClosed([15, 16], '2026-09-02', jst('2026-09-02T11:01:00'))).toBe(true);
  });
  it('D 枠(17:30)は 13:30 まで可・13:31 で締切（30分の差を落とさない）', () => {
    expect(isSaunaLeadTimeClosed([17, 18, 19], '2026-09-02', jst('2026-09-02T13:30:00'))).toBe(false);
    expect(isSaunaLeadTimeClosed([17, 18, 19], '2026-09-02', jst('2026-09-02T13:31:00'))).toBe(true);
  });
  it('翌日の枠は当日の遅い時刻でも予約できる', () => {
    expect(isSaunaLeadTimeClosed([10, 11], '2026-09-03', jst('2026-09-02T23:59:00'))).toBe(false);
  });
  it('★サーバは UTC で動く：UTC 05:58 は JST 14:58 なので C 枠は締切', () => {
    expect(isSaunaLeadTimeClosed([15, 16], '2026-09-02', new Date('2026-09-02T05:58:00Z'))).toBe(true);
  });
  it('★UTC 01:59 は JST 10:59 なので C 枠はまだ予約できる（日付をまたぐ誤りの検出）', () => {
    expect(isSaunaLeadTimeClosed([15, 16], '2026-09-02', new Date('2026-09-02T01:59:00Z'))).toBe(false);
  });
  it('日付の形式が壊れていたら締め切らない（他のバリデーションが先に弾く）', () => {
    expect(isSaunaLeadTimeClosed([15, 16], 'not-a-date', jst('2026-09-02T14:58:00'))).toBe(false);
  });
});

describe('canonical の slot キーから その日の時を取り出す', () => {
  it('startDate の分だけを昇順で返す', () => {
    expect(slotHoursOnDate(
      ['sauna|2026-09-02|16', 'sauna|2026-09-02|15', 'sauna|2026-09-03|10'], '2026-09-02',
    )).toEqual([15, 16]);
  });
  it('ふたみの日（sauna_share）でも同じ', () => {
    expect(slotHoursOnDate(['sauna_share|2026-09-02|17', 'sauna_share|2026-09-02|18'], '2026-09-02'))
      .toEqual([17, 18]);
  });
  it('該当日が無ければ空', () => {
    expect(slotHoursOnDate(['sauna|2026-09-03|10'], '2026-09-02')).toEqual([]);
  });
});

describe('★サーバ側と画面側のドリフト検出', () => {
  it('締切までの分数が一致する', () => {
    expect(ClientAvailability.SAUNA_LEAD_MINUTES).toBe(SAUNA_LEAD_MINUTES);
    expect(SAUNA_LEAD_MINUTES).toBe(240); // 運営要望＝4時間
  });
  it('枠の開始時刻の表が一致する（枠を増減したら両方直す）', () => {
    expect(ClientAvailability.SAUNA_SLOT_START_MIN).toEqual({ ...SAUNA_SLOT_START_MIN });
  });
  it('開始時刻の算出が全枠で一致する', () => {
    for (const slots of [[10, 11], [12, 13, 14], [15, 16], [17, 18, 19], [9], [23]]) {
      expect(ClientAvailability.saunaStartMinutes(slots)).toBe(saunaStartMinutes(slots));
    }
  });
});
