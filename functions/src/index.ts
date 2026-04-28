import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import { google } from 'googleapis';

admin.initializeApp();

// ===== 監査ログ =====
function auditLog(action: string, details: Record<string, any>, req: any) {
  const entry = {
    severity: 'INFO',
    message: `AUDIT: ${action}`,
    audit: true,
    action,
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown',
    userAgent: req.headers['user-agent'] || '',
    origin: req.headers.origin || '',
    timestamp: new Date().toISOString(),
    ...details,
  };
  console.log(JSON.stringify(entry));
}
const db = admin.firestore();

// ===== メール送信設定 =====
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const STAFF_EMAIL = process.env.STAFF_EMAIL || 'info@fureai-iyosasaeru.com';

const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

interface MailData {
  planName: string;
  roomName: string;
  startDate: string;
  endDate: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress?: string;
  note: string;
  reservationId: string;
  guestCount?: number;
  isCamp?: boolean;
  isFutamiDay?: boolean;
  isTennis?: boolean;
  saunaOptionsText?: string;
}

// customer.{zip,address1,address2} を1行の住所文字列に整形
// zipのみ入力されていても住所本体（address1/address2）が無ければ空文字を返す
// （郵便番号だけメール本文に出ても請求書送付に使えないため）
function formatCustomerAddress(c: any): string {
  if (!c) return '';
  const zip = (c.zip || '').toString().trim();
  const a1 = (c.address1 || '').toString().trim();
  const a2 = (c.address2 || '').toString().trim();
  if (!a1 && !a2) return '';
  const zipPart = zip ? `〒${zip} ` : '';
  return `${zipPart}${a1}${a2 ? ' ' + a2 : ''}`.trim();
}

async function sendConfirmationEmail(data: MailData): Promise<void> {
  if (!transporter || !data.customerEmail) return;
  try {
    const subject = `【ふたみふれあい公園】ご予約を受け付けました（${data.startDate}）`;
    const body = `${data.customerName} 様

ふたみ潮風ふれあい公園をご予約いただきありがとうございます。
以下の内容で予約を受け付けました。

━━━━━━━━━━━━━━━━━━
予約番号：${data.reservationId}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.guestCount ? '\n' + (data.isCamp ? '区画数' : '人数') + '：' + data.guestCount + (data.isCamp ? '区画' : '名') : ''}${data.customerAddress ? '\nご住所：' + data.customerAddress : ''}${data.saunaOptionsText ? '\nオプション：' + data.saunaOptionsText : ''}${data.note ? '\n備考：' + data.note : ''}
━━━━━━━━━━━━━━━━━━

※このメールは自動送信です。
※ご不明な点がございましたら、お電話にてお問い合わせください。

ふたみ潮風ふれあい公園
TEL: 089-986-0522
`;

    await transporter.sendMail({
      from: `"ふたみふれあい公園" <${SMTP_USER}>`,
      to: data.customerEmail,
      subject,
      text: body,
    });
    console.log('Confirmation email sent to', data.customerEmail);
  } catch (e) {
    console.error('Failed to send confirmation email:', e);
  }
}

async function sendStaffNotification(data: MailData, type: 'new' | 'cancel'): Promise<void> {
  if (!transporter) return;
  try {
    const prefix = type === 'new' ? '【新規予約】' : '【キャンセル】';
    const subject = `${prefix} ${data.customerName}様 ${data.startDate} ${data.roomName}`;
    const body = `${prefix}

予約番号：${data.reservationId}
予約者：${data.customerName}
電話：${data.customerPhone}
メール：${data.customerEmail || 'なし'}
ご住所：${data.customerAddress || 'なし'}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.guestCount ? '\n' + (data.isCamp ? '区画数' : '人数') + '：' + data.guestCount + (data.isCamp ? '区画' : '名') : ''}${data.saunaOptionsText ? '\nオプション：' + data.saunaOptionsText : ''}${data.note ? '\n備考：' + data.note : ''}
`;

    await transporter.sendMail({
      from: `"ふたみ予約システム" <${SMTP_USER}>`,
      to: STAFF_EMAIL,
      subject,
      text: body,
    });
    console.log('Staff notification sent for', data.reservationId);
  } catch (e) {
    console.error('Failed to send staff notification:', e);
  }
}

async function sendCancellationEmail(data: MailData): Promise<void> {
  if (!transporter || !data.customerEmail) return;
  try {
    const subject = `【ふたみふれあい公園】ご予約をキャンセルしました（${data.startDate}）`;
    const body = `${data.customerName} 様

以下のご予約をキャンセルいたしました。

━━━━━━━━━━━━━━━━━━
予約番号：${data.reservationId}
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}
━━━━━━━━━━━━━━━━━━

またのご利用をお待ちしております。

ふたみ潮風ふれあい公園
TEL: 089-986-0522
`;

    await transporter.sendMail({
      from: `"ふたみふれあい公園" <${SMTP_USER}>`,
      to: data.customerEmail,
      subject,
      text: body,
    });
    console.log('Cancellation email sent to', data.customerEmail);
  } catch (e) {
    console.error('Failed to send cancellation email:', e);
  }
}

const ALLOWED_ORIGINS = [
  'https://yoyaku.fureai-iyosasaeru.com',
  'https://hid0707no-a11y.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
];

// ===== レート制限（インメモリ・IPベース） =====
const rateLimitStore: Map<string, { count: number; resetAt: number }> = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分
const RATE_LIMITS: Record<string, number> = {
  createReservation: 10,   // 1分10回
  cancelReservation: 10,
  updateReservation: 20,
  listReservations: 30,
  availability: 60,
  futamiDays: 30,
  default: 60,
};

function checkRateLimit(req: any, res: any, endpoint: string): boolean {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  const limit = RATE_LIMITS[endpoint] || RATE_LIMITS.default;

  let entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(key, entry);
  }

  entry.count++;
  if (entry.count > limit) {
    auditLog('rate_limit.exceeded', { endpoint, ip, count: entry.count, limit }, req);
    res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
    return false;
  }
  return true;
}

// 古いエントリを定期クリーンアップ（メモリリーク防止）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

// ===== 認証失敗専用レートリミット =====
// 通常の checkRateLimit は全呼び出しをカウントするが、認証失敗はもっと厳しく
// 絞りたい（ブルートフォース / 監査ログスパム対策）。
// 失敗時のみカウントし、IP 単位で 1 分あたり 10 回を超えると 429 を返す。
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const AUTH_FAIL_LIMIT = 10;

