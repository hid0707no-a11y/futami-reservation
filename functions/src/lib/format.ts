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

/**
 * テニス予約の slot キー配列 → '10:00〜11:00' のような人が読める時間帯表記。
 *
 * 2026-07-21 新設。テニスは startDate === endDate のため、メールが「日程：2026-08-05」で
 * 終わり時刻がどこにも出ていなかった。半面プランは30分刻みの1時間枠＝時刻そのものが商品で、
 * 日付だけの控えでは当日の食い違いが起きる。
 *
 * 入力は `roomId|YYYY-MM-DD|時刻` 形式（createReservation.ts / reservationPlans.ts と同じ）。
 * 時刻部分の形式は3種を受ける（legacyTennisKeysForCanonicalSlots のコメントと同じ前提）：
 *   - `HHMM`（現行 canonical・30分枠）      例 1000 → 10:00〜10:30
 *   - `H:MM` / `HH:MM`（旧colon形式・30分枠） 例 10:30 → 10:30〜11:00
 *   - `H` / `HH`（旧staff整数時・1時間占有）  例 8 → 08:00〜09:00
 * 解釈できない要素は無視し、1つも解釈できなければ '' を返す（時刻行を出さない）。
 *
 * 複数コート予約でも時間帯は全コート共通（normalizeTennisSlots が一致を強制）のため、
 * 時刻を集合に畳んでから連続する枠を1つの範囲にまとめる。
 * 例: ['court_wall|2026-08-05|1000','court_wall|2026-08-05|1030'] → '10:00〜11:00'
 */
export function formatTennisTimeRanges(slots: unknown): string {
  if (!Array.isArray(slots)) return '';

  // 開始分 → 終了分（同じ開始が複数コート分来るので Map で畳む）
  const spans = new Map<number, number>();
  for (const slot of slots) {
    if (typeof slot !== 'string') continue;
    const parts = slot.split('|');
    if (parts.length !== 3) continue;
    const time = parts[2];
    let start: number | null = null;
    let durationMin = 30;
    if (/^\d{4}$/.test(time)) {
      start = Number(time.slice(0, 2)) * 60 + Number(time.slice(2, 4));
    } else if (/^\d{1,2}:\d{2}$/.test(time)) {
      const [h, m] = time.split(':');
      start = Number(h) * 60 + Number(m);
    } else if (/^\d{1,2}$/.test(time)) {
      start = Number(time) * 60;
      durationMin = 60; // 旧staff整数時は1時間占有
    }
    if (start === null || start < 0 || start >= 24 * 60) continue;
    const end = start + durationMin;
    const known = spans.get(start);
    if (known === undefined || end > known) spans.set(start, end);
  }
  if (spans.size === 0) return '';

  const sorted = Array.from(spans.entries()).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  const hhmm = (total: number): string =>
    String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  return merged.map(([start, end]) => `${hhmm(start)}〜${hhmm(end)}`).join('、');
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
