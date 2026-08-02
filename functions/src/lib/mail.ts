// メール送信モジュール
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// SMTP transporter ・予約確認/キャンセル/スタッフ通知/監視アラート の4本を集約。
// 旧 index.ts:64-194 + 1297-1318 を移植。

import * as nodemailer from 'nodemailer';
import { STAFF_EMAIL, resolveStaffRecipients } from './notifyRecipients';

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// 2026-08-01: 定義は notifyRecipients.ts へ移動（宛先解決の SSOT を1ファイルに寄せる）。
// 既存 import 元との互換のためここから re-export し続ける。
export { STAFF_EMAIL };

export const MONITOR_NOTIFY_EMAILS = [STAFF_EMAIL, 'hid0707no@gmail.com'];

// #32 監視アラートの第二経路（SMTP 単一依存の解消）。
// DISCORD_WEBHOOK_URL 設定時のみ有効。未設定は healthMonitor が異常として通知する。
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_TIMEOUT_MS = 5000;

async function postDiscordAlert(subject: string, body: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) throw new Error('discord_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const content = `**${subject}**\n${body}`.slice(0, 1900); // Discord 2000字制限
    const resp = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'futami-monitor/1.0' }, // UA 無しだと 403
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`discord_http_${resp.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Promise.race では Nodemailer 側の接続を中断できない。transport 自体に上限を持たせ、
      // verify/sendMail のいずれも Cloud Functions の実行時間内に必ず終了させる。
      dnsTimeout: 5000,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    })
  : null;

export function isSmtpConfigured(): boolean {
  return transporter !== null;
}

export function isDiscordConfigured(): boolean {
  return DISCORD_WEBHOOK_URL.length > 0;
}

/** Discord webhookを投稿せずGETし、失効・削除・到達不能を毎朝検出する。 */
export async function verifyDiscordConnection(): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) throw new Error('discord_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const resp = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'futami-monitor/1.0' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`discord_verify_http_${resp.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifySmtpConnection(): Promise<void> {
  if (!transporter) throw new Error('smtp_not_configured');
  await transporter.verify();
}

// SMTP env 欠落時の沈黙死対策（2026-07-19）：従来は transporter=null だと全メールが
// 無ログでスキップされ、確認メール全停止に気づく経路がゼロだった。ERROR ログで
// Cloud Logging から追えるようにする（能動検知は healthMonitor Check 8）。
function logSmtpNotConfigured(kind: string, reservationId: string): void {
  console.error(JSON.stringify({
    severity: 'ERROR',
    audit: true,
    action: 'mail.skipped_smtp_not_configured',
    kind,
    reservationId,
    detail: 'SMTP_USER/SMTP_PASS 未設定のためメール送信をスキップ',
  }));
}

export interface MailData {
  planName: string;
  roomName: string;
  /** 宛先解決用の生の予約種別（表示には使わない）。resolveStaffRecipients が参照する。 */
  planId?: string;
  /** 同上。roomIds に 'sauna' / 'sauna_share' が入るとサウナ通知先が追加される。 */
  roomIds?: string[];
  startDate: string;
  endDate: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress?: string;
  note: string;
  reservationId: string;
  /**
   * 人数・区画数の人向け表記（複数行可）。組み立ては純粋関数
   * `format.formatPartyText()` が担当し、本文テンプレートはこれを1箇所差し込むだけ。
   * 例: '人数：中学生以上2名／小学生1名（計3名）' / '区画数：3区画\n人数：5名'
   * 空文字・undefined なら行ごと出さない（「0名」「undefined名」を出さないため）。
   */
  partyText?: string;
  /**
   * ⚠️ 2026-08-03 以降、本文の表示には使わない（人数表記は partyText 経由）。
   * ふたみの日サウナの座席数・キャンプの区画数として呼出側が保持している値。
   */
  guestCount?: number;
  isCamp?: boolean;
  isFutamiDay?: boolean;
  isTennis?: boolean;
  saunaOptionsText?: string;
  /** 時間帯の人向け表記（テニス等の時間制プラン）。例: 「08:00〜10:00、13:00〜14:00」 */
  timeText?: string;
}

/** 予約確認メール（顧客向け）。送信失敗時は呼出側で .catch して logMailFailure へ。 */
export async function sendConfirmationEmail(data: MailData): Promise<void> {
  if (!transporter) {
    if (data.customerEmail) logSmtpNotConfigured('confirmation', data.reservationId);
    return;
  }
  if (!data.customerEmail) return;
  try {
    const subject = `【ふたみふれあい公園】ご予約を受け付けました（${data.startDate}）`;
    const body = `${data.customerName} 様

ふたみ潮風ふれあい公園をご予約いただきありがとうございます。
以下の内容で予約を受け付けました。

━━━━━━━━━━━━━━━━━━
予約番号：${data.reservationId}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.timeText ? '\n時間：' + data.timeText : ''}${data.partyText ? '\n' + data.partyText : ''}${data.customerAddress ? '\nご住所：' + data.customerAddress : ''}${data.saunaOptionsText ? '\nオプション：' + data.saunaOptionsText : ''}${data.note ? '\n備考：' + data.note : ''}
━━━━━━━━━━━━━━━━━━

※このメールは自動送信です。
※ご不明な点がございましたら、お電話にてお問い合わせください。

ふたみ潮風ふれあい公園
TEL: 089-986-0522
`;
    await transporter.sendMail({
      from: `"ふたみふれあい公園" <${SMTP_USER}>`,
      to: data.customerEmail,
      subject,
      text: body,
    });
    console.log('Confirmation email sent to', data.customerEmail);
  } catch (e) {
    console.error('Failed to send confirmation email:', e);
    throw e;
  }
}

/** スタッフ通知メール（新規予約 / キャンセル）。 */
export async function sendStaffNotification(data: MailData, type: 'new' | 'cancel'): Promise<void> {
  if (!transporter) {
    logSmtpNotConfigured(`staff_${type}`, data.reservationId);
    return;
  }
  try {
    // 2026-08-01: サウナ予約だけ運営の担当者を宛先に追加する（要望①）。
    const recipients = resolveStaffRecipients(data);
    const prefix = type === 'new' ? '【新規予約】' : '【キャンセル】';
    const subject = `${prefix} ${data.customerName}様 ${data.startDate} ${data.roomName}`;
    const body = `${prefix}

予約番号：${data.reservationId}
予約者：${data.customerName}
電話：${data.customerPhone}
メール：${data.customerEmail || 'なし'}
ご住所：${data.customerAddress || 'なし'}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.timeText ? '\n時間：' + data.timeText : ''}${data.partyText ? '\n' + data.partyText : ''}${data.saunaOptionsText ? '\nオプション：' + data.saunaOptionsText : ''}${data.note ? '\n備考：' + data.note : ''}
`;
    await transporter.sendMail({
      from: `"ふたみ予約システム" <${SMTP_USER}>`,
      to: recipients.join(', '),
      subject,
      text: body,
    });
    console.log('Staff notification sent for', data.reservationId, `(${recipients.length} recipients)`);
  } catch (e) {
    console.error('Failed to send staff notification:', e);
    throw e;
  }
}

/** キャンセル確認メール（顧客向け）。 */
export async function sendCancellationEmail(data: MailData): Promise<void> {
  if (!transporter) {
    if (data.customerEmail) logSmtpNotConfigured('cancellation', data.reservationId);
    return;
  }
  if (!data.customerEmail) return;
  try {
    const subject = `【ふたみふれあい公園】ご予約をキャンセルしました（${data.startDate}）`;
    const body = `${data.customerName} 様

以下のご予約をキャンセルいたしました。

━━━━━━━━━━━━━━━━━━
予約番号：${data.reservationId}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.timeText ? '\n時間：' + data.timeText : ''}${data.partyText ? '\n' + data.partyText : ''}
━━━━━━━━━━━━━━━━━━

またのご利用をお待ちしております。

ふたみ潮風ふれあい公園
TEL: 089-986-0522
`;
    await transporter.sendMail({
      from: `"ふたみふれあい公園" <${SMTP_USER}>`,
      to: data.customerEmail,
      subject,
      text: body,
    });
    console.log('Cancellation email sent to', data.customerEmail);
  } catch (e) {
    console.error('Failed to send cancellation email:', e);
    throw e;
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface MonitorAlertOptions {
  /** SMTP の verify が失敗済みなら false を渡し、同じ死んだ経路を再度待たない。 */
  useSmtp?: boolean;
}

/**
 * staffHealthMonitor 用アラート。
 * 構成済み経路へ並列送信し、1経路以上の成功をもって通知成功とする。
 * 全経路失敗（または経路未構成）は throw し、onSchedule の retryCount を効かせる。
 */
export async function sendMonitorAlert(
  subject: string,
  body: string,
  options: MonitorAlertOptions = {},
): Promise<void> {
  const attempts: Array<{ channel: 'discord' | 'smtp'; promise: Promise<void> }> = [];

  if (isDiscordConfigured()) {
    attempts.push({ channel: 'discord', promise: postDiscordAlert(subject, body) });
  }
  if (options.useSmtp !== false && transporter) {
    attempts.push({
      channel: 'smtp',
      promise: transporter.sendMail({
      from: `"ふたみ予約監視" <${SMTP_USER}>`,
      replyTo: STAFF_EMAIL,
      to: MONITOR_NOTIFY_EMAILS.join(','),
      subject,
      text: body,
      }).then(() => undefined),
    });
  }

  if (attempts.length === 0) {
    console.error(JSON.stringify({
      severity: 'CRITICAL',
      audit: true,
      action: 'monitor.alert_delivery_failed',
      reason: 'no_configured_channel',
      timestamp: new Date().toISOString(),
    }));
    throw new Error('monitor_alert_no_configured_channel');
  }

  const settled = await Promise.allSettled(attempts.map(a => a.promise));
  const delivered = settled
    .map((result, index) => result.status === 'fulfilled' ? attempts[index].channel : null)
    .filter((channel): channel is 'discord' | 'smtp' => channel !== null);
  const failed = settled
    .map((result, index) => result.status === 'rejected'
      ? { channel: attempts[index].channel, error: errorMessage(result.reason) }
      : null)
    .filter((entry): entry is { channel: 'discord' | 'smtp'; error: string } => entry !== null);

  if (delivered.length > 0) {
    console.log(JSON.stringify({
      severity: failed.length > 0 ? 'WARNING' : 'INFO',
      audit: true,
      action: 'monitor.alert_delivered',
      channels: delivered,
      failed,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  console.error(JSON.stringify({
    severity: 'CRITICAL',
    audit: true,
    action: 'monitor.alert_delivery_failed',
    failed,
    timestamp: new Date().toISOString(),
  }));
  throw new Error('monitor_alert_all_channels_failed');
}