function checkAuthFailRateLimit(req: any, res: any): boolean {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const key = `auth_fail:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) return true; // 初回 or ウィンドウ切れ
  if (entry.count >= AUTH_FAIL_LIMIT) {
    auditLog('auth.rate_limited', { ip, count: entry.count }, req);
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'too_many_auth_failures', retryAfter });
    return false;
  }
  return true;
}

function recordAuthFailure(req: any): void {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const key = `auth_fail:${ip}`;
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + AUTH_FAIL_WINDOW_MS };
    rateLimitStore.set(key, entry);
  }
  entry.count++;
}

// ===== 冪等性チェック（二重予約防止） =====
async function checkIdempotency(req: any, res: any): Promise<boolean> {
  const key = req.headers['x-idempotency-key'];
  if (!key || typeof key !== 'string' || key.length > 64) return true; // キーなしはスキップ

  const ref = db.collection('idempotency_keys').doc(key);
  const doc = await ref.get();
  if (doc.exists) {
    const data = doc.data() as any;
    res.status(200).json(data.response || { error: 'duplicate_request' });
    return false; // 既に処理済み
  }
  return true;
}

async function saveIdempotencyKey(req: any, response: any): Promise<void> {
  const key = req.headers['x-idempotency-key'];
  if (!key) return;
  try {
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24時間後
    await db.collection('idempotency_keys').doc(key).set({
      response,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expireAt,
    });
  } catch (e) {
    console.error('idempotency save failed:', e);
  }
}

function setCors(req: any, res: any): boolean {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  } else {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS[1]); // GitHub Pages
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
 * Firebase Auth ID Token を検証し、スタッフ権限を確認する。
 * - Bearer トークン必須
 * - デコード済みトークンを req.auth に格納（下流で createdBy 等に使用）
 * - Custom claim `staff: true` がついたユーザーのみ許可
 *   （過渡期は STAFF_ALLOWLIST 環境変数に書いたメールも許可する。
 *    ただし email_verified が true のものに限る）
 */
async function requireStaffAuth(req: any, res: any): Promise<boolean> {
  // 認証失敗系のレートリミット（IP 単位で 1 分 10 回）
  // 失敗が連続した IP は一定時間 429 で弾く（ブルートフォース / ログスパム対策）
  if (!checkAuthFailRateLimit(req, res)) return false;

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
      // custom claim `staff:true` があれば即OK（これが正規ルート）
      const isStaffClaim = decoded.staff === true;
      // 過渡期: 環境変数 STAFF_ALLOWLIST に含まれるメールも許可
      // - 半角/全角カンマ、セミコロン、改行で split
      // - email_verified が true のアカウントのみに限定（未認証メールの乗っ取りを防ぐ）
      const allowlist = (process.env.STAFF_ALLOWLIST || '')
        .split(/[,\uFF0C;\r\n]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      const emailAllowed = !!decoded.email
        && decoded.email_verified === true
        && allowlist.includes(decoded.email.toLowerCase());
      if (isStaffClaim || emailAllowed) {
        req.auth = decoded;
        return true;
      }
      // claim 無し → メールの先頭 2 文字＋ドメインのみログ（PII 最小化）
      const emailMasked = decoded.email
        ? decoded.email.replace(/^(.{2}).*?(@.+)$/, '$1***$2')
        : null;
      auditLog('auth.forbidden', { uid: decoded.uid, emailMasked }, req);
      recordAuthFailure(req);
      res.status(403).json({ error: 'forbidden_not_staff' });
      return false;
    } catch (e) {
      // トークン無効 → 下の 401 に落とす
    }
  }

  auditLog('auth.failed', { method: req.method, path: req.path }, req);
  recordAuthFailure(req);
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// ===== CSRF対策：Origin検証（POST/PATCH/DELETE） =====
function checkOrigin(req: any, res: any): boolean {
  if (req.method === 'GET' || req.method === 'OPTIONS') return true;
  const origin = req.headers.origin || '';
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return true;
  res.status(403).json({ error: 'forbidden_origin' });
  return false;
}

// ===== 入力バリデーション =====
// camp_1〜camp_8: 2026-04-28〜 8区画個別管理に移行（旧 'camp' は廃止）
const VALID_ROOM_IDS = new Set([
  'room_27','room_6_1','room_6_2','room_6_3','room_6_4',
  'room_exp','room_train','room_kitchen',
  'court_1','court_2','court_3','court_4','court_5',
  'midori','sauna','sauna_share',
  'camp_1','camp_2','camp_3','camp_4','camp_5','camp_6','camp_7','camp_8',
  'lodge_a','lodge_b',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateReservationInput(body: any, res: any): boolean {
  const { planId, roomIds, slots, startDate, endDate, customer, note } = body;

  // planId: 文字列・100文字以内
  if (typeof planId !== 'string' || planId.length > 100) {
    res.status(400).json({ error: 'invalid_planId' });
    return false;
  }

  // roomIds: ホワイトリスト検証
  if (!Array.isArray(roomIds) || roomIds.length === 0 || roomIds.length > 10) {
    res.status(400).json({ error: 'invalid_roomIds' });
    return false;
  }
  for (const rid of roomIds) {
    if (!VALID_ROOM_IDS.has(rid)) {
      res.status(400).json({ error: 'invalid_roomId', detail: rid });
      return false;
    }
  }

  // slots: 配列・各要素が文字列・形式チェック
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 500) {
    res.status(400).json({ error: 'invalid_slots' });
    return false;
  }
  for (const s of slots) {
    if (typeof s !== 'string' || s.length > 50) {
      res.status(400).json({ error: 'invalid_slot_format' });
      return false;
    }
  }

  // 日付: YYYY-MM-DD形式
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    res.status(400).json({ error: 'invalid_date_format' });
    return false;
  }

  // 予約受付期間チェック（宿泊系365日、その他90日）
  const stayRooms = new Set(['room_27','room_6_1','room_6_2','room_6_3','room_6_4','room_exp','room_train','room_kitchen']);
  const isStayCategory = roomIds.every((r: string) => stayRooms.has(r));
  const maxDays = isStayCategory ? 365 : 90;
  const now = new Date();
  const maxDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + maxDays);
  const bookingDate = new Date(startDate + 'T00:00:00');
  if (bookingDate > maxDate) {
    res.status(400).json({ error: 'booking_too_far', detail: `${maxDays}日先まで予約可能です` });
    return false;
  }

  // customer: 名前50文字・電話20文字・メール100文字
  if (!customer?.name || typeof customer.name !== 'string' || customer.name.length > 50) {
    res.status(400).json({ error: 'invalid_customer_name' });
    return false;
  }
  if (!customer?.phone || typeof customer.phone !== 'string' || customer.phone.length > 20) {
    res.status(400).json({ error: 'invalid_customer_phone' });
    return false;
  }
  if (customer.email && (typeof customer.email !== 'string' || customer.email.length > 100)) {
    res.status(400).json({ error: 'invalid_customer_email' });
    return false;
  }
  // 住所（任意・宿泊系プランは UI 側で必須化）
  // zip 10文字・address1 100文字・address2 100文字
  if (customer.zip && (typeof customer.zip !== 'string' || customer.zip.length > 10)) {
    res.status(400).json({ error: 'invalid_customer_zip' });
    return false;
  }
  if (customer.address1 && (typeof customer.address1 !== 'string' || customer.address1.length > 100)) {
    res.status(400).json({ error: 'invalid_customer_address1' });
    return false;
  }
  if (customer.address2 && (typeof customer.address2 !== 'string' || customer.address2.length > 100)) {
    res.status(400).json({ error: 'invalid_customer_address2' });
    return false;
  }

  // note: 500文字以内
  if (note && (typeof note !== 'string' || note.length > 500)) {
    res.status(400).json({ error: 'invalid_note' });
    return false;
  }

  return true;
}

/**
 * ふたみの日判定（Firestore /config/special_days を参照）
 * - sauna_capacity_days: 配列で日付を保持
 * - 30秒キャッシュ
 */
const SHARED_SLOT_CAPACITY = 8; // ふたみの日サウナ専用（キャンプは2026-04-28〜個別管理に移行）
let _futamiDaysCache: { dates: Set<string>; expiresAt: number } | null = null;
const FUTAMI_CACHE_TTL_MS = 30 * 1000;

async function getFutamiDays(): Promise<Set<string>> {
  const now = Date.now();
  if (_futamiDaysCache && _futamiDaysCache.expiresAt > now) {
    return _futamiDaysCache.dates;
  }
  const doc = await db.doc('config/special_days').get();
  const dates: string[] = (doc.exists && (doc.data() as any)?.sauna_capacity_days) || [];
  const set = new Set(dates);
  _futamiDaysCache = { dates: set, expiresAt: now + FUTAMI_CACHE_TTL_MS };
  return set;
}

async function isFutamiDay(dateStr: string): Promise<boolean> {
  const set = await getFutamiDays();
  return set.has(dateStr);
}

/**
 * GET /availability?from=2026-04-10&to=2026-06-30
 */
export const availability = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'availability')) return;
    try {
      const from = (req.query.from as string) || '';
      const to = (req.query.to as string) || '';

      let query: FirebaseFirestore.Query = db.collection('slots');
      if (from) query = query.where('date', '>=', from);
      if (to) query = query.where('date', '<=', to);

      const snap = await query.get();
      const occupiedSlots = snap.docs.map(d => d.id);

      // shared_slots（ふたみの日サウナ）も取得
      let sharedQuery: FirebaseFirestore.Query = db.collection('shared_slots');
      if (from) sharedQuery = sharedQuery.where('date', '>=', from);
      if (to) sharedQuery = sharedQuery.where('date', '<=', to);
      const sharedSnap = await sharedQuery.get();
      const sharedSlots: any = {};
      sharedSnap.docs.forEach(d => {
        const data = d.data();
        sharedSlots[d.id] = {
          capacity: data.capacity || SHARED_SLOT_CAPACITY,
          used: data.used || 0,
          remaining: (data.capacity || SHARED_SLOT_CAPACITY) - (data.used || 0),
        };
      });

      // tennis_slots（テニス30分単位）
      let tennisQuery: FirebaseFirestore.Query = db.collection('tennis_slots');
      if (from) tennisQuery = tennisQuery.where('date', '>=', from);
      if (to) tennisQuery = tennisQuery.where('date', '<=', to);
      const tennisSnap = await tennisQuery.get();
      const tennisSlots = tennisSnap.docs.map(d => d.id);

      res.status(200).json({
        generatedAt: new Date().toISOString(),
        count: occupiedSlots.length,
        occupiedSlots,
        sharedSlots,
        tennisSlots,
      });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * POST /reservations
 * 予約作成（トランザクションで競合検出）
 */
export const createReservation = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'createReservation')) return;
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    try {
      const body = req.body || {};
      const {
        planId,
        roomIds,
        slots,
        startDate,
        endDate,
        nights = 0,
        customer,
        guests,
        pricing,
        createdBy = 'web',
        note,
        guestCount, // ふたみの日用：占有人数（1〜8）
      } = body;

      // CSRF対策
      if (!checkOrigin(req, res)) return;

      // バリデーション
      if (!validateReservationInput(body, res)) return;

      // 冪等性チェック（二重予約防止）
      if (!(await checkIdempotency(req, res))) return;

      // ===== テニス専用ルート（tennis_slots 30分単位）=====
      const isTennis = Array.isArray(roomIds) && roomIds.length > 0 && roomIds[0].startsWith('court_');
      if (isTennis) {
        try {
          const tennisResult = await db.runTransaction(async tx => {
            const slotRefs = slots.map((key: string) => db.collection('tennis_slots').doc(key));
            const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));
            const conflicts = slotDocs
              .map((d: any, i: number) => (d.exists ? slots[i] : null))
              .filter((x: any) => x !== null);
            if (conflicts.length > 0) {
              throw { code: 'slot_conflict', conflicts };
            }
            const resRef = db.collection('reservations').doc();
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId,
              roomIds,
              slots,
              startDate,
              endDate,
              nights: 0,
              customer,
              guests: guests || null,
              pricing: pricing || null,
              payment: { method: 'onsite', status: 'unpaid' },
              status: 'confirmed',
              note: note || null,
              createdAt: now,
              createdBy,
              updatedAt: now,
              isTennis: true,
            });
            slots.forEach((key: string, i: number) => {
              const parts = key.split('|');
              const courtId = parts[0];
              const date = parts[1];
              const time = parts[2];
              tx.set(slotRefs[i], {
                slotKey: key,
                roomId: courtId,
                date,
                time,
                reservationId: resRef.id,
                createdAt: now,
              });
            });
            return resRef.id;
          });
          // メール送信（非同期・失敗してもレスポンスは返す）
          const mailData: MailData = {
            planName: planId, roomName: roomIds.join(', '), startDate, endDate,
            customerName: customer.name, customerPhone: customer.phone,
            customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
            note: note || '',
            reservationId: tennisResult, isTennis: true,
          };
          sendConfirmationEmail(mailData).catch(() => {});
          sendStaffNotification(mailData, 'new').catch(() => {});
          auditLog('reservation.create', { reservationId: tennisResult, planId, roomIds, startDate, customerName: customer.name, type: 'tennis' }, req);
          const tennisResp = { reservationId: tennisResult, status: 'confirmed', isTennis: true };
          saveIdempotencyKey(req, tennisResp).catch(() => {});

          res.status(201).json(tennisResp);
          return;
        } catch (e: any) {
          if (e?.code === 'slot_conflict') {
            res.status(409).json({ error: 'slot_conflict', conflicts: e.conflicts });
            return;
          }
          throw e;
        }
      }

      // ===== ふたみの日サウナ専用ルート（1予約で完売・排他制御）=====
      const isFutamiSauna = planId === 'plan_sauna_futami' || (roomIds[0] === 'sauna_share');
      if (isFutamiSauna) {
        const seats = Number(guestCount || guests?.adult || 2);
        if (seats < 2 || seats > 8) {
          res.status(400).json({ error: 'invalid_guest_count', detail: '2〜8人' });
          return;
        }
        // 全スロットがふたみの日であることを確認
        const futamiSet = await getFutamiDays();
        for (const key of slots) {
          const date = key.split('|')[1];
          if (!futamiSet.has(date)) {
            res.status(400).json({ error: 'not_futami_day', detail: date });
            return;
          }
        }

        try {
          const result = await db.runTransaction(async tx => {
            // 排他制御（通常slotsと同じ）：既に予約があれば競合
            const slotRefs = slots.map((key: string) => db.collection('slots').doc(key));
            const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));
            const conflicts = slotDocs
              .map((d: any, i: number) => (d.exists ? slots[i] : null))
              .filter((x: any) => x !== null);
            if (conflicts.length > 0) {
              throw { code: 'slot_conflict', conflicts };
            }

            const resRef = db.collection('reservations').doc();
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId,
              roomIds: ['sauna_share'],
              slots,
              startDate,
              endDate,
              nights: 0,
              customer,
              guests: guests || null,
              guestCount: seats,
              pricing: pricing || null,
              payment: { method: 'onsite', status: 'unpaid' },
              status: 'confirmed',
              note: note || null,
              createdAt: now,
              createdBy,
              updatedAt: now,
              isFutamiDay: true,
            });

            // slotsに書込（排他用）
            slots.forEach((key: string, i: number) => {
              const [, date, hourStr] = key.split('|');
              tx.set(slotRefs[i], {
                slotKey: key,
                roomId: 'sauna_share',
                date,
                hour: parseInt(hourStr, 10),
                reservationId: resRef.id,
                createdAt: now,
              });
            });

            return resRef.id;
          });
          const mailData: MailData = {
            planName: planId, roomName: 'サンセットサウナ（ふたみの日）', startDate, endDate,
            customerName: customer.name, customerPhone: customer.phone,
            customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
            note: note || '',
            reservationId: result, guestCount: seats, isFutamiDay: true,
            saunaOptionsText: formatSaunaOptions(pricing?.saunaOptions) || undefined,
          };
          sendConfirmationEmail(mailData).catch(() => {});
          sendStaffNotification(mailData, 'new').catch(() => {});
          auditLog('reservation.create', { reservationId: result, planId, roomIds, startDate, customerName: customer.name, type: 'futami_sauna', seats }, req);
          const futamiResp = { reservationId: result, status: 'confirmed', isFutamiDay: true, seats };
          saveIdempotencyKey(req, futamiResp).catch(() => {});

          res.status(201).json(futamiResp);
          return;
        } catch (e: any) {
          if (e?.code === 'slot_conflict') {
            res.status(409).json({ error: 'slot_conflict', conflicts: e.conflicts });
            return;
          }
          throw e;
        }
      }

      // ===== キャンプ場（2026-04-28〜 8区画個別管理に移行）=====
      // 旧 shared_slots 方式は廃止。各 camp_N|date|hour スロットを個別占有する通常ルートに統合。
      // フロントから複数区画選択時は roomIds = ['camp_1','camp_3',...] で送信される。
      const isCamp = roomIds.every((r: string) => r.startsWith('camp_'));

      // ===== 通常プラン（既存の slots collection）=====
      // トランザクションで競合検出＋書込
      const result = await db.runTransaction(async tx => {
        // 1. 全slotKeyをチェック
        const slotRefs = slots.map((key: string) => db.collection('slots').doc(key));
        const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));

        const conflicts = slotDocs
          .map((d: any, i: number) => (d.exists ? slots[i] : null))
          .filter((x: any) => x !== null);

        if (conflicts.length > 0) {
          throw { code: 'slot_conflict', conflicts };
        }

        // 2. reservations 作成
        const resRef = db.collection('reservations').doc();
        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(resRef, {
          planId,
          roomIds,
          slots,
          startDate,
          endDate,
          nights,
          customer,
          guests: guests || null,
          ...(isCamp ? { guestCount: roomIds.length, isCamp: true } : {}),
          pricing: pricing || null,
          payment: { method: 'onsite', status: 'unpaid' },
          status: 'confirmed',
          note: note || null,
          createdAt: now,
          createdBy,
          updatedAt: now,
        });

        // 3. 全slotを書込
        slots.forEach((key: string, i: number) => {
          const [roomId, date, hourStr] = key.split('|');
          tx.set(slotRefs[i], {
            slotKey: key,
            roomId,
            date,
            hour: parseInt(hourStr, 10),
            reservationId: resRef.id,
            createdAt: now,
          });
        });

        return resRef.id;
      });

      // キャンプ予約はメール本文の roomName を「区画①②③」形式に整形
      const roomNameForMail = isCamp
        ? roomIds.map((r: string) => '区画' + ['①','②','③','④','⑤','⑥','⑦','⑧'][parseInt(r.split('_')[1], 10) - 1]).join('・')
        : roomIds.join(', ');
      const mailData: MailData = {
        planName: planId, roomName: roomNameForMail, startDate, endDate,
        customerName: customer.name, customerPhone: customer.phone,
        customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
        note: note || '',
        reservationId: result,
        ...(isCamp ? { isCamp: true, guestCount: roomIds.length } : {}),
        saunaOptionsText: formatSaunaOptions(pricing?.saunaOptions) || undefined,
      };
      sendConfirmationEmail(mailData).catch(() => {});
      sendStaffNotification(mailData, 'new').catch(() => {});
      auditLog('reservation.create', { reservationId: result, planId, roomIds, startDate, customerName: customer.name, type: isCamp ? 'camp' : 'normal' }, req);
      const normalResp = { reservationId: result, status: 'confirmed', ...(isCamp ? { isCamp: true, sites: roomIds.length } : {}) };
      saveIdempotencyKey(req, normalResp).catch(() => {});

      res.status(201).json(normalResp);
    } catch (e: any) {
      if (e?.code === 'slot_conflict') {
        res.status(409).json({ error: 'slot_conflict', conflicts: e.conflicts });
        return;
      }
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * GET /reservations?date=2026-04-12&status=confirmed
 * スタッフ用予約一覧
 */
export const listReservations = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'listReservations')) return;
    if (!(await requireStaffAuth(req, res))) return;

    try {
      const date = req.query.date as string;
      const status = req.query.status as string;
      const from = req.query.from as string;
      const to = req.query.to as string;

      let query: FirebaseFirestore.Query = db.collection('reservations');
      if (status) query = query.where('status', '==', status);
      if (date) {
        query = query.where('startDate', '<=', date).where('endDate', '>=', date);
      } else {
        if (from) query = query.where('startDate', '>=', from);
        if (to) query = query.where('startDate', '<=', to);
      }

      const snap = await query.get();
      const reservations = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      res.status(200).json({ count: reservations.length, reservations });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * PATCH /reservations/:id
 * ステータス更新・メモ追加
 */
export const updateReservation = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'updateReservation')) return;
    if (!(await requireStaffAuth(req, res))) return;
    if (!checkOrigin(req, res)) return;
    if (req.method !== 'PATCH' && req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    try {
      const id = (req.query.id as string) || (req.body?.id as string);
      if (!id) {
        res.status(400).json({ error: 'id_required' });
        return;
      }

      const updates: any = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const allowedFields = ['status', 'note', 'customer', 'payment'];
      allowedFields.forEach(f => {
        if (req.body?.[f] !== undefined) updates[f] = req.body[f];
      });

      await db.collection('reservations').doc(id).update(updates);
      auditLog('reservation.update', { reservationId: id, fields: Object.keys(updates) }, req);
      res.status(200).json({ id, updated: Object.keys(updates) });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * POST /changeCampSites
 * キャンプ予約の利用区画を変更（例: ①② → ④⑤）
 * - 旧slots削除 + 新slots作成 + 予約更新を1トランザクションでatomic実行
 * - 同期間の他予約と重複する区画は409返却（強制上書き不可・社長指示2026-04-28）
 * - 監査ログを reservations/{id}/audit_log サブコレクションに記録
 *
 * Body: { id: string, newCampSites: string[] (例: ['camp_3','camp_5']) }
 */
export const changeCampSites = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'updateReservation')) return;
    if (!(await requireStaffAuth(req, res))) return;
    if (!checkOrigin(req, res)) return;
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const id = (req.body?.id || '').toString();
    const newCampSites: string[] = Array.isArray(req.body?.newCampSites) ? req.body.newCampSites : [];
    if (!id) { res.status(400).json({ error: 'id_required' }); return; }
    if (newCampSites.length === 0 || newCampSites.length > 8) {
      res.status(400).json({ error: 'invalid_camp_sites_count', detail: '1〜8区画' });
      return;
    }
    // 形式チェック：camp_1 〜 camp_8 のみ
    const validCamp = /^camp_[1-8]$/;
    if (!newCampSites.every(c => validCamp.test(c))) {
      res.status(400).json({ error: 'invalid_camp_site_id' });
      return;
    }
    // 重複なし
    if (new Set(newCampSites).size !== newCampSites.length) {
      res.status(400).json({ error: 'duplicate_camp_sites' });
      return;
    }

    try {
      const result = await db.runTransaction(async tx => {
        // 1. 既存予約取得
        const resRef = db.collection('reservations').doc(id);
        const resDoc = await tx.get(resRef);
        if (!resDoc.exists) throw { code: 'not_found' };
        const data = resDoc.data() as any;
        if (data.status !== 'confirmed') throw { code: 'invalid_status', detail: data.status };
        if (!data.isCamp) throw { code: 'not_camp_reservation' };
        const oldRoomIds: string[] = Array.isArray(data.roomIds) ? data.roomIds : [];
        const oldSlots: string[] = Array.isArray(data.slots) ? data.slots : [];
        if (oldSlots.length === 0) throw { code: 'no_slots' };

        // 2. 旧slots から date×hour ペアを抽出
        const dateHourPairs: { date: string; hour: string }[] = [];
        const dhSet = new Set<string>();
        for (const k of oldSlots) {
          const parts = k.split('|');
          if (parts.length !== 3) continue;
          const dh = `${parts[1]}|${parts[2]}`;
          if (!dhSet.has(dh)) {
            dhSet.add(dh);
            dateHourPairs.push({ date: parts[1], hour: parts[2] });
          }
        }

        // 3. 新slots生成
        const newSlots: string[] = [];
        for (const cid of newCampSites) {
          for (const { date, hour } of dateHourPairs) {
            newSlots.push(`${cid}|${date}|${hour}`);
          }
        }

        // 4. 新slot keyの空き状況チェック（自分の旧slotsはskip）
        const oldSlotSet = new Set(oldSlots);
        const slotsToWrite = newSlots.filter(k => !oldSlotSet.has(k));
        const newRefs = slotsToWrite.map(k => db.collection('slots').doc(k));
        const newDocs = await Promise.all(newRefs.map(r => tx.get(r)));
        const conflicts: string[] = [];
        newDocs.forEach((d, i) => {
          if (d.exists && (d.data() as any).reservationId !== id) {
            conflicts.push(slotsToWrite[i]);
          }
        });
        if (conflicts.length > 0) {
          throw { code: 'slot_conflict', conflicts };
        }

        // 5. 旧slots削除（新slotsに含まれないもの）
        const newSlotSet = new Set(newSlots);
        const slotsToDelete = oldSlots.filter(k => !newSlotSet.has(k));
        const now = admin.firestore.FieldValue.serverTimestamp();
        slotsToDelete.forEach(k => {
          tx.delete(db.collection('slots').doc(k));
        });

        // 6. 新slots書込（既存自分のslotsはskip）
        slotsToWrite.forEach((k, i) => {
          const [roomId, date, hourStr] = k.split('|');
          tx.set(newRefs[i], {
            slotKey: k,
            roomId,
            date,
            hour: parseInt(hourStr, 10),
            reservationId: id,
            createdAt: now,
          });
        });

        // 7. 予約レコード更新
        tx.update(resRef, {
          roomIds: newCampSites,
          slots: newSlots,
          guestCount: newCampSites.length,
          updatedAt: now,
        });

        // 8. 監査ログ追加
        const logRef = resRef.collection('audit_log').doc();
        tx.set(logRef, {
          at: now,
          actor: ((req as any).auth?.email) || 'unknown',
          action: 'change_camp_sites',
          before: { roomIds: oldRoomIds, sitesCount: oldRoomIds.length },
          after: { roomIds: newCampSites, sitesCount: newCampSites.length },
        });

        return { newRoomIds: newCampSites, newSlots };
      });

      auditLog('reservation.change_camp_sites', { reservationId: id, newCampSites }, req);
      res.status(200).json({ id, ...result });
    } catch (e: any) {
      if (e?.code === 'not_found') { res.status(404).json({ error: 'not_found' }); return; }
      if (e?.code === 'invalid_status') { res.status(400).json({ error: 'invalid_status', detail: e.detail }); return; }
      if (e?.code === 'not_camp_reservation') { res.status(400).json({ error: 'not_camp_reservation' }); return; }
      if (e?.code === 'no_slots') { res.status(400).json({ error: 'no_slots' }); return; }
      if (e?.code === 'slot_conflict') { res.status(409).json({ error: 'slot_conflict', conflicts: e.conflicts }); return; }
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * GET /listAuditLog?id={reservationId}
 * 予約変更履歴を返す（スタッフ向け・最新50件）
 */
export const listAuditLog = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'listReservations')) return;
    if (!(await requireStaffAuth(req, res))) return;
    if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

    const id = (req.query.id as string) || '';
    if (!id) { res.status(400).json({ error: 'id_required' }); return; }

    try {
      const snap = await db.collection('reservations').doc(id).collection('audit_log')
        .orderBy('at', 'desc').limit(50).get();
      const logs = snap.docs.map(d => {
        const x = d.data() as any;
        return {
          id: d.id,
          at: x.at && x.at.toDate ? x.at.toDate().toISOString() : null,
          actor: x.actor || '',
          action: x.action || '',
          before: x.before || null,
          after: x.after || null,
        };
      });
      res.status(200).json({ logs });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * DELETE /reservations/:id
 * 予約キャンセル（statusを更新＋slotsを物理削除）
 */
export const cancelReservation = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'cancelReservation')) return;
    if (!(await requireStaffAuth(req, res))) return;
    if (!checkOrigin(req, res)) return;
    if (req.method !== 'DELETE' && req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    try {
      const id = (req.query.id as string) || (req.body?.id as string);
      if (!id) {
        res.status(400).json({ error: 'id_required' });
        return;
      }

      let cancelledData: any = null;

      await db.runTransaction(async tx => {
        const resRef = db.collection('reservations').doc(id);
        const resDoc = await tx.get(resRef);
        if (!resDoc.exists) throw { code: 'not_found' };

        const data = resDoc.data() as any;
        cancelledData = data; // メール送信用に保持
        const slotKeys: string[] = data.slots || [];
        const isCampRes = !!data.isCamp;
        const isTennisRes = !!data.isTennis;
        const seats = data.guestCount || 1;

        // 旧キャンプ予約（2026-04-27以前・shared_slots方式）の互換維持
        // 新方式（2026-04-28〜）はキー先頭が camp_N なので個別 slots collection を使う
        const isLegacySharedCamp = isCampRes && slotKeys.length > 0 && slotKeys[0].startsWith('camp|');
        if (isLegacySharedCamp) {
          const sharedRefs = slotKeys.map(k => db.collection('shared_slots').doc(k));
          const sharedDocs = await Promise.all(sharedRefs.map(r => tx.get(r)));

          tx.update(resRef, {
            status: 'cancelled',
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          sharedDocs.forEach((d, i) => {
            if (!d.exists) return;
            const cur = d.data() as any;
            const newUsed = Math.max(0, (cur.used || 0) - seats);
            if (newUsed === 0) {
              tx.delete(sharedRefs[i]);
            } else {
              tx.update(sharedRefs[i], {
                used: newUsed,
                reservationIds: admin.firestore.FieldValue.arrayRemove(id),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          return;
        }

        // 通常: slots を物理削除（テニスは tennis_slots／新方式キャンプも slots）
        const collection = isTennisRes ? 'tennis_slots' : 'slots';
        tx.update(resRef, {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        slotKeys.forEach(key => {
          tx.delete(db.collection(collection).doc(key));
        });
      });

      // キャンセルメール送信
      if (cancelledData?.customer) {
        const mailData: MailData = {
          planName: cancelledData.planId || '', roomName: (cancelledData.roomIds || []).join(', '),
          startDate: cancelledData.startDate || '', endDate: cancelledData.endDate || '',
          customerName: cancelledData.customer.name || '', customerPhone: cancelledData.customer.phone || '',
          customerEmail: cancelledData.customer.email || '',
          customerAddress: formatCustomerAddress(cancelledData.customer),
          note: cancelledData.note || '',
          reservationId: id,
        };
        sendCancellationEmail(mailData).catch(() => {});
        sendStaffNotification(mailData, 'cancel').catch(() => {});
      }

      auditLog('reservation.cancel', { reservationId: id, customerName: cancelledData?.customer?.name || '' }, req);
      res.status(200).json({ id, status: 'cancelled' });
    } catch (e: any) {
      if (e?.code === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * GET /futamiDays
 * ふたみの日リストを返す（フロント・スタッフ画面用、公開）
 */
export const futamiDays = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'futamiDays')) return;
    try {
      if (req.method === 'POST' || req.method === 'PATCH') {
        // 更新（要APIキー）
        if (!(await requireStaffAuth(req, res))) return;
        if (!checkOrigin(req, res)) return;
        const dates: string[] = req.body?.dates || [];
        if (!Array.isArray(dates)) {
          res.status(400).json({ error: 'dates must be array' });
          return;
        }
        await db.doc('config/special_days').set(
          { sauna_capacity_days: dates, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        _futamiDaysCache = null; // キャッシュクリア
        res.status(200).json({ ok: true, count: dates.length });
        return;
      }
      // GET
      const set = await getFutamiDays();
      res.status(200).json({ dates: Array.from(set).sort() });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * GET/POST /businessCalendar
 * 営業カレンダー設定の取得・更新
 */
let _calendarCache: { data: any; expiresAt: number } | null = null;
const CALENDAR_CACHE_TTL_MS = 60 * 1000;

export const businessCalendar = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'default')) return;
    try {
      if (req.method === 'POST' || req.method === 'PATCH') {
        if (!(await requireStaffAuth(req, res))) return;
        if (!checkOrigin(req, res)) return;
        const { defaultClosedDays, forceOpen, forceClosed } = req.body || {};
        // バリデーション
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        const validateDates = (arr: any[]) => Array.isArray(arr) && arr.length <= 365 && arr.every((d: any) => typeof d === 'string' && dateRe.test(d));
        if (Array.isArray(defaultClosedDays) && !defaultClosedDays.every((d: any) => typeof d === 'number' && d >= 0 && d <= 6)) {
          res.status(400).json({ error: 'invalid_defaultClosedDays' }); return;
        }
        if (Array.isArray(forceOpen) && !validateDates(forceOpen)) {
          res.status(400).json({ error: 'invalid_forceOpen' }); return;
        }
        if (Array.isArray(forceClosed) && !validateDates(forceClosed)) {
          res.status(400).json({ error: 'invalid_forceClosed' }); return;
        }
        const updates: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (Array.isArray(defaultClosedDays)) updates.defaultClosedDays = defaultClosedDays;
        if (Array.isArray(forceOpen)) updates.forceOpen = forceOpen;
        if (Array.isArray(forceClosed)) updates.forceClosed = forceClosed;
        await db.doc('config/business_calendar').set(updates, { merge: true });
        _calendarCache = null;
        auditLog('calendar.update', updates, req);
        res.status(200).json({ ok: true });
        return;
      }
      // GET（公開・キャッシュ付き）
      const now = Date.now();
      if (_calendarCache && _calendarCache.expiresAt > now) {
        res.status(200).json(_calendarCache.data);
        return;
      }
      const doc = await db.doc('config/business_calendar').get();
      const data = doc.exists ? doc.data() : { defaultClosedDays: [2], forceOpen: [], forceClosed: [] };
      _calendarCache = { data, expiresAt: now + CALENDAR_CACHE_TTL_MS };
      res.status(200).json(data);
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/**
 * ヘルスチェック
 */
export const health = onRequest(
  { region: 'asia-northeast1' },
  async (req, res) => {
    if (setCors(req, res)) return;
    res.status(200).json({ ok: true, time: new Date().toISOString() });
  }
);

/**
 * ===== スタッフ画面 Uptime 監視（スケジュール実行）=====
 *
 * 目的:
 *  - staff.html が 401/500 等を silent に握りつぶす設計なので、
 *    外部から毎日定期的に「スタッフ画面で予約一覧が取れるか」を検証
 *  - 失敗が一定回数を超えたらスタッフ宛に SMTP で警告メールを送る
 *
 * 検証項目（Admin SDK レベル）:
 *  1. Firestore 接続（config/business_calendar を読む）
 *  2. 予約コレクション（reservations）への list クエリが通る
 *  3. tennis_slots コレクションが読める
 *  4. Firebase Auth から staff claim 付きユーザーが 1 人以上存在する
 *
 * 頻度: 毎日 08:30 JST (営業開始時刻)
 * 通知先: STAFF_EMAIL + hid0707no@gmail.com
 */
const MONITOR_NOTIFY_EMAILS = [
  STAFF_EMAIL,
  'hid0707no@gmail.com',
];

async function sendMonitorAlert(subject: string, body: string): Promise<void> {
  if (!transporter) {
    console.error('[monitor] transporter 未設定のためメール通知スキップ');
    return;
  }
  try {
    await transporter.sendMail({
      from: STAFF_EMAIL,
      to: MONITOR_NOTIFY_EMAILS.join(','),
      subject,
      text: body,
    });
    console.log('[monitor] alert email sent');
  } catch (e) {
    console.error('[monitor] alert email failed:', e);
  }
}

export const staffHealthMonitor = onSchedule(
  {
    schedule: '30 8 * * *', // 毎朝 08:30
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
  },
  async () => {
    const failures: string[] = [];
    const checks: Record<string, boolean> = {};

    // --- Check 1: Firestore 接続 ---
    try {
      const doc = await db.doc('config/business_calendar').get();
      checks.firestore_business_calendar = doc.exists;
      if (!doc.exists) failures.push('config/business_calendar が存在しません');
    } catch (e: any) {
      checks.firestore_business_calendar = false;
      failures.push(`Firestore business_calendar read エラー: ${e.message || e}`);
    }

    // --- Check 2: reservations コレクション ---
    try {
      const snap = await db.collection('reservations').limit(1).get();
      checks.firestore_reservations = true;
      console.log(`[monitor] reservations サンプル: ${snap.size}件`);
    } catch (e: any) {
      checks.firestore_reservations = false;
      failures.push(`reservations クエリエラー: ${e.message || e}`);
    }

    // --- Check 3: tennis_slots コレクション ---
    try {
      const snap = await db.collection('tennis_slots').limit(1).get();
      checks.firestore_tennis_slots = true;
      console.log(`[monitor] tennis_slots サンプル: ${snap.size}件`);
    } catch (e: any) {
      checks.firestore_tennis_slots = false;
      failures.push(`tennis_slots クエリエラー: ${e.message || e}`);
    }

    // --- Check 4: Firebase Auth に staff claim ユーザーが 1人以上いる ---
    try {
      const list = await admin.auth().listUsers(1000);
      const staffUsers = list.users.filter(u => (u.customClaims as any)?.staff === true);
      checks.firebase_auth_staff_count = staffUsers.length > 0;
      console.log(`[monitor] staff users: ${staffUsers.length}名`);
      if (staffUsers.length === 0) {
        failures.push('Firebase Auth に staff:true claim 付きユーザーが 1 人もいません');
      }
    } catch (e: any) {
      checks.firebase_auth_staff_count = false;
      failures.push(`Firebase Auth listUsers エラー: ${e.message || e}`);
    }

    // --- 判定 + 通知 ---
    console.log(JSON.stringify({
      severity: 'INFO',
      audit: true,
      action: 'monitor.staff_health',
      timestamp: new Date().toISOString(),
      checks,
      failures,
      ok: failures.length === 0,
    }));

    if (failures.length > 0) {
      const body = [
        'ふたみ予約システムのスタッフ機能ヘルスチェックで問題を検知しました。',
        '',
        `検証日時: ${new Date().toISOString()}`,
        '',
        '【失敗項目】',
        ...failures.map(f => '  - ' + f),
        '',
        '【全チェック結果】',
        JSON.stringify(checks, null, 2),
        '',
        '対応:',
        '  - https://hid0707no-a11y.github.io/futami-reservation/staff.html を開いて動作確認',
        '  - Firebase Console (https://console.firebase.google.com/project/futami-yoyaku-492607) でログ確認',
        '',
        'このメールは staffHealthMonitor Cloud Function が自動送信しています。',
      ].join('\n');
      await sendMonitorAlert('[ふたみ予約] スタッフ機能ヘルスチェック失敗', body);
    } else {
      console.log('[monitor] all checks passed');
    }
  }
);

/**
 * ===== 予約データ Google Sheets 同期（日次 03:00 JST）=====
 *
 * 役割:
 *  - Firestore reservations の全件を Google Sheets に毎朝書き出す
 *  - バックアップ兼データ基盤として使える（社長の Google Drive 経由で閲覧）
 *  - 行政報告書の原データ、KPI 集計、Looker 連携の source of truth
 *  - 書式が決まったら別シートで整形して行政報告に使えるよう、生データは常に固定書式
 *
 * 同期先:
 *  - スプシID: SHEETS_SYNC_ID 環境変数（Firebase Functions の .env で設定）
 *  - reservations タブ: confirmed 全件
 *  - cancelled タブ: cancelled 全件
 *  - meta タブ: 最終同期時刻・件数
 *
 * 認証:
 *  - Cloud Functions のデフォルト SA (Application Default Credentials) 経由
 *  - 事前にスプシを編集者として SA に共有する必要あり
 */
const SHEETS_SYNC_ID = process.env.SHEETS_SYNC_ID || '';

interface ReservationRow {
  id: string;
  createdAt: string;
  status: string;
  planId: string;
  roomIds: string;
  startDate: string;
  endDate: string;
  nights: number;
  timeStr: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerZip: string;
  customerAddress: string;
  guestsAdult: number;
  guestsElementary: number;
  guestsChild: number;
  guestsSportEstimate: number;
  pricingTotal: number;
  pricingLightingFee: number;
  weekdayDiscountHours: number;
  isResident: string;
  createdBy: string;
  saunaOptions: string;
  note: string;
}

function reservationToRow(id: string, data: any): ReservationRow {
  const pricing = data.pricing || {};
  const tennis = pricing.tennis || {};
  const midori = pricing.midori || {};
  const slots: string[] = Array.isArray(data.slots) ? data.slots : [];
  // 時間範囲を HHMM 文字列から読み取って概要を作る
  const uniqHours = new Set<string>();
  for (const s of slots) {
    const parts = String(s).split('|');
    if (parts.length === 3) uniqHours.add(parts[2]);
  }
  const timeStr = Array.from(uniqHours).sort().join(',');

  const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : '';
  const customer = data.customer || {};
  const guests = data.guests || {};
  return {
    id,
    createdAt,
    status: data.status || '',
    planId: data.planId || '',
    roomIds: Array.isArray(data.roomIds) ? data.roomIds.join(',') : '',
    startDate: data.startDate || '',
    endDate: data.endDate || '',
    nights: typeof data.nights === 'number' ? data.nights : 0,
    timeStr,
    customerName: customer.name || '',
    customerPhone: customer.phone || '',
    customerEmail: customer.email || '',
    customerZip: customer.zip || '',
    customerAddress: formatCustomerAddress(customer).replace(/^〒\S+\s*/, ''),
    guestsAdult: typeof guests.adult === 'number' ? guests.adult : 0,
    guestsElementary: typeof guests.elementary === 'number' ? guests.elementary : 0,
    guestsChild: typeof guests.child === 'number' ? guests.child : 0,
    guestsSportEstimate: typeof pricing.sportGuestEstimate === 'number' ? pricing.sportGuestEstimate : 0,
    pricingTotal: typeof pricing.total === 'number' ? pricing.total : 0,
    pricingLightingFee: (tennis.lightingFee || 0) + (midori.lightingFee || 0),
    weekdayDiscountHours: typeof tennis.weekdayDiscountHours === 'number' ? tennis.weekdayDiscountHours : 0,
    isResident: customer.isMember === true ? '市民' : '市外',
    createdBy: data.createdBy || '',
    note: (data.note || '').toString().slice(0, 500),
    saunaOptions: formatSaunaOptions(pricing.saunaOptions),
  };
}

function formatSaunaOptions(opts: any): string {
  if (!opts) return '';
  const parts: string[] = [];
  if (opts.towels > 0) parts.push(`タオル×${opts.towels}`);
  if (opts.tarpTent > 0) parts.push('タープテント');
  if (opts.ice20kg > 0) parts.push(`氷${opts.ice20kg * 20}kg`);
  return parts.join('／');
}

const SHEET_HEADERS = [
  '予約ID', '登録日時', 'ステータス', 'プランID', '部屋ID',
  '利用開始日', '利用終了日', '泊数', '時間帯',
  'お名前', '電話番号', 'メール', '郵便番号', '住所',
  '大人', '小学生', '未就学児', '利用予定人数(目安)',
  '合計金額', '照明料金', '平日割適用枠数',
  '市民区分', '予約経路', 'サウナオプション', '備考',
];

function rowToArray(r: ReservationRow): (string | number)[] {
  return [
    r.id, r.createdAt, r.status, r.planId, r.roomIds,
    r.startDate, r.endDate, r.nights, r.timeStr,
    r.customerName, r.customerPhone, r.customerEmail, r.customerZip, r.customerAddress,
    r.guestsAdult, r.guestsElementary, r.guestsChild, r.guestsSportEstimate,
    r.pricingTotal, r.pricingLightingFee, r.weekdayDiscountHours,
    r.isResident, r.createdBy, r.saunaOptions, r.note,
  ];
}

async function syncReservationsToSheets(): Promise<{ synced: number; cancelled: number }> {
  if (!SHEETS_SYNC_ID) {
    console.warn('[sync] SHEETS_SYNC_ID 未設定 — スプシ同期をスキップ');
    return { synced: 0, cancelled: 0 };
  }

  // ADC 経由で Sheets API 認証（Cloud Functions のデフォルト SA を使用）
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: (await auth.getClient()) as any });

  // Firestore から全予約を取得
  const snap = await db.collection('reservations').orderBy('createdAt', 'desc').get();
  const confirmed: ReservationRow[] = [];
  const cancelled: ReservationRow[] = [];
  snap.forEach(doc => {
    const row = reservationToRow(doc.id, doc.data());
    if (row.status === 'cancelled') cancelled.push(row);
    else confirmed.push(row);
  });

  // reservations タブを上書き
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'reservations',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'reservations!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [SHEET_HEADERS, ...confirmed.map(rowToArray)],
    },
  });

  // cancelled タブを上書き
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'cancelled',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'cancelled!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [SHEET_HEADERS, ...cancelled.map(rowToArray)],
    },
  });

  // meta タブ更新
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'meta',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_SYNC_ID,
    range: 'meta!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        ['項目', '値'],
        ['最終同期時刻', new Date().toISOString()],
        ['同期ソース', 'Firestore reservations'],
        ['確定予約件数', String(confirmed.length)],
        ['キャンセル件数', String(cancelled.length)],
        ['同期関数', 'dailySyncToSheets'],
      ],
    },
  });

  console.log(`[sync] sheets sync OK confirmed=${confirmed.length} cancelled=${cancelled.length}`);
  return { synced: confirmed.length, cancelled: cancelled.length };
}

// スケジュール実行（毎日 03:00 JST）
export const dailySyncToSheets = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
    memory: '512MiB',
  },
  async () => {
    try {
      const result = await syncReservationsToSheets();
      console.log(JSON.stringify({
        severity: 'INFO',
        audit: true,
        action: 'sync.sheets.daily',
        timestamp: new Date().toISOString(),
        ...result,
      }));
    } catch (e: any) {
      console.error('[sync] failed:', e.message || e);
      await sendMonitorAlert(
        '[ふたみ予約] 日次スプシ同期エラー',
        [
          'dailySyncToSheets が失敗しました。',
          '',
          `エラー: ${e.message || e}`,
          `時刻: ${new Date().toISOString()}`,
          '',
          '対応: Firebase Console でログを確認してください。',
        ].join('\n'),
      );
    }
  }
);

// 手動トリガー（初回動作確認用）
// curl -H "Authorization: Bearer <idToken>" https://asia-northeast1-futami-yoyaku-492607.cloudfunctions.net/triggerSyncToSheets
export const triggerSyncToSheets = onRequest(
  { region: 'asia-northeast1' },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!(await requireStaffAuth(req, res))) return;
    try {
      const result = await syncReservationsToSheets();
      res.status(200).json({ ok: true, ...result });
    } catch (e: any) {
      console.error('[sync] manual trigger failed:', e);
      res.status(500).json({ error: 'sync_failed', detail: e.message || String(e) });
    }
  }
);
