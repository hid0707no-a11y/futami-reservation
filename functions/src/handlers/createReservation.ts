// 予約作成ハンドラ（最も大規模・トランザクション3パターン分岐）
//
// 2026-05-05 新設（/gfu Phase B-1 完全分割）。
// 旧 index.ts:95-400 を集約。
//
// 3つの予約パターン：
//   1. テニス（court_*）: tennis_slots collection（30分単位）
//   2. ふたみの日サウナ（plan_sauna_futami / sauna_share）: 通常 slots + 排他制御 + ふたみの日チェック
//   3. キャンプ（camp_*）/ 通常宿泊: 通常 slots + キャンプは3区画3泊まで上限

import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestore';
import { setCors, checkOrigin } from '../lib/cors';
import { checkRateLimit } from '../lib/rateLimit';
import { audit as auditLog, logMailFailure, logIdempotencyFailure } from '../lib/logger';
import { formatCustomerAddress, formatSaunaOptions, generateDisplayId } from '../lib/format';
import { detectDisplayIdCollision } from '../lib/displayId';
import { MailData, sendConfirmationEmail, sendStaffNotification } from '../lib/mail';
import { validateReservationBody } from '../lib/validation';
import { VALID_ROOM_IDS } from '../constants';
import { getFutamiDays } from '../lib/futamiDays';
import { checkIdempotency as checkIdempotencyFs, saveIdempotencyKey as saveIdempotencyKeyFs } from '../lib/idempotency';

/**
 * roomIds が完全にテニスコート（court_*）のみで構成されているか判定する純粋関数。
 *
 * 2026-05-13 export 化（jest 単体テスト対象）。
 * 旧コード `roomIds[0].startsWith('court_')` だと `['court_1','camp_1']` のような
 * 混在ペイロードで tennis_slots に書込み・キャンプ排他スキップが起きる脆弱性があった。
 * `.every` で全件チェックすることで isCamp との対称性も担保（isCamp も全件 camp_* 判定）。
 *
 * テスト対象 → functions/tests/createReservation.test.ts
 */
export function isTennisPayload(roomIds: unknown): boolean {
  return Array.isArray(roomIds)
    && roomIds.length > 0
    && roomIds.every((r: unknown) => typeof r === 'string' && r.startsWith('court_'));
}

// 薄いラッパ：db を束ねる（互換維持）
function validateAndRespond(body: any, res: any): boolean {
  const result = validateReservationBody(body, { validRoomIds: VALID_ROOM_IDS });
  if (!result.ok) {
    const payload: any = { error: result.error };
    if (result.detail) payload.detail = result.detail;
    res.status(400).json(payload);
    return false;
  }
  return true;
}

