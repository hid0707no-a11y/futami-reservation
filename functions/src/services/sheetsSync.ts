// Google Sheets 同期サービス
//
// 2026-05-05 新設（/gfu Phase B-1 services 抽出）。
// 旧 index.ts:1094-1173 を移植。dailySyncToSheets / triggerSyncToSheets の両 onRequest/onSchedule から呼ばれる。
//
// 同期先：
//   reservations タブ（A:<SHEET_LAST_COLUMN>） … confirmed 全件
//   cancelled タブ（A:<SHEET_LAST_COLUMN>）   … cancelled 全件
//   meta タブ（A:B）                          … 最終同期時刻 + 件数
//   ※ clear は A:<SHEET_LAST_COLUMN> に限定するので、その右側に運営が書いたメモは温存される
//   ※ 2026-05-05: A:Y で限定運用開始（Z以降をメモ列として温存）
//   ※ 2026-05-13: 予約番号を Z列へ追加（clear範囲 A:Z・メモ列は AA以降）
//   ※ 2026-08-25: フリガナを AA列へ追加（clear範囲 A:AA・**メモ列は AB以降**）。
//      追加前に Sheets API で3タブとも columnCount=26 を実測し、AA以降にメモが
//      1件も無いことを確認してから広げている（運営のメモを消していない）。
//   ※ 2026-05-13: 「予約番号」列を Z に追加 → A:Z 拡張。運営は AA 列以降にメモを退避。
//   ※ 2026-05-13: SYNC_CLEAR_RANGE_* を constants.ts SSOT から import するよう統一（ドリフト防止）

import * as admin from 'firebase-admin';
import { google } from 'googleapis';
import { ReservationRow, SHEET_HEADERS, rowToArray, reservationToRow } from '../lib/sheets';
import { SHEET_LAST_COLUMN } from '../constants';

const SHEETS_SYNC_ID = process.env.SHEETS_SYNC_ID || '';

export async function syncReservationsToSheets(
  db: admin.firestore.Firestore,
): Promise<{ synced: number; cancelled: number }> {
  if (!SHEETS_SYNC_ID) {
    // #30 本番では設定漏れ＝静かな同期停止を避けるため throw（index.ts catch→sendMonitorAlert で通知）。
    // ローカル/テストは ALLOW_SHEETS_SKIP=1 で明示スキップを許可する。
    if (process.env.ALLOW_SHEETS_SKIP === '1') {
      console.warn('[sync] SHEETS_SYNC_ID 未設定 — ALLOW_SHEETS_SKIP によりスキップ');
      return { synced: 0, cancelled: 0 };
    }
    throw new Error('SHEETS_SYNC_ID 未設定：本番ではスプシ同期に必須です（環境変数の設定漏れの可能性）');
  }

  // ADC 経由で Sheets API 認証（Cloud Functions のデフォルト SA を使用）
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: (await auth.getClient()) as any });

  // Firestore から全予約を取得
  const snap = await db.collection('reservations').orderBy('createdAt', 'desc').get();
  const confirmed: ReservationRow[] = [];
  const cancelled: ReservationRow[] = [];
  snap.forEach(doc => {
    const row = reservationToRow(doc.id, doc.data());
    if (row.status === 'cancelled') cancelled.push(row);
    else confirmed.push(row);
  });

  // #28 各タブを「先に update（A1から上書き）→ 余剰末尾行だけ clear」の順に変更。
  // 旧実装は clear→update で、間で update が失敗するとタブが空になる窓があった。順序を逆転し、
  // 途中失敗でも旧データが残る（バックアップが空にならない）。AA列以降の運営メモは従来どおり温存。
  const writeTab = async (tab: string, values: any[][], lastCol: string) => {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_SYNC_ID,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    // 旧データが新データより多い場合の余剰末尾行を消す（新データ行数+1 以降）
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEETS_SYNC_ID,
      range: `${tab}!A${values.length + 1}:${lastCol}`,
    });
  };

  await writeTab('reservations', [SHEET_HEADERS, ...confirmed.map(rowToArray)], SHEET_LAST_COLUMN);
  await writeTab('cancelled', [SHEET_HEADERS, ...cancelled.map(rowToArray)], SHEET_LAST_COLUMN);
  await writeTab('meta', [
    ['項目', '値'],
    ['最終同期時刻', new Date().toISOString()],
    ['同期ソース', 'Firestore reservations'],
    ['確定予約件数', String(confirmed.length)],
    ['キャンセル件数', String(cancelled.length)],
    ['同期関数', 'dailySyncToSheets'],
  ], 'B');

  console.log(`[sync] sheets sync OK confirmed=${confirmed.length} cancelled=${cancelled.length}`);
  return { synced: confirmed.length, cancelled: cancelled.length };
}
