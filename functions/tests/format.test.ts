// 純粋関数フォーマッタのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import { formatCustomerAddress, formatSaunaOptions } from '../src/lib/format';

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
