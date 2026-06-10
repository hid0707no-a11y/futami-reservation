// ふたみの日 判定（30秒キャッシュ・Firestore /config/special_days 参照）
//
// 2026-05-05 新設（/gfu Phase B-1 完全分割の前提）。
// 旧 index.ts:85-104 を移植。createReservation 等のハンドラから利用される。
//
// データソース：Firestore /config/special_days.sauna_capacity_days（配列）

import { db } from './firestore';

export const SHARED_SLOT_CAPACITY = 8; // ふたみの日サウナ専用（キャンプは2026-04-28〜個別管理）
const FUTAMI_CACHE_TTL_MS = 30 * 1000;

let _cache: { dates: Set<string>; expiresAt: number } | null = null;

export async function getFutamiDays(): Promise<Set<string>> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) return _cache.dates;
  const doc = await db.doc('config/special_days').get();
  const dates: string[] = (doc.exists && (doc.data() as any)?.sauna_capacity_days) || [];
  const set = new Set(dates);
  _cache = { dates: set, expiresAt: now + FUTAMI_CACHE_TTL_MS };
  return set;
}

export async function isFutamiDay(dateStr: string): Promise<boolean> {
  const set = await getFutamiDays();
  return set.has(dateStr);
}

/**
 * キャッシュをバイパスして config/special_days を直接読む（#16 TOCTOU 対策）。
 * createReservation のふたみサウナ判定で使用：30秒キャッシュだとスタッフが「ふたみの日」を
 * 取り消した直後に他インスタンスが古いリストで予約を通してしまうため、確定前は最新を読む。
 * 取得した最新値で共有キャッシュも更新する（後続の読み取りを新鮮化）。
 */
export async function getFutamiDaysFresh(): Promise<Set<string>> {
  const doc = await db.doc('config/special_days').get();
  const dates: string[] = (doc.exists && (doc.data() as any)?.sauna_capacity_days) || [];
  const set = new Set(dates);
  _cache = { dates: set, expiresAt: Date.now() + FUTAMI_CACHE_TTL_MS };
  return set;
}

/** テスト用：キャッシュをクリアする（本番では不要）。 */
export function _clearFutamiDaysCache(): void {
  _cache = null;
}
