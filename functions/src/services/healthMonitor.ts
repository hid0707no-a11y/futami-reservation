// staffHealthMonitor サービス本体（onSchedule ラッパは index.ts に薄く残す）
//
// 2026-05-05 新設（/gfu Phase B-1 services 抽出）。
// 旧 index.ts:963-1075 のロジック部分のみ移植。Cloud Functions の onSchedule export は index.ts に置き、
// このファイルでは「何をチェックするか」「どう通知するか」だけを管理する。

import * as admin from 'firebase-admin';
import { google } from 'googleapis';
import { sendMonitorAlert, transporter } from '../lib/mail';
import { HOLIDAY_TABLE_END, HOLIDAY_WARN_FROM } from '../constants';

export async function runStaffHealthCheck(db: admin.firestore.Firestore): Promise<void> {
  const failures: string[] = [];
  const checks: Record<string, boolean> = {};

  // --- Check 1: Firestore 接続（business_calendar）---
  try {
    const doc = await db.doc('config/business_calendar').get();
    checks.firestore_business_calendar = doc.exists;
    if (!doc.exists) failures.push('config/business_calendar が存在しません');
  } catch (e: any) {
    checks.firestore_business_calendar = false;
    failures.push(`Firestore business_calendar read エラー: ${e.message || e}`);
  }

  // --- Check 2: reservations コレクション ---
  try {
    const snap = await db.collection('reservations').limit(1).get();
    checks.firestore_reservations = true;
    console.log(`[monitor] reservations サンプル: ${snap.size}件`);
  } catch (e: any) {
    checks.firestore_reservations = false;
    failures.push(`reservations クエリエラー: ${e.message || e}`);
  }

  // --- Check 3: tennis_slots コレクション ---
  try {
    const snap = await db.collection('tennis_slots').limit(1).get();
    checks.firestore_tennis_slots = true;
    console.log(`[monitor] tennis_slots サンプル: ${snap.size}件`);
  } catch (e: any) {
    checks.firestore_tennis_slots = false;
    failures.push(`tennis_slots クエリエラー: ${e.message || e}`);
  }

  // --- Check 4: Firebase Auth に staff claim ユーザーが 1 人以上いる ---
  try {
    const list = await admin.auth().listUsers(1000);
    const staffUsers = list.users.filter(u => (u.customClaims as any)?.staff === true);
    checks.firebase_auth_staff_count = staffUsers.length > 0;
    console.log(`[monitor] staff users: ${staffUsers.length}名`);
    if (staffUsers.length === 0) {
      failures.push('Firebase Auth に staff:true claim 付きユーザーが 1 人もいません');
    }
  } catch (e: any) {
    checks.firebase_auth_staff_count = false;
    failures.push(`Firebase Auth listUsers エラー: ${e.message || e}`);
  }

  // --- Check 5: 祝日テーブル期限（index.html JP_HOLIDAYS_2026_2027）---
  // JST 基準の今日。onSchedule は 08:30 JST（=UTC 前日 23:30）実行のため、
  // UTC の toISOString だと判定日が1日早まる。+9h して JST 日付に補正する。
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (today >= HOLIDAY_WARN_FROM) {
    checks.holiday_table_current = false;
    failures.push(
      `祝日テーブル JP_HOLIDAYS_2026_2027 が ${HOLIDAY_TABLE_END} で失効間近（今日=${today}）。` +
      'index.html の JP_HOLIDAYS_2026_2027 を 2028-2029 用に更新してください。' +
      ' 手順: 00_projects/futami_reservation/CLAUDE.md「年次メンテナンスタスク」節を参照。'
    );
  } else {
    checks.holiday_table_current = true;
  }

  // --- Check 6: TTL Policy 機能の間接検証（2026-05-13 B-lite 追加）---
  // 直接 TTL state を取るには @google-cloud/firestore-admin が必要だが bundle 重い。
  // 代わりに「TTL が機能していれば 48h 以上前の expireAt は残らない」という不変条件で
  // 間接的に検知する。古い残留 = TTL Policy が DELETING/NEEDS_REPAIR 状態の疑い。
  const TTL_STALE_THRESHOLD_HOURS = 48;
  const staleBoundary = new Date(Date.now() - TTL_STALE_THRESHOLD_HOURS * 60 * 60 * 1000);
  try {
    // idempotency_keys: expireAt は 24h 後設定 → 48h 以上前のものが残っていれば TTL 失効疑い
    const idempStale = await db.collection('idempotency_keys')
      .where('expireAt', '<', staleBoundary)
      .limit(1).get();
    // rate_limits: expireAt は 2分後設定 → 48h 以上前のものは確実に削除されているはず
    const rateLimitStale = await db.collection('rate_limits')
      .where('expireAt', '<', staleBoundary)
      .limit(1).get();
    checks.ttl_policy_idempotency_active = idempStale.empty;
    checks.ttl_policy_rate_limits_active = rateLimitStale.empty;
    if (!idempStale.empty) {
      failures.push(
        `idempotency_keys に 48h 以上前の expireAt を持つドキュメントが残存。` +
        `TTL Policy が機能していない疑い。確認: gcloud firestore fields ttls list --project=futami-yoyaku-492607`
      );
    }
    if (!rateLimitStale.empty) {
      failures.push(
        `rate_limits に 48h 以上前の expireAt を持つドキュメントが残存。` +
        `TTL Policy が機能していない疑い。確認: gcloud firestore fields ttls list --project=futami-yoyaku-492607`
      );
    }
  } catch (e: any) {
    checks.ttl_policy_check = false;
    // 失敗は通知に含めるがメイン処理は続行（クエリエラーで監視全体を落とさない）
    failures.push(`TTL Policy 間接チェックエラー: ${e.message || e}`);
  }

  // --- Check 7: スプシ同期の鮮度（#31）---
  // sheetsSync が meta!B2 に毎回書く「最終同期時刻」を読み、26h 以上古ければ同期停止疑い。
  // SHEETS_SYNC_ID 未設定（ローカル/テスト等）は同期自体が無効なのでスキップ。
  const SHEETS_SYNC_ID = process.env.SHEETS_SYNC_ID || '';
  if (SHEETS_SYNC_ID) {
    try {
      const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
      const sheets = google.sheets({ version: 'v4', auth: (await auth.getClient()) as any });
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_SYNC_ID, range: 'meta!B2' });
      const lastSyncStr = resp.data.values?.[0]?.[0] as string | undefined;
      const lastSyncMs = lastSyncStr ? Date.parse(lastSyncStr) : NaN;
      const ageH = Number.isFinite(lastSyncMs) ? (Date.now() - lastSyncMs) / 3_600_000 : Infinity;
      checks.sheets_sync_fresh = ageH <= 26;
      if (ageH > 26) {
        failures.push(
          `スプシ同期が停止している疑い：meta!B2 最終同期時刻=${lastSyncStr || '(空)'}` +
          `（${Number.isFinite(ageH) ? Math.round(ageH) + 'h前' : '解析不可'}）。dailySyncToSheets のログを確認。`
        );
      }
    } catch (e: any) {
      checks.sheets_sync_fresh = false;
      failures.push(`スプシ同期鮮度チェックエラー: ${e.message || e}`);
    }
  }

  // --- Check 8: SMTP 経路の生存（2026-07-19）---
  // SMTP env 欠落時は transporter=null で全メールが無ログスキップされる沈黙死モードだった。
  // 未構成の検知と、構成済みでも認証・接続が死んでいないかの verify を毎朝行う。
  // ここで failure になっても本アラート自体は Discord 第二経路（#32）が拾える。
  // ⚠️ verify() は nodemailer 既定で最大120sブロックし得る。onSchedule 既定 60s タイムアウトを
  // 超えると「アラート送信前に関数が殺され全通知が沈黙する」= 監視の自己サイレンス化になるため、
  // 8s で打ち切る（打ち切り自体を failure として扱い、Discord 経路でアラートは飛ぶ）。
  try {
    if (!transporter) {
      checks.smtp_configured = false;
      failures.push('SMTP transporter 未構成（SMTP_USER/SMTP_PASS 欠落）：顧客確認メールが全停止しています');
    } else {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          transporter.verify(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('verify timeout 8s')), 8000); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer); // タイマー残留を後始末（verify が先に解決してもリークさせない）
      }
      checks.smtp_configured = true;
    }
  } catch (e: any) {
    checks.smtp_configured = false;
    failures.push(`SMTP verify 失敗（認証切れ・接続不可・応答遅延の疑い）: ${e.message || e}`);
  }

  // --- 判定 + 通知 ---
  console.log(JSON.stringify({
    severity: 'INFO',
    audit: true,
    action: 'monitor.staff_health',
    timestamp: new Date().toISOString(),
    checks,
    failures,
    ok: failures.length === 0,
  }));

  if (failures.length > 0) {
    const body = [
      'ふたみ予約システムのスタッフ機能ヘルスチェックで問題を検知しました。',
      '',
      `検証日時: ${new Date().toISOString()}`,
      '',
      '【失敗項目】',
      ...failures.map(f => '  - ' + f),
      '',
      '【全チェック結果】',
      JSON.stringify(checks, null, 2),
      '',
      '対応:',
      '  - https://hid0707no-a11y.github.io/futami-reservation/staff.html を開いて動作確認',
      '  - Firebase Console (https://console.firebase.google.com/project/futami-yoyaku-492607) でログ確認',
      '',
      'このメールは staffHealthMonitor Cloud Function が自動送信しています。',
    ].join('\n');
    await sendMonitorAlert('[ふたみ予約] スタッフ機能ヘルスチェック失敗', body);
  } else {
    console.log('[monitor] all checks passed');
  }
}
