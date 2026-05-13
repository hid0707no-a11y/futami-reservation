// 予約系ハンドラ（list / update / changeCampSites / cancel）
//
// 2026-05-05 新設（/gfu Phase B-1 完全分割）。
// 旧 index.ts:405-736 を集約。createReservation だけは別ファイル（handlers/createReservation.ts）。

import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestore';
import { setCors, checkOrigin } from '../lib/cors';
import { checkRateLimit } from '../lib/rateLimit';
import { requireStaffAuth } from '../lib/auth';
import { audit as auditLog, logMailFailure } from '../lib/logger';
import { formatCustomerAddress, generateDisplayId } from '../lib/format';
import { MailData, sendCancellationEmail, sendStaffNotification } from '../lib/mail';

/** GET /listReservations?date=&status=&from=&to= — スタッフ用予約一覧 */
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

/** PATCH/POST /updateReservation — ステータス・メモ・customer・payment を部分更新（スタッフ） */
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
      if (!id) { res.status(400).json({ error: 'id_required' }); return; }

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
 * POST /changeCampSites — キャンプ予約の利用区画を変更
 *  - 旧slots削除 + 新slots作成 + 予約更新を1トランザクションでatomic
 *  - 同期間の他予約と重複する区画は409返却（強制上書き不可・社長指示2026-04-28）
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
    if (newCampSites.length === 0 || newCampSites.length > 3) {
      res.status(400).json({ error: 'invalid_camp_sites_count', detail: '1〜3区画' });
      return;
    }
    const validCamp = /^camp_[1-8]$/;
    if (!newCampSites.every(c => validCamp.test(c))) {
      res.status(400).json({ error: 'invalid_camp_site_id' });
      return;
    }
    if (new Set(newCampSites).size !== newCampSites.length) {
      res.status(400).json({ error: 'duplicate_camp_sites' });
      return;
    }

    try {
      const result = await db.runTransaction(async tx => {
        const resRef = db.collection('reservations').doc(id);
        const resDoc = await tx.get(resRef);
        if (!resDoc.exists) throw { code: 'not_found' };
        const data = resDoc.data() as any;
        if (data.status !== 'confirmed') throw { code: 'invalid_status', detail: data.status };
        if (!data.isCamp) throw { code: 'not_camp_reservation' };
        const oldRoomIds: string[] = Array.isArray(data.roomIds) ? data.roomIds : [];
        const oldSlots: string[] = Array.isArray(data.slots) ? data.slots : [];
        if (oldSlots.length === 0) throw { code: 'no_slots' };

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

        const newSlots: string[] = [];
        for (const cid of newCampSites) {
          for (const { date, hour } of dateHourPairs) {
            newSlots.push(`${cid}|${date}|${hour}`);
          }
        }

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
        if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };

        const newSlotSet = new Set(newSlots);
        const slotsToDelete = oldSlots.filter(k => !newSlotSet.has(k));
        const now = admin.firestore.FieldValue.serverTimestamp();
        slotsToDelete.forEach(k => {
          tx.delete(db.collection('slots').doc(k));
        });

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

        tx.update(resRef, {
          roomIds: newCampSites,
          slots: newSlots,
          guestCount: newCampSites.length,
          updatedAt: now,
        });

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

/** DELETE/POST /cancelReservation — status='cancelled' + slot物理削除 + キャンセルメール */
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
      if (!id) { res.status(400).json({ error: 'id_required' }); return; }

      let cancelledData: any = null;

      await db.runTransaction(async tx => {
        const resRef = db.collection('reservations').doc(id);
        const resDoc = await tx.get(resRef);
        if (!resDoc.exists) throw { code: 'not_found' };

        const data = resDoc.data() as any;
        cancelledData = data;
        const slotKeys: string[] = data.slots || [];
        const isCampRes = !!data.isCamp;
        const isTennisRes = !!data.isTennis;
        const seats = data.guestCount || 1;

        // 旧キャンプ予約（2026-04-27以前・shared_slots方式）の互換維持
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

        // 通常：slots / tennis_slots を物理削除
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

      // キャンセルメール送信（失敗は構造化ログへ）
      // 2026-05-13: メール表示 ID は displayId 優先（要望#8 のキャンセル経路でも顧客に短縮ID
      // を提示するため）。backfill 前の旧予約も generateDisplayId(id) で同じ規則で fallback。
      const cancelDisplayId = cancelledData?.displayId || generateDisplayId(id);
      if (cancelledData?.customer) {
        const mailData: MailData = {
          planName: cancelledData.planId || '', roomName: (cancelledData.roomIds || []).join(', '),
          startDate: cancelledData.startDate || '', endDate: cancelledData.endDate || '',
          customerName: cancelledData.customer.name || '', customerPhone: cancelledData.customer.phone || '',
          customerEmail: cancelledData.customer.email || '',
          customerAddress: formatCustomerAddress(cancelledData.customer),
          note: cancelledData.note || '',
          reservationId: cancelDisplayId,
        };
        sendCancellationEmail(mailData).catch(logMailFailure('cancellation', { reservationId: id, displayId: cancelDisplayId }, req));
        sendStaffNotification(mailData, 'cancel').catch(logMailFailure('staff', { reservationId: id, displayId: cancelDisplayId, kind: 'cancel' }, req));
      }

      auditLog('reservation.cancel', { reservationId: id, displayId: cancelDisplayId, customerName: cancelledData?.customer?.name || '' }, req);
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
