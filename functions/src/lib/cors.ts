// CORS / Origin 検証モジュール
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// 旧 index.ts:76-82, 192-206, 261-267 を集約。

export const ALLOWED_ORIGINS = [
  'https://yoyaku.fureai-iyosasaeru.com',
  'https://hid0707no-a11y.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];

/**
 * オリジンが許可リストに含まれるかどうかの純粋判定（テスト容易）。
 */
export function isOriginAllowed(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Express-like Request/Response を受け取り、CORS ヘッダを設定する。
 * 未一致オリジンには ACAO ヘッダを付けない（ブラウザが正常に CORS エラーで弾く）。
 *
 * 戻り値：true = OPTIONS preflight に応答済（呼出側は早期 return すべき）
 *         false = 通常のリクエスト（呼出側で処理を継続する）
 */
export function setCors(req: any, res: any): boolean {
  const origin = req.headers?.origin || '';
  if (isOriginAllowed(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Idempotency-Key');
  res.set('Access-Control-Max-Age', '3600');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

/**
 * CSRF 対策：書込みメソッド（POST/PATCH/DELETE）に対して Origin ヘッダを検証する。
 * 戻り値：true = 通過、false = 403 を送信済（呼出側は早期 return）
 */
export function checkOrigin(req: any, res: any): boolean {
  if (req.method === 'GET' || req.method === 'OPTIONS') return true;
  const origin = req.headers?.origin || '';
  if (!origin || isOriginAllowed(origin)) return true;
  res.status(403).json({ error: 'forbidden_origin' });
  return false;
}
