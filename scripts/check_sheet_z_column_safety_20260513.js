#!/usr/bin/env node
/**
 * Sheets Z列上書き事前検査スクリプト（2026-05-13 SHEET_HEADERS A:Y→A:Z 拡張に伴う安全装置）
 *
 * 用途：
 *   dailySyncToSheets が Z列を「予約番号」列で上書きする前に、運営が Z列に独自メモを
 *   置いていないか検査する。置かれていた場合、AA列以降への退避を促す。
 *
 * 使い方：
 *   node scripts/check_sheet_z_column_safety_20260513.js                  # チェックのみ
 *   node scripts/check_sheet_z_column_safety_20260513.js --backup         # backup タブにコピー後にチェック
 *
 * 出力：
 *   - reservations / cancelled タブの Z列に既存値があれば一覧表示
 *   - --backup 指定時は `_backup_z_20260513` タブを作成して Z列を退避保存
 *
 * 前提：
 *   - $SHEETS_SYNC_ID 環境変数 or ../functions/.env の SHEETS_SYNC_ID
 *   - gcloud ADC（Cloud Functions と同じサービスアカウント or 個人アカウント）
 */

const fs = require('fs');
const path = require('path');
const { google } = require('../functions/node_modules/googleapis');

// .env 読み込み（dotenv 入っていないので簡易パーサ）
function loadEnv(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* ignore */ }
}
loadEnv(path.join(__dirname, '..', 'functions', '.env'));

const SHEETS_SYNC_ID = process.env.SHEETS_SYNC_ID;
if (!SHEETS_SYNC_ID) {
  console.error('[abort] SHEETS_SYNC_ID 未設定。functions/.env または環境変数に設定してください。');
  process.exit(1);
}

const backup = process.argv.includes('--backup');

async function main() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  console.log(`[z-check] target spreadsheet: ${SHEETS_SYNC_ID}`);

  // Z列の中身を取得（2タブ × 1行目はヘッダ、2行目以降がデータ）
  const tabs = ['reservations', 'cancelled'];
  const findings = {};
  for (const tab of tabs) {
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEETS_SYNC_ID,
        range: `${tab}!Z1:Z10000`,
      });
      const values = (resp.data.values || []).flat().filter(v => v && String(v).trim());
      findings[tab] = values;
      console.log(`[z-check] ${tab}!Z: 既存値 ${values.length} 件`);
      if (values.length > 0) {
        console.log(`  → 最初の5件: ${values.slice(0, 5).map(v => JSON.stringify(v)).join(', ')}`);
      }
    } catch (e) {
      console.warn(`[z-check] ${tab}!Z 取得失敗: ${e.message}`);
      findings[tab] = [];
    }
  }

  const totalExisting = (findings.reservations?.length || 0) + (findings.cancelled?.length || 0);

  if (totalExisting === 0) {
    console.log('\n✅ Z列に既存値なし。dailySyncToSheets による上書き安全。');
    return;
  }

  console.warn(`\n⚠️ Z列に既存値あり（合計 ${totalExisting} セル）。dailySyncToSheets は明朝3時に Z列を「予約番号」列で全上書きします。`);

  if (!backup) {
    console.warn('\n運営アクション：以下のいずれかを実施してください。');
    console.warn('  1. 運営がスプシで Z列の内容を手動で AA列以降にコピー＋削除');
    console.warn('  2. このスクリプトを `--backup` 指定で再実行（自動で `_backup_z_20260513` タブに退避）');
    process.exit(2); // 非0 終了で CI/cron からも検知可能
  }

  // --backup: 既存 Z列を `_backup_z_20260513` タブに退避
  const backupTabName = '_backup_z_20260513';
  console.log(`\n[backup] 退避タブを作成: ${backupTabName}`);
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEETS_SYNC_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: backupTabName } } }],
      },
    });
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    console.warn(`  → ${backupTabName} は既に存在。上書きします。`);
  }

  // 退避タブに reservations.Z / cancelled.Z を書込み
  const writeRows = [['tab', 'rowIndex', 'value']];
  for (const tab of tabs) {
    (findings[tab] || []).forEach((v, i) => writeRows.push([tab, String(i + 1), String(v)]));
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: `${backupTabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: writeRows },
  });

  console.log(`✅ 退避完了: ${backupTabName} タブに ${writeRows.length - 1} 件保存`);
  console.log('  この後 dailySyncToSheets を実行しても元 Z列のデータは退避済み。');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
