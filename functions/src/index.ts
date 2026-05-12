// ふたみ潮風ふれあい公園 予約システム — Cloud Functions エントリポイント
//
// 2026-05-05 大型リファクタ完了（/gfu Phase 0+A+B 5周）。
// このファイルは Cloud Functions の topology（関数名と export）だけを管理する薄いエントリ。
// 業務ロジックは全て handlers/ services/ lib/ に分離済。
//
// 構造：
//   src/
//   ├── index.ts          ← このファイル（エントリ + onSchedule定義 + handlers re-export）
//   ├── constants.ts      定数SSOT
//   ├── lib/              純粋関数・ミドルウェア（11ファイル）
//   ├── services/         ビジネスロジック（2ファイル）
//   ├── handlers/         REST onRequest ハンドラ（4ファイル・11関数）
//   └── migrations/       Firestore migration 管理

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from './lib/firestore';
import { sendMonitorAlert } from './lib/mail';
import { startRateLimitCleanup } from './lib/rateLimit';
import { runStaffHealthCheck } from './services/healthMonitor';
import { syncReservationsToSheets } from './services/sheetsSync';

// インメモリ rate limit のクリーンアップを開始（5分ごと）
startRateLimitCleanup();

// ===== handlers/ から onRequest 関数を再 export（Cloud Functions topology 維持）=====
export { health, listAuditLog, triggerSyncToSheets } from './handlers/admin';
export { availability, futamiDays, businessCalendar } from './handlers/availability';
export { listReservations, updateReservation, changeCampSites, cancelReservation } from './handlers/reservation';
export { createReservation } from './handlers/createReservation';

/**
 * ===== スタッフ画面 Uptime 監視（毎朝 08:30 JST）=====
 * 検証項目：Firestore接続 / reservations / tennis_slots / staff claim user / 祝日テーブル期限
 * 失敗時：sendMonitorAlert で SMTP 通知（STAFF_EMAIL + hid0707no@gmail.com）
 * 本体ロジック：services/healthMonitor.ts
 */
export const staffHealthMonitor = onSchedule(
  {
    schedule: '30 8 * * *',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
  },
  async () => { await runStaffHealthCheck(db); },
);

/**
 * ===== 予約データ Google Sheets 同期（日次 03:00 JST）=====
 * Firestore reservations 全件を Google Sheets に書き出す。バックアップ + 行政報告原データ。
 * 同期先：reservations / cancelled / meta タブ（A:Y / A:Y / A:B 限定で運営の右側メモ列を保護）
 * 認証：Cloud Functions デフォルト SA（事前にスプシを編集者として SA に共有が必要）
 * 本体ロジック：services/sheetsSync.ts
 */
export const dailySyncToSheets = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
    memory: '512MiB',
  },
  async () => {
    try {
      const result = await syncReservationsToSheets(db);
      console.log(JSON.stringify({
        severity: 'INFO',
        audit: true,
        action: 'sync.sheets.daily',
        timestamp: new Date().toISOString(),
        ...result,
      }));
    } catch (e: any) {
      console.error('[sync] failed:', e.message || e);
      await sendMonitorAlert(
        '[ふたみ予約] 日次スプシ同期エラー',
        [
          'dailySyncToSheets が失敗しました。',
          '',
          `エラー: ${e.message || e}`,
          `時刻: ${new Date().toISOString()}`,
          '',
          '対応: Firebase Console でログを確認してください。',
        ].join('\n'),
      );
    }
  }
);
