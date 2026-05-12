// レート制限（インメモリ・IPベース）
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// 旧 index.ts:30-105 を集約。
//
// ★既知の制約（CLAUDE.md にも記載）：
// インメモリ実装のため、Cloud Functions Gen2 で複数インスタンス並列時に
// IP別カウントはインスタンス間で共有されない。最終防衛線は冪等性キー（Firestore）。
// Phase B 以降の課題：Firestore 移行 or Memorystore Redis 化（緊急度低）。

import { audit } from './logger';

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export const RATE_LIMITS: Record<string, number> = {
  createReservation: 10,
  cancelReservation: 10,
  updateReservation: 20,
  listReservations: 30,
  availability: 60,
  futamiDays: 30,
  default: 60,
};

export const AUTH_FAIL_WINDOW_MS = 60 * 1000;
export const AUTH_FAIL_LIMIT = 10;

interface RateEntry {
  count: number;
  resetAt: number;
}

// テストから上書き・参照可能にするためエクスポート
export const rateLimitStore: Map<string, RateEntry> = new Map();

function ipFromReq(req: any): string {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

/**
 * エンドポイント別レート制限。
 * 戻り値：true=通過、false=429 を送信済み（呼出側は早期 return）
 */
export function checkRateLimit(req: any, res: any, endpoint: string): boolean {
  const ip = ipFromReq(req);
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  const limit = RATE_LIMITS[endpoint] || RATE_LIMITS.default;

  let entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(key, entry);
  }

  entry.count++;
  if (entry.count > limit) {
    audit('rate_limit.exceeded', { endpoint, ip, count: entry.count, limit }, req);
    res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
    return false;
  }
  return true;
}

/**
 * 認証失敗専用レートリミット。
 * 通常レート制限とは別カウンタ。失敗時のみ recordAuthFailure() を呼ぶ。
 */
export function checkAuthFailRateLimit(req: any, res: any): boolean {
  const ip = ipFromReq(req);
  const key = `auth_fail:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) return true;
  if (entry.count >= AUTH_FAIL_LIMIT) {
    audit('auth.rate_limited', { ip, count: entry.count }, req);
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'too_many_auth_failures', retryAfter });
    return false;
  }
  return true;
}

export function recordAuthFailure(req: any): void {
  const ip = ipFromReq(req);
  const key = `auth_fail:${ip}`;
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + AUTH_FAIL_WINDOW_MS };
    rateLimitStore.set(key, entry);
  }
  entry.count++;
}

/** 古いエントリを定期クリーンアップ（メモリリーク防止）。 */
export function startRateLimitCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore) {
      if (entry.resetAt <= now) rateLimitStore.delete(key);
    }
  }, 5 * 60 * 1000);
}
