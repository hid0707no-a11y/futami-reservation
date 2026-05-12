// 共通ロガー SSOT
//
// 2026-05-05 新設（/gfu Phase B-5）。
// index.ts に散在する console.log/console.error/console.warn を構造化ロガーに集約する基盤。
//
// 出力形式：Cloud Logging で集約しやすい JSON line。
// severity: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' で Cloud Logging severity と一致。
//
// ★参照置換は B-1（市川さん発注 or 段階的）で実施。今回は SSOT 作成のみ。

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface LogEntry {
  severity: LogSeverity;
  message: string;
  audit?: boolean;
  action?: string;
  ip?: string;
  userAgent?: string;
  origin?: string;
  timestamp?: string;
  [key: string]: any;
}

interface RequestLike {
  headers?: Record<string, any>;
  ip?: string;
  method?: string;
  path?: string;
}

function extractRequestMeta(req?: RequestLike): Partial<LogEntry> {
  if (!req) return {};
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown',
    userAgent: req.headers?.['user-agent'] || '',
    origin: req.headers?.origin || '',
  };
}

function emit(entry: LogEntry): void {
  const out = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  switch (entry.severity) {
    case 'DEBUG':
    case 'INFO':
      console.log(out);
      break;
    case 'WARNING':
      console.warn(out);
      break;
    case 'ERROR':
    case 'CRITICAL':
      console.error(out);
      break;
  }
}

// ─────────────────────────────────────────────
// 監査ログ（既存 auditLog と互換）
// ─────────────────────────────────────────────
export function audit(action: string, details: Record<string, any>, req?: RequestLike): void {
  emit({
    severity: 'INFO',
    message: `AUDIT: ${action}`,
    audit: true,
    action,
    ...extractRequestMeta(req),
    ...details,
  });
}

// ─────────────────────────────────────────────
// メール送信失敗（旧 .catch(()=>{}) 黙殺の置換）
// ─────────────────────────────────────────────
export type MailKind = 'confirmation' | 'staff' | 'cancellation';

export function logMailFailure(kind: MailKind, meta: Record<string, any>, req?: RequestLike): (e: any) => void {
  return (e: any) => {
    emit({
      severity: 'ERROR',
      message: `MAIL_FAILURE: ${kind}`,
      audit: true,
      action: `mail.${kind}.failed`,
      error: String(e?.message || e),
      ...extractRequestMeta(req),
      ...meta,
    });
  };
}

// ─────────────────────────────────────────────
// 冪等性キー保存失敗
// ─────────────────────────────────────────────
export function logIdempotencyFailure(reservationId: string, req?: RequestLike): (e: any) => void {
  return (e: any) => {
    emit({
      severity: 'WARNING',
      message: 'IDEMPOTENCY_KEY_SAVE_FAILED',
      audit: true,
      action: 'idempotency.save_failed',
      reservationId,
      error: String(e?.message || e),
      ...extractRequestMeta(req),
    });
  };
}

// ─────────────────────────────────────────────
// 一般 ERROR / WARN（catch ブロックで呼ぶ）
// ─────────────────────────────────────────────
export function logError(action: string, error: any, meta: Record<string, any> = {}, req?: RequestLike): void {
  emit({
    severity: 'ERROR',
    message: `ERROR: ${action}`,
    action,
    error: String(error?.message || error),
    stack: error?.stack,
    ...extractRequestMeta(req),
    ...meta,
  });
}

export function logWarn(action: string, meta: Record<string, any> = {}, req?: RequestLike): void {
  emit({
    severity: 'WARNING',
    message: `WARN: ${action}`,
    action,
    ...extractRequestMeta(req),
    ...meta,
  });
}

export function logInfo(action: string, meta: Record<string, any> = {}, req?: RequestLike): void {
  emit({
    severity: 'INFO',
    message: `INFO: ${action}`,
    action,
    ...extractRequestMeta(req),
    ...meta,
  });
}