const checkIdempotency = (req: any, res: any) => checkIdempotencyFs(db, req, res);
const saveIdempotencyKey = (req: any, response: any) => saveIdempotencyKeyFs(db, req, response);

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
        planId, roomIds, slots,
        startDate, endDate,
        nights = 0,
        customer, guests, pricing,
        createdBy = 'web',
        note,
        guestCount, // ふたみの日用：占有人数（1〜8）
      } = body;

      if (!checkOrigin(req, res)) return;
      if (!validateAndRespond(body, res)) return;
      if (!(await checkIdempotency(req, res))) return;

      // ===== テニス専用ルート（tennis_slots 30分単位）=====
      const isTennis = isTennisPayload(roomIds);
      if (isTennis) {
        try {
          const tennisResult = await db.runTransaction(async tx => {
            const slotRefs = slots.map((key: string) => db.collection('tennis_slots').doc(key));
            const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));
            const conflicts = slotDocs
              .map((d: any, i: number) => (d.exists ? slots[i] : null))
              .filter((x: any) => x !== null);
            if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };
            const resRef = db.collection('reservations').doc();
            const displayId = generateDisplayId(resRef.id);
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId, roomIds, slots, startDate, endDate, nights: 0,
              customer, guests: guests || null, pricing: pricing || null,
              payment: { method: 'onsite', status: 'unpaid' },
              status: 'confirmed', note: note || null,
              displayId,
              createdAt: now, createdBy, updatedAt: now, isTennis: true,
            });
            slots.forEach((key: string, i: number) => {
              const parts = key.split('|');
              tx.set(slotRefs[i], {
                slotKey: key,
                roomId: parts[0], date: parts[1], time: parts[2],
                reservationId: resRef.id, createdAt: now,
              });
            });
            return { id: resRef.id, displayId };
          });
          const mailData: MailData = {
            planName: planId, roomName: roomIds.join(', '), startDate, endDate,
            customerName: customer.name, customerPhone: customer.phone,
            customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
            note: note || '', reservationId: tennisResult.displayId, isTennis: true,
          };
          sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: tennisResult.id, type: 'tennis' }, req));
          sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: tennisResult.id, type: 'tennis', kind: 'new' }, req));
          // 2026-05-13: displayId 衝突検知（ランタイム警告のみ・本予約は内部IDで一意確保）
          detectDisplayIdCollision(db, tennisResult.displayId, tennisResult.id).then(c => {
            if (c.collided) {
              console.warn(JSON.stringify({
                severity: 'WARNING', audit: true, action: 'displayId.collision',
                displayId: tennisResult.displayId, newId: tennisResult.id, existingIds: c.existingIds,
                type: 'tennis',
              }));
            }
          }).catch(() => { /* 衝突検知失敗は本予約に影響させない */ });
          auditLog('reservation.create', { reservationId: tennisResult.id, displayId: tennisResult.displayId, planId, roomIds, startDate, customerName: customer.name, type: 'tennis' }, req);
          const tennisResp = { reservationId: tennisResult.displayId, internalId: tennisResult.id, status: 'confirmed', isTennis: true };
          saveIdempotencyKey(req, tennisResp).catch(logIdempotencyFailure(tennisResult.id, req));
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

      // ===== ふたみの日サウナ専用ルート =====
      const isFutamiSauna = planId === 'plan_sauna_futami' || (roomIds[0] === 'sauna_share');
      if (isFutamiSauna) {
        const seats = Number(guestCount || guests?.adult || 2);
        if (seats < 2 || seats > 8) {
          res.status(400).json({ error: 'invalid_guest_count', detail: '2〜8人' });
          return;
        }
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
            const slotRefs = slots.map((key: string) => db.collection('slots').doc(key));
            const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));
            const conflicts = slotDocs
              .map((d: any, i: number) => (d.exists ? slots[i] : null))
              .filter((x: any) => x !== null);
            if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };

            const resRef = db.collection('reservations').doc();
            const displayId = generateDisplayId(resRef.id);
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId, roomIds: ['sauna_share'], slots, startDate, endDate, nights: 0,
              customer, guests: guests || null, guestCount: seats,
              pricing: pricing || null,
              payment: { method: 'onsite', status: 'unpaid' },
              status: 'confirmed', note: note || null,
              displayId,
              createdAt: now, createdBy, updatedAt: now, isFutamiDay: true,
            });
            slots.forEach((key: string, i: number) => {
              const [, date, hourStr] = key.split('|');
              tx.set(slotRefs[i], {
                slotKey: key, roomId: 'sauna_share',
                date, hour: parseInt(hourStr, 10),
                reservationId: resRef.id, createdAt: now,
              });
            });
            return { id: resRef.id, displayId };
          });
          const mailData: MailData = {
            planName: planId, roomName: 'サンセットサウナ（ふたみの日）', startDate, endDate,
            customerName: customer.name, customerPhone: customer.phone,
            customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
            note: note || '', reservationId: result.displayId, guestCount: seats, isFutamiDay: true,
            saunaOptionsText: formatSaunaOptions(pricing?.saunaOptions) || undefined,
          };
          sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: result.id, type: 'futami_sauna', seats }, req));
          sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: result.id, type: 'futami_sauna', kind: 'new' }, req));
          detectDisplayIdCollision(db, result.displayId, result.id).then(c => {
            if (c.collided) {
              console.warn(JSON.stringify({
                severity: 'WARNING', audit: true, action: 'displayId.collision',
                displayId: result.displayId, newId: result.id, existingIds: c.existingIds,
                type: 'futami_sauna',
              }));
            }
          }).catch(() => { /* noop */ });
          auditLog('reservation.create', { reservationId: result.id, displayId: result.displayId, planId, roomIds, startDate, customerName: customer.name, type: 'futami_sauna', seats }, req);
          const futamiResp = { reservationId: result.displayId, internalId: result.id, status: 'confirmed', isFutamiDay: true, seats };
          saveIdempotencyKey(req, futamiResp).catch(logIdempotencyFailure(result.id, req));
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

      // ===== キャンプ場（2026-04-28〜 8区画個別管理）=====
      const isCamp = roomIds.every((r: string) => r.startsWith('camp_'));
      const CAMP_MAX_SITES = 3;
      const CAMP_MAX_NIGHTS = 3;
      if (isCamp) {
        if (roomIds.length > CAMP_MAX_SITES) {
          res.status(400).json({ error: 'too_many_camp_sites', detail: `${CAMP_MAX_SITES}区画まで` });
          return;
        }
        if (typeof nights === 'number' && nights > CAMP_MAX_NIGHTS) {
          res.status(400).json({ error: 'too_many_nights', detail: `${CAMP_MAX_NIGHTS}泊まで` });
          return;
        }
      }

      // ===== 通常プラン（slots collection）=====
      const result = await db.runTransaction(async tx => {
        const slotRefs = slots.map((key: string) => db.collection('slots').doc(key));
        const slotDocs = await Promise.all(slotRefs.map((ref: any) => tx.get(ref)));
        const conflicts = slotDocs
          .map((d: any, i: number) => (d.exists ? slots[i] : null))
          .filter((x: any) => x !== null);
        if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };

        const resRef = db.collection('reservations').doc();
        const displayId = generateDisplayId(resRef.id);
        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(resRef, {
          planId, roomIds, slots, startDate, endDate, nights,
          customer, guests: guests || null,
          ...(isCamp ? { guestCount: roomIds.length, isCamp: true } : {}),
          pricing: pricing || null,
          payment: { method: 'onsite', status: 'unpaid' },
          status: 'confirmed', note: note || null,
          displayId,
          createdAt: now, createdBy, updatedAt: now,
        });
        slots.forEach((key: string, i: number) => {
          const [roomId, date, hourStr] = key.split('|');
          tx.set(slotRefs[i], {
            slotKey: key, roomId, date,
            hour: parseInt(hourStr, 10),
            reservationId: resRef.id, createdAt: now,
          });
        });
        return { id: resRef.id, displayId };
      });

      const roomNameForMail = isCamp
        ? roomIds.map((r: string) => '区画' + ['①','②','③','④','⑤','⑥','⑦','⑧'][parseInt(r.split('_')[1], 10) - 1]).join('・')
        : roomIds.join(', ');
      const mailData: MailData = {
        planName: planId, roomName: roomNameForMail, startDate, endDate,
        customerName: customer.name, customerPhone: customer.phone,
        customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
        note: note || '', reservationId: result.displayId,
        ...(isCamp ? { isCamp: true, guestCount: roomIds.length } : {}),
        saunaOptionsText: formatSaunaOptions(pricing?.saunaOptions) || undefined,
      };
      sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: result.id, type: isCamp ? 'camp' : 'normal' }, req));
      sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: result.id, type: isCamp ? 'camp' : 'normal', kind: 'new' }, req));
      detectDisplayIdCollision(db, result.displayId, result.id).then(c => {
        if (c.collided) {
          console.warn(JSON.stringify({
            severity: 'WARNING', audit: true, action: 'displayId.collision',
            displayId: result.displayId, newId: result.id, existingIds: c.existingIds,
            type: isCamp ? 'camp' : 'normal',
          }));
        }
      }).catch(() => { /* noop */ });
      auditLog('reservation.create', { reservationId: result.id, displayId: result.displayId, planId, roomIds, startDate, customerName: customer.name, type: isCamp ? 'camp' : 'normal' }, req);
      const normalResp = { reservationId: result.displayId, internalId: result.id, status: 'confirmed', ...(isCamp ? { isCamp: true, sites: roomIds.length } : {}) };
      saveIdempotencyKey(req, normalResp).catch(logIdempotencyFailure(result.id, req));

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
