// Firestore-backed Rate Limiter のユニットテスト（mock Firestore）
// 2026-05-05 新設（/gfu Phase A-2 拡張）

import { checkRateLimitFs } from '../src/lib/rateLimitFirestore';

// 1分単位バケットでの atomic increment を シミュレートするモック
function makeMockDbWithTxn(initialCounters: Record<string, number> = {}) {
  const store: Record<string, any> = {};
  // 既存カウンタを set
  Object.entries(initialCounters).forEach(([k, v]) => {
    store[`rate_limits/${k}`] = { count: v, ip: 'x', endpoint: 'y', minute: 0, expireAt: new Date() };
  });

  return {
    runTransaction: jest.fn(async (fn: any) => {
      const tx = {
        get: jest.fn(async (ref: any) => ({
          exists: store[ref._path] !== undefined,
          data: () => store[ref._path],
        })),
        set: jest.fn((ref: any, data: any) => {
          store[ref._path] = data;
        }),
      };
      return await fn(tx);
    }),
    collection: jest.fn((collName: string) => ({
      doc: jest.fn((id: string) => ({
        _path: `${collName}/${id}`,
      })),
    })),
    _store: store,
    _failNext: false,
  } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    bodyJson: null as any,
    headers,
    set(k: string, v: string) { headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.bodyJson = b; return this; },
  };
}

const reqMock = (overrides: any = {}) => ({
  headers: {
    'x-forwarded-for': '203.0.113.10',
    'user-agent': 'jest',
    origin: 'https://hid0707no-a11y.github.io',
    ...overrides.headers,
  },
  ip: '127.0.0.1',
  ...overrides,
});

describe('checkRateLimitFs', () => {
  it('初回リクエストは通過する', async () => {
    const db = makeMockDbWithTxn();
    const res = makeRes();
    const result = await checkRateLimitFs(db, reqMock(), res, 'createReservation');
    expect(result).toBe(true);
    expect(res.statusCode).toBe(0); // 何も書込んでない
  });

  it('limit 内なら通過する（createReservation=10/分）', async () => {
    const db = makeMockDbWithTxn();
    const res = makeRes();
    // 10回ループしても通過
    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimitFs(db, reqMock(), res, 'createReservation');
      expect(r).toBe(true);
    }
    expect(res.statusCode).toBe(0);
  });

  it('limit 超過で 429 を返す', async () => {
    const db = makeMockDbWithTxn();
    const res = makeRes();
    // 11回目で超過（createReservation=10）
    for (let i = 0; i < 11; i++) {
      await checkRateLimitFs(db, reqMock(), res, 'createReservation');
    }
    expect(res.statusCode).toBe(429);
    expect(res.bodyJson).toMatchObject({ error: 'rate_limit_exceeded' });
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('未知 endpoint は default=60 が適用される', async () => {
    const db = makeMockDbWithTxn();
    const res = makeRes();
    // 60回までは通過、61回目で 429
    for (let i = 0; i < 60; i++) {
      const r = await checkRateLimitFs(db, reqMock(), res, 'unknown_endpoint');
      expect(r).toBe(true);
    }
    const r61 = await checkRateLimitFs(db, reqMock(), res, 'unknown_endpoint');
    expect(r61).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it('Firestore エラー時は fail-open で通過させる（可用性優先）', async () => {
    const db = {
      runTransaction: jest.fn(async () => { throw new Error('Firestore unavailable'); }),
      collection: jest.fn((c: string) => ({ doc: jest.fn((id: string) => ({ _path: `${c}/${id}` })) })),
    } as any;
    const res = makeRes();
    const result = await checkRateLimitFs(db, reqMock(), res, 'createReservation');
    expect(result).toBe(true); // fail-open
    expect(res.statusCode).toBe(0); // 429 は返さない
  });

  it('IP 別にカウントされる（別IPは別カウンタ）', async () => {
    const db = makeMockDbWithTxn();
    const res1 = makeRes();
    const res2 = makeRes();
    // IP1 で 11回 → 429
    for (let i = 0; i < 11; i++) {
      await checkRateLimitFs(db, reqMock({ headers: { 'x-forwarded-for': '1.1.1.1' } }), res1, 'createReservation');
    }
    expect(res1.statusCode).toBe(429);
    // IP2 で 1回 → 通過
    const r = await checkRateLimitFs(db, reqMock({ headers: { 'x-forwarded-for': '2.2.2.2' } }), res2, 'createReservation');
    expect(r).toBe(true);
    expect(res2.statusCode).toBe(0);
  });

  it('endpoint 別にカウントされる（別endpointは別カウンタ）', async () => {
    const db = makeMockDbWithTxn();
    const res1 = makeRes();
    const res2 = makeRes();
    // createReservation で 11回 → 429
    for (let i = 0; i < 11; i++) {
      await checkRateLimitFs(db, reqMock(), res1, 'createReservation');
    }
    expect(res1.statusCode).toBe(429);
    // listReservations で 1回 → 通過
    const r = await checkRateLimitFs(db, reqMock(), res2, 'listReservations');
    expect(r).toBe(true);
  });
});
