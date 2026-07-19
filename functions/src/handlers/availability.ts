// 空き照会・カレンダー系ハンドラ（availability / futamiDays / businessCalendar）
//
// 2026-05-05 新設（/gfu Phase B-1 完全分割）。
// 旧 index.ts の 3 ハンドラを集約。businessCalendar の60秒キャッシュもこのファイル内に閉じる。

import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestore';
import { setCors, checkOrigin } from '../lib/cors';
import { checkRateLimit } from '../lib/rateLimit';
import { requireStaffAuth } from '../lib/auth';
import { audit as auditLog } from '../lib/logger';
import { SHARED_SLOT_CAPACITY, getFutamiDays, _clearFutamiDaysCache } from '../lib/futamiDays';
import { businessCalendarFromData } from '../lib/businessDays';

function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** GET /availability?from=&to= — 占有スロット・shared_slots・tennis_slots を返す（公開） */
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

      // shared_slots（ふたみの日サウナ）
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
      const tennisSlotSet = new Set<string>();
      tennisSnap.docs.forEach(d => {
        const id = d.id;
        const [courtId, date, time] = id.split('|');
        // staff旧形式（整数時）は公開画面が使う30分HHMMキーへ展開して返す。
        // 新規書込みはcreateReservation側でHHMMへcanonicalizeする。
        if (courtId && date && /^(?:0?[8-9]|1[0-9]|2[01])$/.test(time || '')) {
          const hour = String(Number(time)).padStart(2, '0');
          tennisSlotSet.add(`${courtId}|${date}|${hour}00`);
          tennisSlotSet.add(`${courtId}|${date}|${hour}30`);
        } else if (courtId && date && /^(?:0?[8-9]|1[0-9]|2[01]):(?:00|30)$/.test(time || '')) {
          const [hour, minute] = time.split(':');
          tennisSlotSet.add(`${courtId}|${date}|${String(Number(hour)).padStart(2, '0')}${minute}`);
        } else {
          tennisSlotSet.add(id);
        }
      });
      const tennisSlots = Array.from(tennisSlotSet);

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

/** GET / POST /futamiDays — ふたみの日リストの取得 / 更新（POST はスタッフ認証必須） */
export const futamiDays = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!checkRateLimit(req, res, 'futamiDays')) return;
    try {
      if (req.method === 'POST' || req.method === 'PATCH') {
        if (!(await requireStaffAuth(req, res))) return;
        if (!checkOrigin(req, res)) return;
        const dates: string[] = req.body?.dates || [];
        // #10 businessCalendar と同基準で全要素を検証（型・YYYY-MM-DD・365件上限）
        if (!Array.isArray(dates) || dates.length > 365
            || !dates.every(isRealIsoDate)) {
          res.status(400).json({ error: 'invalid_dates' });
          return;
        }
        // #13 config 書込みもトランザクションで包む（★3 文言準拠・bare .set() を残さない）
        await db.runTransaction(async tx => {
          tx.set(
            db.doc('config/special_days'),
            { sauna_capacity_days: dates, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        });
        _clearFutamiDaysCache();
        res.status(200).json({ ok: true, count: dates.length });
        return;
      }
      const set = await getFutamiDays();
      res.status(200).json({ dates: Array.from(set).sort() });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

/** GET / POST /businessCalendar — 営業カレンダー（GET公開・60秒キャッシュ／POSTはスタッフ認証必須） */
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
        const validateDates = (arr: any[]) => Array.isArray(arr) && arr.length <= 365 && arr.every(isRealIsoDate);
        if (Array.isArray(defaultClosedDays)
            && !defaultClosedDays.every((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)) {
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
        // #13 config 書込みもトランザクションで包む（★3 文言準拠）
        await db.runTransaction(async tx => {
          tx.set(db.doc('config/business_calendar'), updates, { merge: true });
        });
        _calendarCache = null;
        auditLog('calendar.update', updates, req);
        res.status(200).json({ ok: true });
        return;
      }
      // GET（公開・60秒キャッシュ）
      const now = Date.now();
      if (_calendarCache && _calendarCache.expiresAt > now) {
        res.status(200).json(_calendarCache.data);
        return;
      }
      const doc = await db.doc('config/business_calendar').get();
      // GETも保存データをそのまま返さず、予約確定側と同じ正規化を通す。
      // 手動編集や過去データに壊れた値があっても、各HTMLへ不正な営業日設定を伝播させない。
      const data = businessCalendarFromData(doc.exists ? doc.data() : {});
      _calendarCache = { data, expiresAt: now + CALENDAR_CACHE_TTL_MS };
      res.status(200).json(data);
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
