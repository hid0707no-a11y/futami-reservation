// services/sheetsSync.ts の Firestore Emulator integration test（Sheets API は呼ばない・SHEETS_SYNC_ID 未設定で早期 return）
//
// 2026-05-05 新設。
// emulator に reservations を投入 → syncReservationsToSheets が SHEETS_SYNC_ID 未設定で早期 return することを確認。
// これは「設定がない時に外部 API を叩かず安全にスキップする」という防御行動の検証。

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';
delete process.env.SHEETS_SYNC_ID; // 明示的に未設定にする

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
}
const db = admin.firestore();

// 環境変数を消した後に import（モジュール初期化時に env 読まれるため）
import { syncReservationsToSheets } from '../../src/services/sheetsSync';

describe('sheetsSync integration (emulator)', () => {
  beforeEach(async () => {
    await fetch(
      'http://127.0.0.1:8080/emulator/v1/projects/futami-yoyaku-492607/databases/(default)/documents',
      { method: 'DELETE' }
    ).catch(() => { /* noop */ });
  });

  it('SHEETS_SYNC_ID 未設定なら reservations 件数に関わらず { synced: 0, cancelled: 0 } で早期 return', async () => {
    // データを投入しても Sheets API は叩かれない
    await db.collection('reservations').doc('r1').set({
      status: 'confirmed',
      planId: 'normal_27',
      roomIds: ['room_27'],
      slots: ['room_27|2026-05-10|10'],
      startDate: '2026-05-10',
      endDate: '2026-05-10',
      customer: { name: 'X', phone: '0', isMember: true },
      createdAt: admin.firestore.Timestamp.now(),
    });
    const result = await syncReservationsToSheets(db);
    expect(result).toEqual({ synced: 0, cancelled: 0 });
  }, 15000);
});

afterAll(async () => {
  await admin.app().delete();
});
