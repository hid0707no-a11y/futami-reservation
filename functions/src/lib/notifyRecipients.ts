// スタッフ通知メールの宛先解決
//
// 2026-08-01 新設（運営要望①「サウナ予約情報のみ別担当者へ共有したい」）。
//
// 従来 sendStaffNotification は STAFF_EMAIL 1宛先固定で、その共有メールボックスを
// 見られない担当者は staff.html を開かないと新規予約に気づけなかった。
// サウナ予約に限り SAUNA_NOTIFY_EMAILS（env・カンマ区切り）を宛先に加える。
//
// ⚠️ リポジトリは public。実アドレスはコードに書かず functions/.env（.gitignore 済）で渡す。
//
// mail.ts を import しない（mail.ts → notifyRecipients.ts の一方向依存を保つ）。
// STAFF_EMAIL の定義もこちらへ移し、mail.ts は import + re-export する。

export const STAFF_EMAIL = process.env.STAFF_EMAIL || 'info@fureai-iyosasaeru.com';

/**
 * サウナ予約の追加通知先。未設定なら空配列＝従来どおり STAFF_EMAIL のみへ送る
 * （env 落ちで予約自体が失敗するのは避ける。気づけるように下で ERROR ログを出す）。
 */
export function saunaNotifyEmails(): string[] {
  return (process.env.SAUNA_NOTIFY_EMAILS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export interface ReservationIdentity {
  planId?: string;
  roomIds?: string[];
}

/**
 * サウナ予約かどうか。planId と roomIds の両方を見る。
 *  - 通常サウナ: planId = sauna_1〜sauna_4 / roomIds = ['sauna']
 *  - ふたみの日: planId = plan_sauna_futami / roomIds = ['sauna_share']
 * 片方だけで判定すると、職員画面の入力経路やプラン追加で取りこぼす。
 */
export function isSaunaReservation(input: ReservationIdentity): boolean {
  const planId = typeof input?.planId === 'string' ? input.planId : '';
  if (/^sauna_[1-4]$/.test(planId)) return true;
  if (planId === 'plan_sauna_futami') return true;

  const roomIds = Array.isArray(input?.roomIds) ? input.roomIds : [];
  return roomIds.some(r => r === 'sauna' || r === 'sauna_share');
}

/** 大文字小文字を無視して重複を落とす（初出の表記を残す）。 */
function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * スタッフ通知メールの宛先。常に STAFF_EMAIL を含み、サウナ予約だけ担当者を追加する。
 *
 * サウナなのに SAUNA_NOTIFY_EMAILS が空の場合は ERROR ログを出す。
 * mail.ts:「SMTP env 欠落時の沈黙死対策」と同じ思想で、env 落ちにより担当者3名分の
 * 配信が無言で消える状態を Cloud Logging から追えるようにする。
 */
export function resolveStaffRecipients(input: ReservationIdentity): string[] {
  if (!isSaunaReservation(input)) return [STAFF_EMAIL];

  const extra = saunaNotifyEmails();
  if (extra.length === 0) {
    console.error(JSON.stringify({
      severity: 'ERROR',
      audit: true,
      action: 'mail.sauna_recipients_not_configured',
      planId: input?.planId ?? null,
      detail: 'SAUNA_NOTIFY_EMAILS 未設定のためサウナ担当者への通知をスキップ',
    }));
    return [STAFF_EMAIL];
  }

  return dedupeEmails([STAFF_EMAIL, ...extra]);
}
