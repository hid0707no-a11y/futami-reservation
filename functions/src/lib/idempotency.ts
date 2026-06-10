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
//
// 2026-06-11 強化（backlog #6/#14/#15）：
//  - #15 キーの文字種・長さを KEY_RE で検証（'/'混入による doc(key) 例外→500 を回避・推測耐性）
//  - #6  saveIdempotencyKey を呼出側で **await** するよう変更（旧 fire-and-forget だと
//        「コミット後・保存前の即時リトライ」で2本目がチェックを素通りする窓があった）
//  - #14 check→save の完全原子化（reserve-then-execute）は未実施。並行同一キーは
//        slot トランザクション（slot_conflict 409）がデータ二重化の最終防衛線として機能するため、
//        まず低リスクな await + 文字種検証で実害窓を塞ぐ。完全原子化は別途検討。

import * as admin from 'firebase-admin';

// #15: idempotency キーの許容文字種・長さ（Firestore doc ID 安全 + 推測耐性）
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
  if (!key || typeof key !== 'string') return true; // 未指定はスキップ
  if (!KEY_RE.test(key)) return true; // #15 不正な文字種/長さは無視して通常処理（'/'混入500回避）

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
 * #6: 呼出側は res 送信の **前に await** すること（保存完了前の即時リトライ素通りを防ぐ）。
 * 保存自体の失敗は予約成功に影響させないため、呼出側で `.catch(logIdempotencyFailure(...))` 済。
 */
export async function saveIdempotencyKey(
  db: admin.firestore.Firestore,
  req: any,
  response: any,
): Promise<void> {
  const key = req.headers?.['x-idempotency-key'];
  if (!key || typeof key !== 'string' || !KEY_RE.test(key)) return; // #15 不正キーは保存しない
  const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.collection('idempotency_keys').doc(key).set({
    response,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expireAt,
  });
}
