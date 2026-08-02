// 休館・停止設定の dry-run で「矛盾する既存予約」を Firestore から拾うサービス
//
// 2026-08-02 新設（元は handlers/availability.ts に直書き）。
// 判定そのものは lib/facilityImpact.ts の純粋関数が持ち、このファイルは
// 「どの範囲を読むか」「どこで打ち切るか」だけを受け持つ。一切書込みをしない読取専用。

import * as admin from 'firebase-admin';
import { BusinessCalendar } from '../lib/businessDays';
import { RESERVATION_STATUS } from '../constants';
import {
  AffectedReservation,
  DRY_RUN_AFFECTED_LIMIT,
  DRY_RUN_SCAN_LIMIT,
  judgedDateRange,
  reservationHitsClosedSettings,
  scanRangeForJudgedDates,
  toAffectedReservation,
  toReservationLike,
} from '../lib/facilityImpact';

export interface AffectedReservationsResult {
  affected: AffectedReservation[];
  count: number;
  /** 読み取り上限に当たって全件は見ていない（＝件数が過少かもしれない）ことを職員へ伝える */
  truncated: boolean;
}

/**
 * これから保存しようとしている設定と矛盾する confirmed 予約を洗い出す。
 *
 * 引数はどちらも「**今回追加されるぶんだけ**」を渡すこと（現行 config との差分）。
 * 送信された全件を渡すと、過去に承知で残した停止のせいで毎回同じ警告が出て形骸化する。
 *
 * ── 走査範囲 ──
 * reservations を全件走査すると「追加」1クリックごとにコレクション全量を読むことになり、
 * 予約が積み上がるほど遅くなりタイムアウトへ近づく。判定対象日の min/max から範囲を出して絞る。
 *   ・絞り込みは **startDate の範囲だけ**（status を where に足すと複合インデックスが要る）。
 *     status=confirmed の判定はメモリ側で行う。
 *   ・宿泊予約は endDate だけが判定対象日にかかることがあるので、min から
 *     RESERVATION_LOOKBACK_DAYS ぶん手前まで遡って読む。
 *   ・startDate を持たない壊れたドキュメントは範囲クエリの対象外になる（Firestore の仕様）。
 *     createReservation は必ず startDate を書くので本番データでは発生しない。
 *   ・読み取り件数には DRY_RUN_SCAN_LIMIT の安全上限を掛け、当たったら truncated を返す。
 */
export async function findAffectedReservations(
  db: admin.firestore.Firestore,
  addedForceClosed: string[],
  addedFacilityClosed: string[],
): Promise<AffectedReservationsResult> {
  const range = judgedDateRange(addedForceClosed, addedFacilityClosed);
  if (!range) return { affected: [], count: 0, truncated: false };

  const closedDaySet = new Set(addedForceClosed);
  // 施設停止の判定は createReservation と同じ関数を使う（サウナ連動も同じ挙動になる）。
  const probeCal: BusinessCalendar = {
    defaultClosedDays: [], forceOpen: [], forceClosed: [], facilityClosed: addedFacilityClosed,
  };

  const { from, to } = scanRangeForJudgedDates(range);
  const snap = await db.collection('reservations')
    .where('startDate', '>=', from)
    .where('startDate', '<=', to)
    .limit(DRY_RUN_SCAN_LIMIT)
    .get();
  const truncated = snap.size >= DRY_RUN_SCAN_LIMIT;

  const affected: AffectedReservation[] = [];
  let count = 0;
  for (const doc of snap.docs) {
    const reservation = toReservationLike(doc.id, doc.data());
    if (reservation.status !== RESERVATION_STATUS.CONFIRMED) continue;
    if (!reservationHitsClosedSettings(reservation, closedDaySet, probeCal)) continue;
    count++;
    if (affected.length < DRY_RUN_AFFECTED_LIMIT) affected.push(toAffectedReservation(reservation));
  }
  return { affected, count, truncated };
}
