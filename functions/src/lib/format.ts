// 純粋関数フォーマッタ
//
// 2026-05-05 新設（/gfu Phase A-3 / B-1 部分切出し）。
// 副作用ゼロ・依存ゼロの整形関数群。jest ユニットテスト対象。

export interface CustomerLike {
  zip?: string;
  address1?: string;
  address2?: string;
}

/**
 * 顧客住所を 1行表記に整形する。
 * 例: { zip: '791-3120', address1: '愛媛県伊予市双海町', address2: '高野川123' }
 *     → '〒791-3120 愛媛県伊予市双海町 高野川123'
 */
export function formatCustomerAddress(c: CustomerLike | null | undefined): string {
  if (!c) return '';
  const zip = (c.zip || '').toString().trim();
  const a1 = (c.address1 || '').toString().trim();
  const a2 = (c.address2 || '').toString().trim();
  if (!a1 && !a2) return '';
  const zipPart = zip ? `〒${zip} ` : '';
  return `${zipPart}${a1}${a2 ? ' ' + a2 : ''}`.trim();
}

export interface SaunaOptionsLike {
  towels?: number;
  tarpTent?: number;
  ice20kg?: number;
}

/**
 * サウナオプションを '／' 区切り表記に整形する。
 * 例: { towels: 2, ice20kg: 1 } → 'タオル×2／氷20kg'
 *     null/undefined/空 → ''
 */
export function formatSaunaOptions(opts: SaunaOptionsLike | null | undefined): string {
  if (!opts) return '';
  const parts: string[] = [];
  if ((opts.towels ?? 0) > 0) parts.push(`タオル×${opts.towels}`);
  if ((opts.tarpTent ?? 0) > 0) parts.push('タープテント');
  if ((opts.ice20kg ?? 0) > 0) parts.push(`氷${(opts.ice20kg ?? 0) * 20}kg`);
  return parts.join('／');
}
