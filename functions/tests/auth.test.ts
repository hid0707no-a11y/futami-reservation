// requireStaffAuth 認可境界テスト（code-review backlog #1）
//
// requireStaffAuth は全スタッフ API（listReservations/updateReservation/cancelReservation/
// changeCampSites/listAuditLog/triggerSyncToSheets）の唯一の認可ゲート。
// custom claim・STAFF_ALLOWLIST・email_verified の判定条件を誰かが緩めても
// 検知できるよう、5境界＋αを固定する。
//
// 依存（admin.auth / rateLimit / logger）はモックして純粋に認可ロジックだけ検証する。

jest.mock('firebase-admin', () => ({
  auth: jest.fn(),
}));
jest.mock('../src/lib/rateLimit', () => ({
  checkAuthFailRateLimit: jest.fn(),
  recordAuthFailure: jest.fn(),
}));
jest.mock('../src/lib/logger', () => ({
  audit: jest.fn(),
}));

import * as admin from 'firebase-admin';
import { checkAuthFailRateLimit, recordAuthFailure } from '../src/lib/rateLimit';
import { isVerifiedStaffRequest, requireStaffAuth } from '../src/lib/auth';

const mockVerifyIdToken = jest.fn();
const mockedAuth = admin.auth as unknown as jest.Mock;
const mockedCheckRL = checkAuthFailRateLimit as unknown as jest.Mock;
const mockedRecordFail = recordAuthFailure as unknown as jest.Mock;

function makeRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: any) => { res.body = b; return res; });
  return res;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.STAFF_ALLOWLIST;
  mockedAuth.mockReturnValue({ verifyIdToken: mockVerifyIdToken });
  mockedCheckRL.mockReturnValue(true); // 既定：レート制限を通過
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('requireStaffAuth（認可境界・backlog #1）', () => {
  it('① staff claim があれば通過し req.auth に decoded を格納', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', staff: true, email: 'a@b.com', email_verified: true });
    const req: any = { headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(true);
    expect(req.auth.uid).toBe('u1');
    expect(res.status).not.toHaveBeenCalled();
    expect(mockedRecordFail).not.toHaveBeenCalled();
  });

  it('② allowlist 掲載 + email_verified=true なら claim 無しでも通過（大小無視）', async () => {
    process.env.STAFF_ALLOWLIST = 'a@b.com, staff@futami.jp';
    mockVerifyIdToken.mockResolvedValue({ uid: 'u2', staff: false, email: 'Staff@Futami.JP', email_verified: true });
    const req: any = { headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(true);
    expect(req.auth.uid).toBe('u2');
  });

  it('③ allowlist 掲載でも email_verified=false は 403 拒否', async () => {
    process.env.STAFF_ALLOWLIST = 'staff@futami.jp';
    mockVerifyIdToken.mockResolvedValue({ uid: 'u3', staff: false, email: 'staff@futami.jp', email_verified: false });
    const req: any = { headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden_not_staff' });
    expect(mockedRecordFail).toHaveBeenCalledTimes(1);
  });

  it('④ allowlist 外 + claim 無し は 403 拒否', async () => {
    process.env.STAFF_ALLOWLIST = 'someone@else.com';
    mockVerifyIdToken.mockResolvedValue({ uid: 'u4', staff: false, email: 'intruder@evil.com', email_verified: true });
    const req: any = { headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(mockedRecordFail).toHaveBeenCalledTimes(1);
  });

  it('⑤ Bearer ヘッダ無しは 401（トークン検証に到達しない）', async () => {
    const req: any = { headers: {} };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockedRecordFail).toHaveBeenCalledTimes(1);
  });

  it('⑥ 無効トークン（verifyIdToken が throw）は 401', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('invalid token'));
    const req: any = { headers: { authorization: 'Bearer badtok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('⑦ レート制限超過時は即 false（429 は rateLimit 側が送信・トークン検証に到達しない）', async () => {
    mockedCheckRL.mockReturnValue(false);
    const req: any = { headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(false);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('⑧ allowlist 空（未設定）かつ claim 無しは 403（既定で誰も通さない）', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u8', staff: false, email: 'a@b.com', email_verified: true });
    const req: any = { headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    const ok = await requireStaffAuth(req, res);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('isVerifiedStaffRequest（公開予約のcreatedBy偽装防止）', () => {
  it('Bearer無し・無効・権限なしはfalse', async () => {
    expect(await isVerifiedStaffRequest({ headers: {} })).toBe(false);
    mockVerifyIdToken.mockRejectedValueOnce(new Error('bad token'));
    expect(await isVerifiedStaffRequest({ headers: { authorization: 'Bearer bad' } })).toBe(false);
    mockVerifyIdToken.mockResolvedValueOnce({ staff: false, email: 'x@example.com', email_verified: true });
    expect(await isVerifiedStaffRequest({ headers: { authorization: 'Bearer user' } })).toBe(false);
  });

  it('staff claimまたは検証済みallowlistだけtrue', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ staff: true });
    expect(await isVerifiedStaffRequest({ headers: { authorization: 'Bearer staff' } })).toBe(true);

    process.env.STAFF_ALLOWLIST = 'staff@example.com';
    mockVerifyIdToken.mockResolvedValueOnce({
      staff: false, email: 'Staff@Example.com', email_verified: true,
    });
    expect(await isVerifiedStaffRequest({ headers: { authorization: 'Bearer allow' } })).toBe(true);
  });
});
