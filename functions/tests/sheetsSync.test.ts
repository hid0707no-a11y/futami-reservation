// services/sheetsSync の純粋ロジック確認テスト
// 2026-05-05 新設（/gfu Phase A-2 拡張）
//
// syncReservationsToSheets 自体は Sheets API 呼び出しを含むので統合テストが必要だが、
// このテストでは「export されている」「db を引数で受ける」という構造の正しさだけを確認する。
// 純粋ロジック（reservationToRow / rowToArray）は tests/sheets.test.ts でカバー済。

import { syncReservationsToSheets } from '../src/services/sheetsSync';

describe('services/sheetsSync', () => {
  it('syncReservationsToSheets は db を引数に取る関数として export されている', () => {
    expect(typeof syncReservationsToSheets).toBe('function');
    expect(syncReservationsToSheets.length).toBe(1); // 引数1個（db）
  });

  it('SHEETS_SYNC_ID 未設定なら早期 return（{ synced: 0, cancelled: 0 }）', async () => {
    // 環境変数を一時的にクリア
    const orig = process.env.SHEETS_SYNC_ID;
    delete process.env.SHEETS_SYNC_ID;

    // この検証のために sheetsSync を再ロード
    jest.resetModules();
    const { syncReservationsToSheets: reloaded } = await import('../src/services/sheetsSync');

    // db は呼ばれない想定なのでダミー
    const fakeDb: any = { collection: jest.fn(() => { throw new Error('should not be called'); }) };
    const result = await reloaded(fakeDb);
    expect(result).toEqual({ synced: 0, cancelled: 0 });
    expect(fakeDb.collection).not.toHaveBeenCalled();

    if (orig !== undefined) process.env.SHEETS_SYNC_ID = orig;
  });
});
