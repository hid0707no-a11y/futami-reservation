// メール送信モジュール
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// SMTP transporter ・予約確認/キャンセル/スタッフ通知/監視アラート の4本を集約。
// 旧 index.ts:64-194 + 1297-1318 を移植。

import * as nodemailer from 'nodemailer';

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
export const STAFF_EMAIL = process.env.STAFF_EMAIL || 'info@fureai-iyosasaeru.com';

export const MONITOR_NOTIFY_EMAILS = [STAFF_EMAIL, 'hid0707no@gmail.com'];

// #32 監視アラートの第二経路（SMTP 単一依存の解消）。
// DISCORD_WEBHOOK_URL 設定時のみ有効・既定は no-op（社長が env を入れれば有効化）。
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

async function postDiscordAlert(subject: string, body: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const content = `**${subject}**\n${body}`.slice(0, 1900); // Discord 2000字制限
    const resp = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'futami-monitor/1.0' }, // UA 無しだと 403
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) console.error('[monitor] discord webhook non-OK:', resp.status);
  } catch (e: any) {
    console.error('[monitor] discord webhook failed:', e?.message || e);
  }
}

export const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export interface MailData {
  planName: string;
  roomName: string;
  startDate: string;
  endDate: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress?: string;
  note: string;
  reservationId: string;
  guestCount?: number;
  isCamp?: boolean;
  isFutamiDay?: boolean;
  isTennis?: boolean;
  saunaOptionsText?: string;
}

/** 予約確認メール（顧客向け）。送信失敗時は呼出側で .catch して logMailFailure へ。 */
export async function sendConfirmationEmail(data: MailData): Promise<void> {
  if (!transporter || !data.customerEmail) return;
  try {
    const subject = `【ふたみふれあい公園】ご予約を受け付けました（${data.startDate}）`;
    const body = `${data.customerName} 様

ふたみ潮風ふれあい公園をご予約いただきありがとうございます。
以下の内容で予約を受け付けました。

━━━━━━━━━━━━━━━━━━
予約番号：${data.reservationId}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.guestCount ? '\n' + (data.isCamp ? '区画数' : '人数') + '：' + data.guestCount + (data.isCamp ? '区画' : '名') : ''}${data.customerAddress ? '\nご住所：' + data.customerAddress : ''}${data.saunaOptionsText ? '\nオプション：' + data.saunaOptionsText : ''}${data.note ? '\n備考：' + data.note : ''}
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
  if (!transporter) return;
  try {
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
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.guestCount ? '\n' + (data.isCamp ? '区画数' : '人数') + '：' + data.guestCount + (data.isCamp ? '区画' : '名') : ''}${data.saunaOptionsText ? '\nオプション：' + data.saunaOptionsText : ''}${data.note ? '\n備考：' + data.note : ''}
`;
    await transporter.sendMail({
      from: `"ふたみ予約システム" <${SMTP_USER}>`,
      to: STAFF_EMAIL,
      subject,
      text: body,
    });
    console.log('Staff notification sent for', data.reservationId);
  } catch (e) {
    console.error('Failed to send staff notification:', e);
    throw e;
  }
}

/** キャンセル確認メール（顧客向け）。 */
export async function sendCancellationEmail(data: MailData): Promise<void> {
  if (!transporter || !data.customerEmail) return;
  try {
    const subject = `【ふたみふれあい公園】ご予約をキャンセルしました（${data.startDate}）`;
    const body = `${data.customerName} 様

以下のご予約をキャンセルいたしました。

━━━━━━━━━━━━━━━━━━
予約番号：${data.reservationId}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}
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

/** staffHealthMonitor 用アラートメール。失敗しても監視ループ自体は止めない。 */
export async function sendMonitorAlert(subject: string, body: string): Promise<void> {
  // #32 SMTP に加えて Discord webhook（設定時のみ）にも通知＝アラート単一経路依存の解消
  await postDiscordAlert(subject, body);
  if (!transporter) {
    console.error('[monitor] transporter 未設定のためメール通知スキップ（Discord 経路は上で試行済）');
    return;
  }
  try {
    await transporter.sendMail({
      from: `"ふたみ予約監視" <${SMTP_USER}>`,
      replyTo: STAFF_EMAIL,
      to: MONITOR_NOTIFY_EMAILS.join(','),
      subject,
      text: body,
    });
    console.log('[monitor] alert email sent');
  } catch (e) {
    console.error('[monitor] alert email failed:', e);
  }
}
