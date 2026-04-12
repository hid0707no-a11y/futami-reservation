#!/usr/bin/env node
/**
 * スタッフユーザー作成 & custom claim `staff:true` 付与スクリプト
 *
 * 使い方:
 *   node scripts/create_staff_user.js <email>
 *
 * 動作:
 *   1. 指定メールのユーザーを取得（無ければ `emailVerified: false` で新規作成）
 *   2. 既存 claim とマージして `staff: true` を付与
 *   3. Firebase Auth の password reset link を生成して出力
 *      本人がそのリンクを開いて自分でパスワードを設定する運用。
 *      → スクリプトはパスワードを一切知らなくて済む
 *
 * 前提:
 *   - gcloud auth application-default set-quota-project futami-yoyaku-492607
 *   - futami-yoyaku-492607 に対する admin 権限を持つ Google アカウントで ADC 済み
 *
 * 誤プロジェクト防止:
 *   環境変数 FIREBASE_PROJECT_ID を設定している場合、それと一致しないとエラー終了
 */

const admin = require('../functions/node_modules/firebase-admin');

const EXPECTED_PROJECT = 'futami-yoyaku-492607';
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== EXPECTED_PROJECT) {
  console.error(`[abort] FIREBASE_PROJECT_ID mismatch: expected ${EXPECTED_PROJECT}, got ${process.env.FIREBASE_PROJECT_ID}`);
  process.exit(1);
}

admin.initializeApp({
  projectId: EXPECTED_PROJECT,
});

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/create_staff_user.js <email>');
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('[error] invalid email format:', email);
    process.exit(1);
  }

  // --- 1. get or create ---
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log(`[info] 既存ユーザー: ${user.uid} (${email})`);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    // 新規作成時はパスワード未設定（reset link で本人が設定する）
    // Firebase Auth ではパスワード無しで作成できないため、本スクリプトでは
    // 一時的にランダム bytes でパスワードを生成するが、reset link 発行直後に
    // 上書きされるため外部に漏れる必要はない（標準出力に出さない）
    const crypto = require('crypto');
    const throwawayPassword = crypto.randomBytes(24).toString('base64') + '!Aa1';
    user = await admin.auth().createUser({
      email,
      password: throwawayPassword,
      displayName: email.split('@')[0],
      emailVerified: false, // 本人が reset link を踏むことで暗黙的に確認される
    });
    console.log(`[ok] 新規作成: ${user.uid} (${email})`);
  }

  // --- 2. custom claim を既存とマージして付与 ---
  const existingClaims = user.customClaims || {};
  const newClaims = { ...existingClaims, staff: true };
  await admin.auth().setCustomUserClaims(user.uid, newClaims);
  console.log(`[ok] custom claim merged: ${JSON.stringify(newClaims)}`);

  // --- 3. password reset link を発行 ---
  const resetSettings = {
    url: 'https://hid0707no-a11y.github.io/futami-reservation/staff.html',
    handleCodeInApp: false,
  };
  const link = await admin.auth().generatePasswordResetLink(email, resetSettings);

  console.log('');
  console.log('=====================================================');
  console.log('パスワード設定用リンク（本人に転送してください）');
  console.log('  1 時間以内に開く必要あり');
  console.log('  リンクを開くと好きなパスワードを設定 → staff.html へ');
  console.log('=====================================================');
  console.log(link);
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[error]', e && e.message || e);
  process.exit(1);
});
