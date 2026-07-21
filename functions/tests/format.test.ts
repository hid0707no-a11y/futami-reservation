// 純粋関数フォーマッタのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import {
  formatCustomerAddress,
  formatSaunaOptions,
  formatTennisTimeRanges,
  generateDisplayId,
} from '../src/lib/format';

describe('formatCustomerAddress', () => {
  it('全フィールド揃っている場合は 〒+住所1+住所2 を整形する', () => {
    expect(formatCustomerAddress({
      zip: '791-3120',
      address1: '愛媛県伊予市双海町',
      address2: '高野川123',
    })).toBe('〒791-3120 愛媛県伊予市双海町 高野川123');
  });

  it('zipなしでも住所1+2を整形する', () => {
    expect(formatCustomerAddress({
      address1: '東京都品川区',
      address2: '東品川1-2-3',
    })).toBe('東京都品川区 東品川1-2-3');
  });

  it('address2がない場合はaddress1のみ', () => {
    expect(formatCustomerAddress({
      zip: '100-0001',
      address1: '東京都千代田区',
    })).toBe('〒100-0001 東京都千代田区');
  });

  it('address1/address2の両方が空文字なら空文字を返す（zipのみは住所扱いしない）', () => {
    expect(formatCustomerAddress({ zip: '791-3120', address1: '', address2: '' })).toBe('');
    expect(formatCustomerAddress({ zip: '791-3120' })).toBe('');
  });

  it('null/undefined を渡しても安全に空文字を返す', () => {
    expect(formatCustomerAddress(null)).toBe('');
    expect(formatCustomerAddress(undefined)).toBe('');
  });

  it('前後の空白はトリムする', () => {
    expect(formatCustomerAddress({
      zip: '  791-3120  ',
      address1: '  愛媛県  ',
      address2: '  双海町  ',
    })).toBe('〒791-3120 愛媛県 双海町');
  });
});

describe('formatSaunaOptions', () => {
  it('null/undefined/空オブジェクト → 空文字', () => {
    expect(formatSaunaOptions(null)).toBe('');
    expect(formatSaunaOptions(undefined)).toBe('');
    expect(formatSaunaOptions({})).toBe('');
  });

  it('タオル数のみ → タオル×N', () => {
    expect(formatSaunaOptions({ towels: 2 })).toBe('タオル×2');
  });

  it('複数オプションは／区切り、氷は20kg単位で表示', () => {
    expect(formatSaunaOptions({ towels: 2, tarpTent: 1, ice20kg: 1 }))
      .toBe('タオル×2／タープテント／氷20kg');
  });

  it('氷2袋 → 氷40kg', () => {
    expect(formatSaunaOptions({ ice20kg: 2 })).toBe('氷40kg');
  });

  it('値が 0 のオプションは無視する', () => {
    expect(formatSaunaOptions({ towels: 0, tarpTent: 0, ice20kg: 1 })).toBe('氷20kg');
  });
});

describe('formatTennisTimeRanges', () => {
  it('半面1時間（30分枠×2）を 10:00〜11:00 にまとめる', () => {
    expect(formatTennisTimeRanges([
      'court_wall|2026-08-05|1000',
      'court_wall|2026-08-05|1030',
    ])).toBe('10:00〜11:00');
  });

  it('30分1枠でも開始〜終了を出す', () => {
    expect(formatTennisTimeRanges(['court_wall|2026-08-05|1330'])).toBe('13:30〜14:00');
  });

  it('複数コートで同一時間帯なら1つの範囲に畳む', () => {
    expect(formatTennisTimeRanges([
      'court_1|2026-08-05|0900', 'court_1|2026-08-05|0930',
      'court_2|2026-08-05|0900', 'court_2|2026-08-05|0930',
    ])).toBe('09:00〜10:00');
  });

  it('離れた時間帯は 、 区切りで別範囲にする', () => {
    expect(formatTennisTimeRanges([
      'court_wall|2026-08-05|1000', 'court_wall|2026-08-05|1030',
      'court_wall|2026-08-05|1500', 'court_wall|2026-08-05|1530',
    ])).toBe('10:00〜11:00、15:00〜16:00');
  });

  it('順不同でも昇順に並べ直す', () => {
    expect(formatTennisTimeRanges([
      'court_wall|2026-08-05|1530',
      'court_wall|2026-08-05|1000',
      'court_wall|2026-08-05|1500',
      'court_wall|2026-08-05|1030',
    ])).toBe('10:00〜11:00、15:00〜16:00');
  });

  it('旧staff整数時（1時間占有）も読める', () => {
    expect(formatTennisTimeRanges(['court_1|2026-08-05|8'])).toBe('08:00〜09:00');
    expect(formatTennisTimeRanges(['court_1|2026-08-05|08'])).toBe('08:00〜09:00');
  });

  it('旧colon形式（30分枠）も読める', () => {
    expect(formatTennisTimeRanges([
      'court_1|2026-08-05|10:00', 'court_1|2026-08-05|10:30',
    ])).toBe('10:00〜11:00');
  });

  it('解釈できない slot は無視し、全滅なら空文字（時刻行を出さない）', () => {
    expect(formatTennisTimeRanges([])).toBe('');
    expect(formatTennisTimeRanges(null)).toBe('');
    expect(formatTennisTimeRanges(undefined)).toBe('');
    expect(formatTennisTimeRanges('court_1|2026-08-05|1000')).toBe('');
    expect(formatTennisTimeRanges(['壊れたキー', 'court_1|2026-08-05|abcd'])).toBe('');
    expect(formatTennisTimeRanges(['court_1|2026-08-05|9999'])).toBe('');
    expect(formatTennisTimeRanges([
      'court_1|2026-08-05|くずれ', 'court_1|2026-08-05|1000',
    ])).toBe('10:00〜10:30');
  });
});

describe('generateDisplayId', () => {
  it('Auto ID 先頭6文字を大文字化して F- prefix で返す', () => {
    expect(generateDisplayId('abcdef123456ghijklmn')).toBe('F-ABCDEF');
  });

  it('全部数字でも問題なく動く', () => {
    expect(generateDisplayId('012345abcdef')).toBe('F-012345');
  });

  it('大小英字混在は大文字化で正規化', () => {
    expect(generateDisplayId('aBcDeFghij')).toBe('F-ABCDEF');
  });

  it('空文字を渡したら空文字を返す（フォールバック側で処理）', () => {
    expect(generateDisplayId('')).toBe('');
  });

  it('6文字未満の Auto ID（理論上ありえない短い ID）でも空文字でなく短縮 ID を返す', () => {
    // Firestore Auto ID は 20文字固定だが、テスト時の手作り ID 用に堅牢性確保
    expect(generateDisplayId('abc')).toBe('F-ABC');
  });
});
