/**
 * サウナの予約締切（2026-09-02 運営要望・西田さん）
 *
 * 「今14:58です。15:00予約可能になってる状況に気付きました。
 *   各枠予約は4時間前まで予約可能の設定にしていただけたらと思います。」
 *
 * ★これまで時刻の締切はサーバに一切無かった（validation.ts は startDate < 今日 を見るだけ）。
 *   同じ日の中で「もう始まっている枠」を弾いていたのは index.html の
 *   `hour <= new Date().getHours()` 1行だけ＝画面を経由しなければ素通りしていた。
 *   よってこの締切はサーバを正本にする。
 *
 * ★職員（検証済み Bearer）は対象外。電話で受けた当日の予約を運営が代理入力できなくなると
 *   既存の受付導線が壊れる（2026-08-16 サウナのメール必須と同じ判断）。
 *
 * ★枠の開始時刻は slots の先頭「時」と一致しない：
 *     A 10:00-12:00 → slots [10,11]    開始 10:00
 *     B 12:30-14:30 → slots [12,13,14] 開始 12:30（先頭の時は 12）
 *     C 15:00-17:00 → slots [15,16]    開始 15:00
 *     D 17:30-19:30 → slots [17,18,19] 開始 17:30（先頭の時は 17）
 *   先頭の時をそのまま使うと B と D が 30 分早く締まる。
 *
 * ★ふたみの日（plan_sauna_futami / sauna_share）も同じ4枠の時間帯なので同じ表で当たる。
 *
 * 画面側の対＝assets/js/availability.js（`isSaunaLeadTimeClosed`）。
 * 2本がずれると「画面では押せるのにサーバが400」になるため
 * functions/tests/bookingCutoff.test.ts が両方を読んで突合する。
 */

/** 開始の何分前で締め切るか。運営要望は4時間。 */
export const SAUNA_LEAD_MINUTES = 240;

/** slots の先頭の「時」→ その枠が実際に始まる「0時からの分」 */
export const SAUNA_SLOT_START_MIN: Readonly<Record<number, number>> = {
  10: 600,   // A 10:00
  12: 750,   // B 12:30
  15: 900,   // C 15:00
  17: 1050,  // D 17:30
};

/** 枠の開始（0時からの分）。表に無ければ先頭の時ちょうどとみなす。 */
export function saunaStartMinutes(slots: readonly number[] | undefined | null): number | null {
  if (!slots || slots.length === 0) return null;
  const h = slots[0];
  if (typeof h !== 'number' || !Number.isFinite(h)) return null;
  return Object.prototype.hasOwnProperty.call(SAUNA_SLOT_START_MIN, h)
    ? SAUNA_SLOT_START_MIN[h] : h * 60;
}

/**
 * 締切を過ぎているか。
 * @param slots     canonical 化後の slot の「時」の配列（昇順・その日の分）
 * @param startDate 'YYYY-MM-DD'
 * @param now       現在時刻。★サーバは UTC で動くので JST は下で明示的に足す。
 *
 * 「4時間前まで予約可能」なので、ちょうど4時間前は可・1分でも過ぎたら不可。
 */
export function isSaunaLeadTimeClosed(
  slots: readonly number[] | undefined | null,
  startDate: string,
  now: Date,
  leadMinutes: number = SAUNA_LEAD_MINUTES,
): boolean {
  if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return false;
  const startMin = saunaStartMinutes(slots);
  if (startMin === null) return false;
  // JST を明示（サーバは UTC）。ここを local 依存で書くと本番だけ9時間ずれる。
  const midnightJstMs = Date.parse(`${startDate}T00:00:00+09:00`);
  if (Number.isNaN(midnightJstMs)) return false;
  const startAtMs = midnightJstMs + startMin * 60000;
  return now.getTime() > startAtMs - leadMinutes * 60000;
}

/**
 * canonical の slot キー（`roomId|YYYY-MM-DD|hour`）から、その日の「時」を昇順で取り出す。
 * サウナは全 slot が startDate 上にあるので、先頭が枠の開始の「時」になる。
 */
export function slotHoursOnDate(slotKeys: readonly string[], date: string): number[] {
  const hours: number[] = [];
  for (const key of slotKeys || []) {
    const parts = String(key).split('|');
    if (parts.length === 3 && parts[1] === date) {
      const h = Number(parts[2]);
      if (Number.isInteger(h)) hours.push(h);
    }
  }
  return hours.sort((a, b) => a - b);
}
