// Firestore-backed Rate Limiter（多インスタンス対応・opt-in）
//
// 2026-05-05 新設（/gfu Phase 評価5狙い）。
// 既存の lib/rateLimit.ts はインメモリ実装で、Cloud Functions Gen2 で複数インスタンス並列時に
// IP別カウントが共有されない既知制約あり。本モジュールは Firestore atomic increment + 1分バケット
// + TTL（expireAt フィールド）でクロスインスタンスのレート制限を実現する。
//
// ★opt-in：既存ハンドラはインメモリ版を使う。本モジュールは「決済追加後の本気の防御」用。
// 切替方針：
//   - 低トラフィック時：インメモリ版（latency 0ms・コスト 0）
//   - 高トラフィック / セキュリティ重視時：Firestore 版（latency +50-100ms・$0.06/100K reads）
//
// 失敗モード：fail-open。Firestore でエラーが出たら通過させる（可用性優先）。
//             代わりに audit ログでエラーを記録し、Cloud Logging アラート対象とする。

import * as admin from 'firebase-admin';
import { audit } from './logger';
import { RATE_LIMITS } from './rateLimit';

const BUCKET_WINDOW_MS = 60 * 1000;
const BUCKET_TTL_MS = 2 * 60 * 1000; // 2分後に expire（重ねて十分余裕）

function ipFromReq(req: any): string {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

/**
 * Firestore 経由のレート制限チェック。
 * 戻り値：true = 通過、false = 429 を送信済み（呼出側は早期 return）
 *
 * Firestore 構造：
 *   rate_limits/{ip}|{endpoint}|{minuteEpoch}
 *     - count: number（atomic increment）
 *     - ip / endpoint / minute / expireAt
 */
export async function checkRateLimitFs(
  db: admin.firestore.Firestore,
  req: any, res: any, endpoint: string,
): Promise<boolean> {
  const ip = ipFromReq(req);
  const limit = RATE_LIMITS[endpoint] || RATE_LIMITS.default;
  const minute = Math.floor(Date.now() / BUCKET_WINDOW_MS);
  const bucketId = `${ip}|${endpoint}|${minute}`;
  const ref = db.collection('rate_limits').doc(bucketId);

  let count: number;
  try {
    count = await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      const current = (doc.exists ? (doc.data()?.count ?? 0) : 0) + 1;
      tx.set(ref, {
        count: current,
        ip,
        endpoint,
        minute,
        expireAt: new Date(Date.now() + BUCKET_TTL_MS),
      });
      return current;
    });
  } catch (e: any) {
    // fail-open：Firestore エラーでサービス全停止は避ける
    audit('rate_limit.firestore_error', { endpoint, ip, error: String(e?.message || e) }, req);
    return true;
  }

  if (count > limit) {
    audit('rate_limit.exceeded', { endpoint, ip, count, limit, source: 'firestore' }, req);
    res.set('Retry-After', String(60));
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: 60 });
    return false;
  }
  return true;
}

/**
 * Firestore 古いバケットの削除（TTL 設定がない場合の手動クリーンアップ）。
 * Firestore TTL Policy（GCP Console）を `rate_limits.expireAt` に設定すれば不要。
 * 設定手順：00_projects/futami_reservation/docs/2026-05-05_cloud_logging_alerts_guide.md 参照。
 */
export async function cleanupOldRateLimitBuckets(
  db: admin.firestore.Firestore,
  olderThanMinutes: number = 5,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const snap = await db.collection('rate_limits')
    .where('expireAt', '<', cutoff)
    .limit(500)
    .get();
  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  if (snap.size > 0) await batch.commit();
  return snap.size;
}
