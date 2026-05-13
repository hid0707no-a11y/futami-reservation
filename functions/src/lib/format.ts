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

/**
 * 表示用予約番号を生成する。
 *
 * 2026-05-13 新設（要望#8 桁数短縮）。Firestore Auto ID（20文字 base62: a-z A-Z 0-9）は
 * 「複雑で長い」というクレームが運営から寄せられたため、人間可読な短縮版を
 * 別フィールド `displayId` として保持する。内部参照は引き続き `id`（Auto ID）。
 *
 * 形式: `F-XXXXXX` （F=Futami、Auto ID 先頭6文字を `toUpperCase()` で大文字化）
 *
 * 注意: 元の Auto ID は base62 (62文字種) だが、`toUpperCase()` で大小英字が
 * 同じ文字に潰れるため、生成空間は base36（36文字種）相当に圧縮される。
 * 衝突可能性: 36^6 ≈ 21億通り。1日100件・5年運用（18万件）で誕生日逆算 ≈ 0.001%。
 * 実用上は許容範囲。衝突が顕在化するスケール（年100万件）に達したら、
 * generateDisplayId 内で衝突検知 + 再試行に切替えるか、桁数を8文字に拡張する。
 */
export function generateDisplayId(autoId: string): string {
  if (!autoId) return '';
  // 0/O・1/I 等の紛らわしい文字が含まれる可能性はあるが、運営の口頭伝達は
  // 大文字統一で混乱を避ける（電話で「エフ・ハイフン・エー・ビー・シー…」と読む）。
  return 'F-' + autoId.substring(0, 6).toUpperCase();
}
