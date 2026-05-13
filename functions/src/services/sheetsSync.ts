// Google Sheets 同期サービス
//
// 2026-05-05 新設（/gfu Phase B-1 services 抽出）。
// 旧 index.ts:1094-1173 を移植。dailySyncToSheets / triggerSyncToSheets の両 onRequest/onSchedule から呼ばれる。
//
// 同期先：
//   reservations タブ（A:<SHEET_LAST_COLUMN>） … confirmed 全件
//   cancelled タブ（A:<SHEET_LAST_COLUMN>）   … cancelled 全件
//   meta タブ（A:B）                          … 最終同期時刻 + 件数
//   ※ A:Z 限定で clear するので運営の AA列以降のメモは温存される
//   ※ 2026-05-05: A:Y で限定運用開始（Z以降をメモ列として温存）
//   ※ 2026-05-13: 「予約番号」列を Z に追加 → A:Z 拡張。運営は AA 列以降にメモを退避。
//   ※ 2026-05-13: SYNC_CLEAR_RANGE_* を constants.ts SSOT から import するよう統一（ドリフト防止）

import * as admin from 'firebase-admin';
import { google } from 'googleapis';
import { ReservationRow, SHEET_HEADERS, rowToArray, reservationToRow } from '../lib/sheets';
import {
  SYNC_CLEAR_RANGE_RESERVATIONS,
  SYNC_CLEAR_RANGE_CANCELLED,
  SYNC_CLEAR_RANGE_META,
} from '../constants';

const SHEETS_SYNC_ID = process.env.SHEETS_SYNC_ID || '';

export async function syncReservationsToSheets(
  db: admin.firestore.Firestore,
): Promise<{ synced: number; cancelled: number }> {
  if (!SHEETS_SYNC_ID) {
    console.warn('[sync] SHEETS_SYNC_ID 未設定 — スプシ同期をスキップ');
    return { synced: 0, cancelled: 0 };
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

  // reservations タブを上書き（A:Z のみ・運営の AA列以降のメモは温存）
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_SYNC_ID,
    range: SYNC_CLEAR_RANGE_RESERVATIONS,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'reservations!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [SHEET_HEADERS, ...confirmed.map(rowToArray)],
    },
  });

  // cancelled タブを上書き
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_SYNC_ID,
    range: SYNC_CLEAR_RANGE_CANCELLED,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'cancelled!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [SHEET_HEADERS, ...cancelled.map(rowToArray)],
    },
  });

  // meta タブ更新（A:B 2列のみ）
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_SYNC_ID,
    range: SYNC_CLEAR_RANGE_META,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'meta!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        ['項目', '値'],
        ['最終同期時刻', new Date().toISOString()],
        ['同期ソース', 'Firestore reservations'],
        ['確定予約件数', String(confirmed.length)],
        ['キャンセル件数', String(cancelled.length)],
        ['同期関数', 'dailySyncToSheets'],
      ],
    },
  });

  console.log(`[sync] sheets sync OK confirmed=${confirmed.length} cancelled=${cancelled.length}`);
  return { synced: confirmed.length, cancelled: cancelled.length };
}
