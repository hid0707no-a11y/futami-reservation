// lib/rateLimitFirestore.ts の Firestore Emulator integration test
// 実 Firestore atomic transaction でカウンタが正しく increment されることを検証

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'futami-yoyaku-492607';
process.env.GOOGLE_CLOUD_PROJECT = 'futami-yoyaku-492607';

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
}
const db = admin.firestore();

import { checkRateLimitFs } from '../../src/lib/rateLimitFirestore';

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

const reqMock = (ip: string = '203.0.113.50') => ({
  headers: { 'x-forwarded-for': ip, 'user-agent': 'integration-test' },
  ip,
});

describe('rateLimitFirestore integration (emulator)', () => {
  beforeEach(async () => {
    await fetch(
      'http://127.0.0.1:8080/emulator/v1/projects/futami-yoyaku-492607/databases/(default)/documents',
      { method: 'DELETE' }
    ).catch(() => { /* noop */ });
  });

  it('単一リクエストで Firestore に rate_limits/{ip|endpoint|minute} ドキュメントが作成される', async () => {
    const res = makeRes();
    const ok = await checkRateLimitFs(db, reqMock(), res, 'createReservation');
    expect(ok).toBe(true);

    // ドキュメントが作成されたか確認
    const snap = await db.collection('rate_limits').get();
    expect(snap.size).toBe(1);
    const doc = snap.docs[0];
    const data = doc.data();
    expect(data.count).toBe(1);
    expect(data.endpoint).toBe('createReservation');
    expect(data.ip).toBe('203.0.113.50');
    expect(data.expireAt).toBeDefined();
  }, 15000);

  it('同IP・同endpointの連続リクエストで count が atomic に増える', async () => {
    const res = makeRes();
    const ip = '203.0.113.51';
    for (let i = 0; i < 5; i++) {
      const ok = await checkRateLimitFs(db, reqMock(ip), res, 'createReservation');
      expect(ok).toBe(true);
    }
    const snap = await db.collection('rate_limits').get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data().count).toBe(5);
  }, 15000);

  it('limit (createReservation=10) を超えると 429 を返し、Firestore も 11 に到達', async () => {
    const ip = '203.0.113.52';
    let lastRes: any;
    for (let i = 0; i < 11; i++) {
      lastRes = makeRes();
      await checkRateLimitFs(db, reqMock(ip), lastRes, 'createReservation');
    }
    expect(lastRes.statusCode).toBe(429);
    expect(lastRes.bodyJson.error).toBe('rate_limit_exceeded');
    const snap = await db.collection('rate_limits').get();
    expect(snap.docs[0].data().count).toBe(11);
  }, 15000);

  it('別IPは別カウンタ（ドキュメント分離）', async () => {
    const res1 = makeRes();
    const res2 = makeRes();
    await checkRateLimitFs(db, reqMock('1.1.1.1'), res1, 'createReservation');
    await checkRateLimitFs(db, reqMock('2.2.2.2'), res2, 'createReservation');
    const snap = await db.collection('rate_limits').get();
    expect(snap.size).toBe(2);
  }, 15000);
});

afterAll(async () => {
  await admin.app().delete();
});
