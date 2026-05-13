// displayId（人間可読予約番号）のランタイム衝突検知
//
// 2026-05-13 新設（ハーネスエンジニアリング監査・指摘 #8）。
// generateDisplayId は決定論的に Auto ID 先頭6文字を取り出すため、
// base62 → base36 圧縮で稀に衝突する。年100万件規模で統計的に避けられない。
// createReservation の各ルートで resRef.set 前に呼んで監査ログを残す。

import * as admin from 'firebase-admin';

export interface CollisionResult {
  collided: boolean;
  existingIds: string[];
}

/**
 * 指定 displayId を持つ既存の reservation document を Firestore で検索する。
 *
 * 注意：トランザクション**外**でクエリする。Firestore トランザクションは where 句クエリを
 * tx.get できないため、racey ではあるが、衝突は極稀（5年で 0.001%）なので
 * 「検知してログ警告」の運用で十分。実害（同一 displayId 2件存在）が発生した場合は
 * 監査ログから手動で displayId をリネームする。
 *
 * @param db 同じく `db.collection('reservations').where(...)` できる Firestore instance
 * @param displayId 'F-XXXXXX' 形式
 * @param excludeId 自分自身の Auto ID を除外（resRef 生成後に呼ぶ場合の自己誤検知防止）
 */
export async function detectDisplayIdCollision(
  db: admin.firestore.Firestore,
  displayId: string,
  excludeId?: string,
): Promise<CollisionResult> {
  if (!displayId) return { collided: false, existingIds: [] };
  const snap = await db
    .collection('reservations')
    .where('displayId', '==', displayId)
    .limit(5)
    .get();
  const existingIds = snap.docs
    .map(d => d.id)
    .filter(id => id !== excludeId);
  return {
    collided: existingIds.length > 0,
    existingIds,
  };
}
