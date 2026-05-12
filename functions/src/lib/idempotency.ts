// 冪等性キー（X-Idempotency-Key）管理
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// 旧 index.ts:158-185 を集約。
//
// 仕組み：
//  1. クライアントが X-Idempotency-Key ヘッダで一意のキーを送る
//  2. サーバは Firestore /idempotency_keys/{key} を確認
//  3. 既存ドキュメントあり → 保存済みのレスポンスを返す（二重予約防止）
//  4. なし → 通常処理 → 完了後にキーとレスポンスを保存（24時間TTL）
//
// 制約：rateLimit がインメモリでインスタンス間共有されない問題があるが、ここは
// Firestore 永続化なので最終防衛線として全インスタンス・全リトライに対して有効。

import * as admin from 'firebase-admin';

/**
 * 冪等性キーをチェックし、既処理ならキャッシュレスポンスを返して early return を促す。
 *
 * 戻り値：
 *  - true  = 新規 / キーなし（呼出側は通常処理を続行）
 *  - false = 既処理（res に保存済みレスポンスを書き込み済・呼出側は早期 return）
 */
export async function checkIdempotency(
  db: admin.firestore.Firestore,
  req: any,
  res: any,
): Promise<boolean> {
  const key = req.headers?.['x-idempotency-key'];
  if (!key || typeof key !== 'string' || key.length > 64) return true; // キー無効/未指定はスキップ

  const ref = db.collection('idempotency_keys').doc(key);
  const doc = await ref.get();
  if (doc.exists) {
    const data = doc.data() as any;
    res.status(200).json(data.response || { error: 'duplicate_request' });
    return false;
  }
  return true;
}

/**
 * 処理完了後、キーとレスポンスを 24時間 TTL で保存する。
 * 失敗しても処理結果は既にクライアントに返している前提のため、エラーは ログのみで握る。
 * （呼出側は `.catch(logIdempotencyFailure(...))` でラップ済）
 */
export async function saveIdempotencyKey(
  db: admin.firestore.Firestore,
  req: any,
  response: any,
): Promise<void> {
  const key = req.headers?.['x-idempotency-key'];
  if (!key) return;
  const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.collection('idempotency_keys').doc(key).set({
    response,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expireAt,
  });
}
