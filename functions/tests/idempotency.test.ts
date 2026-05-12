// 冪等性キー管理のユニットテスト（mock Firestore）
// 2026-05-05 新設（/gfu Phase A-2 拡張）

import { checkIdempotency, saveIdempotencyKey } from '../src/lib/idempotency';

// 軽量 Firestore モック
function makeMockDb(initialData: Record<string, any> = {}) {
  const store: Record<string, any> = { ...initialData };
  return {
    collection: jest.fn((collName: string) => ({
      doc: jest.fn((id: string) => ({
        get: jest.fn(async () => ({
          exists: store[`${collName}/${id}`] !== undefined,
          data: () => store[`${collName}/${id}`],
        })),
        set: jest.fn(async (data: any) => {
          store[`${collName}/${id}`] = data;
        }),
      })),
    })),
    _store: store,
  } as any;
}

function makeRes() {
  return {
    statusCode: 0,
    bodyJson: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.bodyJson = b; return this; },
  };
}

describe('checkIdempotency', () => {
  it('X-Idempotency-Key ヘッダなしは true（呼出側通過）を返す', async () => {
    const db = makeMockDb();
    const res = makeRes();
    const result = await checkIdempotency(db, { headers: {} }, res);
    expect(result).toBe(true);
    expect(db.collection).not.toHaveBeenCalled();
  });

  it('キー長さ65文字以上は true（不正キーは無視）を返す', async () => {
    const db = makeMockDb();
    const res = makeRes();
    const result = await checkIdempotency(db, { headers: { 'x-idempotency-key': 'x'.repeat(65) } }, res);
    expect(result).toBe(true);
    expect(db.collection).not.toHaveBeenCalled();
  });

  it('キー型が string でない場合は true（不正キーは無視）', async () => {
    const db = makeMockDb();
    const res = makeRes();
    const result = await checkIdempotency(db, { headers: { 'x-idempotency-key': 123 } }, res);
    expect(result).toBe(true);
  });

  it('未知キーで Firestore 既存ドキュメントなしなら true（新規処理を続行）', async () => {
    const db = makeMockDb();
    const res = makeRes();
    const result = await checkIdempotency(db, { headers: { 'x-idempotency-key': 'new-key-123' } }, res);
    expect(result).toBe(true);
    expect(db.collection).toHaveBeenCalledWith('idempotency_keys');
  });

  it('既存キーがあればキャッシュレスポンス + false（早期 return）', async () => {
    const db = makeMockDb({
      'idempotency_keys/existing-key': { response: { reservationId: 'cached-r1', status: 'confirmed' } },
    });
    const res = makeRes();
    const result = await checkIdempotency(db, { headers: { 'x-idempotency-key': 'existing-key' } }, res);
    expect(result).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.bodyJson).toEqual({ reservationId: 'cached-r1', status: 'confirmed' });
  });

  it('既存キーで response フィールドがない場合は duplicate_request エラー', async () => {
    const db = makeMockDb({
      'idempotency_keys/key-without-response': {},
    });
    const res = makeRes();
    const result = await checkIdempotency(db, { headers: { 'x-idempotency-key': 'key-without-response' } }, res);
    expect(result).toBe(false);
    expect(res.bodyJson).toEqual({ error: 'duplicate_request' });
  });
});

describe('saveIdempotencyKey', () => {
  it('キーなしでは何もしない', async () => {
    const db = makeMockDb();
    await saveIdempotencyKey(db, { headers: {} }, { reservationId: 'r1' });
    expect(db.collection).not.toHaveBeenCalled();
  });

  it('キーがあれば 24時間TTL で response 保存', async () => {
    const db = makeMockDb();
    const before = Date.now();
    await saveIdempotencyKey(db, { headers: { 'x-idempotency-key': 'save-key-1' } }, { reservationId: 'r1', status: 'confirmed' });
    expect(db.collection).toHaveBeenCalledWith('idempotency_keys');
    const stored = db._store['idempotency_keys/save-key-1'];
    expect(stored).toBeDefined();
    expect(stored.response).toEqual({ reservationId: 'r1', status: 'confirmed' });
    expect(stored.expireAt).toBeInstanceOf(Date);
    const ttlMs = stored.expireAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000); // 23h以上
    expect(ttlMs).toBeLessThan(25 * 60 * 60 * 1000);   // 25h以下
  });
});
