// Firebase Auth スタッフ権限チェック
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// 旧 index.ts:130-172 を集約。
//
// 認可ルール：
//  1. Authorization: Bearer <id-token> 必須
//  2. token をデコード → custom claim `staff: true` があれば即許可（正規ルート）
//  3. 過渡期：STAFF_ALLOWLIST 環境変数（カンマ/セミコロン/改行区切り）に含まれる
//     email_verified=true のメールアドレスも許可
//  4. それ以外は 403 / 失敗時は recordAuthFailure → 認証失敗カウンタ加算

import * as admin from 'firebase-admin';
import { audit } from './logger';
import { checkAuthFailRateLimit, recordAuthFailure } from './rateLimit';

function decodedTokenHasStaffAccess(decoded: any): boolean {
  const allowlist = (process.env.STAFF_ALLOWLIST || '')
    .split(/[,，;\r\n]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return decoded?.staff === true
    || (!!decoded?.email
      && decoded.email_verified === true
      && allowlist.includes(decoded.email.toLowerCase()));
}

/**
 * 公開予約APIの任意Bearerを検証し、staff由来かだけを返す。
 * 無効/権限なしでも公開予約自体は拒否せず、createdByをwebへ固定するために使う。
 */
export async function isVerifiedStaffRequest(req: any): Promise<boolean> {
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
    return decodedTokenHasStaffAccess(decoded);
  } catch {
    return false;
  }
}

/**
 * Bearer トークン検証 + スタッフ権限確認。
 *
 * 副作用：
 *  - 通過時は req.auth に decoded token を格納
 *  - 失敗時は res に 401/403/429 を書込み済（呼出側は早期 return）
 *
 * 戻り値：true = 通過、false = 拒否（res 送信済）
 */
export async function requireStaffAuth(req: any, res: any): Promise<boolean> {
  if (!checkAuthFailRateLimit(req, res)) return false;

  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
      if (decodedTokenHasStaffAccess(decoded)) {
        req.auth = decoded;
        return true;
      }
      // claim 無し → メールの先頭 2 文字＋ドメインのみログ（PII 最小化）
      const emailMasked = decoded.email
        ? decoded.email.replace(/^(.{2}).*?(@.+)$/, '$1***$2')
        : null;
      audit('auth.forbidden', { uid: decoded.uid, emailMasked }, req);
      recordAuthFailure(req);
      res.status(403).json({ error: 'forbidden_not_staff' });
      return false;
    } catch (e) {
      // トークン無効 → 下の 401 に落とす
    }
  }

  audit('auth.failed', { method: req.method, path: req.path }, req);
  recordAuthFailure(req);
  res.status(401).json({ error: 'unauthorized' });
  return false;
}
