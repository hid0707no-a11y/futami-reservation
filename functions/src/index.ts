import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';

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
  note: string;
  reservationId: string;
  guestCount?: number;
  isCamp?: boolean;
  isFutamiDay?: boolean;
  isTennis?: boolean;
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
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.guestCount ? '\n' + (data.isCamp ? '区画数' : '人数') + '：' + data.guestCount + (data.isCamp ? '区画' : '名') : ''}${data.note ? '\n備考：' + data.note : ''}
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
プラン：${data.planName}
施設：${data.roomName}
日程：${data.startDate}${data.startDate !== data.endDate ? ' ～ ' + data.endDate : ''}${data.guestCount ? '\n' + (data.isCamp ? '区画数' : '人数') + '：' + data.guestCount + (data.isCamp ? '区画' : '名') : ''}${data.note ? '\n備考：' + data.note : ''}
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
      res.status(403).json({ error: 'forbidden_not_staff' });
      return false;
    } catch (e) {
      // トークン無効 → 下の 401 に落とす
    }
  }

  auditLog('auth.failed', { method: req.method, path: req.path }, req);
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
const VALID_ROOM_IDS = new Set([
  'room_27','room_6_1','room_6_2','room_6_3','room_6_4',
  'room_exp','room_train','room_kitchen',
  'court_1','court_2','court_3','court_4','court_5',
  'midori','sauna','sauna_share','camp','lodge_a','lodge_b',
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
const SHARED_SLOT_CAPACITY = 8; // ふたみの日サウナ・キャンプ共通
const CAMP_CAPACITY = 8;
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
            customerEmail: customer.email || '', note: note || '',
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
            customerEmail: customer.email || '', note: note || '',
            reservationId: result, guestCount: seats, isFutamiDay: true,
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

      // ===== キャンプ場（shared_slots使用・容量8区画）=====
      const isCamp = roomIds[0] === 'camp';
      if (isCamp) {
        const sites = Number(guestCount || 1);
        if (sites < 1 || sites > CAMP_CAPACITY) {
          res.status(400).json({ error: 'invalid_guest_count', detail: `1〜${CAMP_CAPACITY}区画` });
          return;
        }

        try {
          const result = await db.runTransaction(async tx => {
            const slotRefs = slots.map((key: string) => db.collection('shared_slots').doc(key));
            const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));

            const fullSlots: string[] = [];
            slotDocs.forEach((d: any, i: number) => {
              const data = d.exists ? d.data() : { capacity: CAMP_CAPACITY, used: 0 };
              const remaining = (data.capacity || CAMP_CAPACITY) - (data.used || 0);
              if (remaining < sites) fullSlots.push(slots[i]);
            });
            if (fullSlots.length > 0) {
              throw { code: 'capacity_exceeded', fullSlots, requested: sites };
            }

            const resRef = db.collection('reservations').doc();
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId,
              roomIds: ['camp'],
              slots,
              startDate,
              endDate,
              nights,
              customer,
              guests: guests || null,
              guestCount: sites,
              pricing: pricing || null,
              payment: { method: 'onsite', status: 'unpaid' },
              status: 'confirmed',
              note: note || null,
              createdAt: now,
              createdBy,
              updatedAt: now,
              isCamp: true,
            });

            slotDocs.forEach((d: any, i: number) => {
              const ref = slotRefs[i];
              const key = slots[i];
              const [, date, hourStr] = key.split('|');
              if (d.exists) {
                tx.update(ref, {
                  used: admin.firestore.FieldValue.increment(sites),
                  reservationIds: admin.firestore.FieldValue.arrayUnion(resRef.id),
                  updatedAt: now,
                });
              } else {
                tx.set(ref, {
                  slotKey: key,
                  roomId: 'camp',
                  date,
                  hour: parseInt(hourStr, 10),
                  capacity: CAMP_CAPACITY,
                  used: sites,
                  reservationIds: [resRef.id],
                  createdAt: now,
                  updatedAt: now,
                });
              }
            });

            return resRef.id;
          });
          const mailData: MailData = {
            planName: planId, roomName: 'キャンプ場', startDate, endDate,
            customerName: customer.name, customerPhone: customer.phone,
            customerEmail: customer.email || '', note: note || '',
            reservationId: result, guestCount: sites, isCamp: true,
          };
          sendConfirmationEmail(mailData).catch(() => {});
          sendStaffNotification(mailData, 'new').catch(() => {});
          auditLog('reservation.create', { reservationId: result, planId, roomIds, startDate, customerName: customer.name, type: 'camp', sites }, req);
          const campResp = { reservationId: result, status: 'confirmed', isCamp: true, sites };
          saveIdempotencyKey(req, campResp).catch(() => {});

          res.status(201).json(campResp);
          return;
        } catch (e: any) {
          if (e?.code === 'capacity_exceeded') {
            res.status(409).json({ error: 'capacity_exceeded', fullSlots: e.fullSlots, requested: e.requested });
            return;
          }
          throw e;
        }
      }

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

      const mailData: MailData = {
        planName: planId, roomName: roomIds.join(', '), startDate, endDate,
        customerName: customer.name, customerPhone: customer.phone,
        customerEmail: customer.email || '', note: note || '',
        reservationId: result,
      };
      sendConfirmationEmail(mailData).catch(() => {});
      sendStaffNotification(mailData, 'new').catch(() => {});
      auditLog('reservation.create', { reservationId: result, planId, roomIds, startDate, customerName: customer.name, type: 'normal' }, req);
      const normalResp = { reservationId: result, status: 'confirmed' };
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

        // キャンプ: shared_slots を取得・更新
        if (isCampRes) {
          const sharedRefs = slotKeys.map(k => db.collection('shared_slots').doc(k));
          const sharedDocs = await Promise.all(sharedRefs.map(r => tx.get(r)));

          // reservation を cancelled に
          tx.update(resRef, {
            status: 'cancelled',
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // shared_slots の used を減らす
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

        // 通常: slots を物理削除（テニスは tennis_slots）
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
          customerEmail: cancelledData.customer.email || '', note: cancelledData.note || '',
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
