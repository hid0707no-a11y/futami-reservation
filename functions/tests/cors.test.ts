// CORS / Origin 検証のユニットテスト
// 2026-05-05 新設（/gfu Phase A-2 拡張）

import { isOriginAllowed, setCors, checkOrigin, ALLOWED_ORIGINS } from '../src/lib/cors';

// 軽量モック
function mockRes() {
  const calls: any[] = [];
  let statusCode = 200;
  let bodyJson: any = null;
  return {
    headers: {} as Record<string, string>,
    statusCode,
    bodyJson,
    set(k: string, v: string) { (this.headers as any)[k] = v; calls.push(['set', k, v]); return this; },
    status(c: number) { this.statusCode = c; calls.push(['status', c]); return this; },
    send(b: any) { calls.push(['send', b]); return this; },
    json(b: any) { this.bodyJson = b; calls.push(['json', b]); return this; },
    _calls: calls,
  };
}

describe('isOriginAllowed', () => {
  it('GitHub Pages は許可', () => {
    expect(isOriginAllowed('https://hid0707no-a11y.github.io')).toBe(true);
  });
  it('カスタムドメインは許可', () => {
    expect(isOriginAllowed('https://yoyaku.fureai-iyosasaeru.com')).toBe(true);
  });
  it('localhost 開発系は許可', () => {
    expect(isOriginAllowed('http://localhost:3000')).toBe(true);
    expect(isOriginAllowed('http://localhost:8080')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5500')).toBe(true);
  });
  it('未知ドメインは拒否', () => {
    expect(isOriginAllowed('https://evil.example.com')).toBe(false);
    expect(isOriginAllowed('http://localhost:9999')).toBe(false); // ポート違いも拒否
  });
  it('空文字（origin ヘッダ無し）は拒否', () => {
    expect(isOriginAllowed('')).toBe(false);
  });
  it('null は拒否', () => {
    expect(isOriginAllowed('null')).toBe(false);
  });
});

describe('setCors', () => {
  it('許可オリジンには ACAO ヘッダを反映する', () => {
    const res = mockRes();
    const req = { method: 'GET', headers: { origin: 'https://hid0707no-a11y.github.io' } };
    const handled = setCors(req, res);
    expect(handled).toBe(false); // 通常GETはfalse返し（呼出側継続）
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://hid0707no-a11y.github.io');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('X-Idempotency-Key');
  });

  it('未許可オリジンには ACAO ヘッダを付けない（修正済バグ #4）', () => {
    const res = mockRes();
    const req = { method: 'GET', headers: { origin: 'https://evil.example.com' } };
    setCors(req, res);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    // ただし Methods/Headers は付く（許可リスト外でもブラウザが吐ける情報）
    expect(res.headers['Access-Control-Allow-Methods']).toBeDefined();
  });

  it('OPTIONS preflight は 204 を送り true を返す', () => {
    const res = mockRes();
    const req = { method: 'OPTIONS', headers: { origin: 'https://hid0707no-a11y.github.io' } };
    const handled = setCors(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
  });

  it('origin ヘッダが空でも crash しない', () => {
    const res = mockRes();
    const req = { method: 'GET', headers: {} };
    const handled = setCors(req, res);
    expect(handled).toBe(false);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('checkOrigin (CSRF対策)', () => {
  it('GET / OPTIONS は origin に関係なく通す', () => {
    expect(checkOrigin({ method: 'GET', headers: {} }, mockRes())).toBe(true);
    expect(checkOrigin({ method: 'OPTIONS', headers: { origin: 'https://evil.com' } }, mockRes())).toBe(true);
  });

  it('POST で origin 無し（同一オリジン or 直アクセス）は通す', () => {
    expect(checkOrigin({ method: 'POST', headers: {} }, mockRes())).toBe(true);
  });

  it('POST で許可オリジンは通す', () => {
    const req = { method: 'POST', headers: { origin: 'https://yoyaku.fureai-iyosasaeru.com' } };
    expect(checkOrigin(req, mockRes())).toBe(true);
  });

  it('POST で未許可オリジンは 403 forbidden_origin', () => {
    const res = mockRes();
    const req = { method: 'POST', headers: { origin: 'https://evil.example.com' } };
    expect(checkOrigin(req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.bodyJson).toEqual({ error: 'forbidden_origin' });
  });

  it('PATCH / DELETE も同様に未許可オリジンは弾く', () => {
    const resPatch = mockRes();
    expect(checkOrigin({ method: 'PATCH', headers: { origin: 'https://x.com' } }, resPatch)).toBe(false);
    expect(resPatch.statusCode).toBe(403);

    const resDelete = mockRes();
    expect(checkOrigin({ method: 'DELETE', headers: { origin: 'https://x.com' } }, resDelete)).toBe(false);
    expect(resDelete.statusCode).toBe(403);
  });
});

describe('ALLOWED_ORIGINS リスト', () => {
  it('5件登録されている（変更時はテスト更新が必要・ステージング追加等）', () => {
    expect(ALLOWED_ORIGINS).toHaveLength(5);
  });
  it('本番URLが先頭2件にある', () => {
    expect(ALLOWED_ORIGINS[0]).toBe('https://yoyaku.fureai-iyosasaeru.com');
    expect(ALLOWED_ORIGINS[1]).toBe('https://hid0707no-a11y.github.io');
  });
});
