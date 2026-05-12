// services/healthMonitor.ts の Firestore Emulator integration test
//
// 2026-05-05 新設（/gfu Phase A-2 拡張・5周目延長）。
// 実 Firestore（エミュレータ）に対して runStaffHealthCheck を実行し、
//   - config/business_calendar が存在しない → failures に積まれる
//   - reservations / tennis_slots クエリが投げられる
// を検証する。
//
// 前提：Firestore Emulator が localhost:8080 で起動中であること。
//   $ export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   $ firebase emulators:start --only firestore --project futami-yoyaku-492607
//
// 実行：
//   $ FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx jest tests/integration/

// 環境変数を最初にセット（admin.initializeApp() より前）
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
}
const db = admin.firestore();

import { runStaffHealthCheck } from '../../src/services/healthMonitor';

describe('healthMonitor integration (emulator)', () => {
  beforeEach(async () => {
    // 各テスト前に Firestore データをクリア（emulator API）
    await fetch(
      'http://127.0.0.1:8080/emulator/v1/projects/futami-yoyaku-492607/databases/(default)/documents',
      { method: 'DELETE' }
    ).catch(() => { /* emulator なら ok・無ければスキップ */ });
  });

  it('config/business_calendar が無い時は INFO ログ + 通知（中身検証）', async () => {
    // 直接の return は void だが、console.log が出力されることを確認
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
    await runStaffHealthCheck(db);
    const auditCalls = logSpy.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('monitor.staff_health'));
    expect(auditCalls.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(auditCalls[0][0]);
    expect(entry.action).toBe('monitor.staff_health');
    expect(entry.checks).toBeDefined();
    // business_calendar が無いので false
    expect(entry.checks.firestore_business_calendar).toBe(false);
    // reservations / tennis_slots は空でも true（クエリ自体は通る）
    expect(entry.checks.firestore_reservations).toBe(true);
    expect(entry.checks.firestore_tennis_slots).toBe(true);
    logSpy.mockRestore();
  }, 15000);

  it('config/business_calendar をセットすると ok', async () => {
    await db.doc('config/business_calendar').set({
      defaultClosedDays: [2],
      forceOpen: [],
      forceClosed: [],
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
    await runStaffHealthCheck(db);
    const auditCalls = logSpy.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('monitor.staff_health'));
    const entry = JSON.parse(auditCalls[0][0]);
    expect(entry.checks.firestore_business_calendar).toBe(true);
    logSpy.mockRestore();
  }, 15000);
});

afterAll(async () => {
  await admin.app().delete();
});
