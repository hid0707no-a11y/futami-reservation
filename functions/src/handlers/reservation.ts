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
import { planLabel, roomLabels, formatTennisTimeRanges } from '../lib/labels';
import { validateUpdateFields } from '../lib/validation';
import {
  businessCalendarFromData,
  findClosedFacilitySlot,
  serviceDatesFromRange,
} from '../lib/businessDays';
import { RESERVATION_STATUS } from '../constants';

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

    const id = (req.query.id as string) || (req.body?.id as string);
    if (!id) { res.status(400).json({ error: 'id_required' }); return; }

    // #2 入力検証（型・長さ）。検証を通ったフィールドだけ更新対象にする。
    const valid = validateUpdateFields(req.body);
    if (!valid.ok) { res.status(400).json({ error: valid.error }); return; }
    const fields = valid.updates as Record<string, any>;

    try {
      // #5/#9 トランザクション内で存在確認 → 更新 → audit_log を同一 tx で書く（★3 準拠）
      const result = await db.runTransaction(async tx => {
        const resRef = db.collection('reservations').doc(id);
        const resDoc = await tx.get(resRef);
        if (!resDoc.exists) throw { code: 'not_found' };
        const cur = resDoc.data() as any;

        // #2/#5 status 遷移ガード：スロット整合を壊す遷移はこの経路で禁止
        if (fields.status !== undefined && fields.status !== cur.status) {
          // → cancelled は slot 物理削除が必要なので cancelReservation へ誘導
          if (fields.status === RESERVATION_STATUS.CANCELLED) throw { code: 'use_cancel_endpoint' };
          // cancelled からの復活は slot 再取得＋競合検出が必要なため不可（新規予約を作成）
          if (cur.status === RESERVATION_STATUS.CANCELLED) throw { code: 'revival_not_supported' };
        }

        const writes: any = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (fields.status !== undefined) writes.status = fields.status;
        if (fields.note !== undefined) writes.note = fields.note;
        // #2 customer/payment は部分送信でのフィールド消失を防ぐため既存値とマージ
        if (fields.customer !== undefined) writes.customer = { ...(cur.customer || {}), ...fields.customer };
        if (fields.payment !== undefined) writes.payment = { ...(cur.payment || {}), ...fields.payment };

        tx.update(resRef, writes);

        const after: any = {};
        if (writes.status !== undefined) after.status = writes.status;
        if (writes.note !== undefined) after.note = writes.note;
        if (writes.customer !== undefined) after.customer = writes.customer;
        if (writes.payment !== undefined) after.payment = writes.payment;

        const logRef = resRef.collection('audit_log').doc();
        tx.set(logRef, {
          at: admin.firestore.FieldValue.serverTimestamp(),
          actor: ((req as any).auth?.email) || 'unknown',
          action: 'update',
          before: {
            status: cur.status ?? null, note: cur.note ?? null,
            customer: cur.customer ?? null, payment: cur.payment ?? null,
          },
          after,
        });
        return { updated: Object.keys(writes).filter(k => k !== 'updatedAt') };
      });

      auditLog('reservation.update', { reservationId: id, fields: result.updated }, req);
      res.status(200).json({ id, updated: result.updated });
    } catch (e: any) {
      if (e?.code === 'not_found') { res.status(404).json({ error: 'not_found' }); return; }
      if (e?.code === 'use_cancel_endpoint') {
        res.status(400).json({ error: 'use_cancel_endpoint', detail: 'status=cancelled は cancelReservation を使用してください' });
        return;
      }
      if (e?.code === 'revival_not_supported') {
        res.status(400).json({ error: 'revival_not_supported', detail: 'キャンセル済予約は更新で復活できません。新規予約を作成してください' });
        return;
      }
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
        // 施設停止（facilityClosed）の判定に使うカレンダーも同じトランザクションで読む。
        // Firestore は「書込みの前に全ての読取」を要求するので、ここでまとめて取得しておく。
        const [resDoc, calendarDoc] = await Promise.all([
          tx.get(resRef),
          tx.get(db.doc('config/business_calendar')),
        ]);
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

        // 停止中のキャンプ区画へ付け替えられないようにする（createReservation と同じ判定）。
        // 判定対象は「新しい」slots だけ＝元の区画が停止されても付け替え自体は妨げない
        // （むしろ停止区画から動かす操作なので通す必要がある）。
        // serviceDates は保存済みの startDate/endDate から復元する。canonical と同じ規約で
        // チェックアウト日を含まないため、「停止日にチェックアウトするだけ」の予約は弾かれない。
        const txCal = businessCalendarFromData(calendarDoc.exists ? calendarDoc.data() : {});
        const txClosedFacility = findClosedFacilitySlot(
          newSlots, txCal, serviceDatesFromRange(data.startDate, data.endDate));
        if (txClosedFacility) throw { code: 'facility_closed', detail: txClosedFacility };

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
      // createReservation と同じ error コード・同じ 400 で返す（画面側の分岐を増やさない）
      if (e?.code === 'facility_closed') { res.status(400).json({ error: 'facility_closed', detail: e.detail }); return; }
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
      let alreadyCancelled = false;

      await db.runTransaction(async tx => {
        const resRef = db.collection('reservations').doc(id);
        const resDoc = await tx.get(resRef);
        if (!resDoc.exists) throw { code: 'not_found' };

        const data = resDoc.data() as any;
        cancelledData = data;
        // #4 再キャンセルガード（冪等）：既に cancelled なら slot を一切触らず終了
        if (data.status === RESERVATION_STATUS.CANCELLED) { alreadyCancelled = true; return; }
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
        // #4 所有権チェック：slot を読み、reservationId が自予約のものだけ削除する
        // （A をキャンセル→解放→B が同じ slot を取得→A を再キャンセル、で B の slot を消す事故を防ぐ）
        const collection = isTennisRes ? 'tennis_slots' : 'slots';
        const slotRefs = slotKeys.map(key => db.collection(collection).doc(key));
        const slotDocs = await Promise.all(slotRefs.map(r => tx.get(r)));
        tx.update(resRef, {
          status: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        slotDocs.forEach((d, i) => {
          if (d.exists && (d.data() as any).reservationId === id) {
            tx.delete(slotRefs[i]);
          }
        });
      });

      // #4 既にキャンセル済みなら冪等に 200 を返す（メール再送・slot 操作なし）
      if (alreadyCancelled) {
        res.status(200).json({ id, status: 'cancelled', alreadyCancelled: true });
        return;
      }

      // キャンセルメール送信（失敗は構造化ログへ）
      // 2026-05-13: メール表示 ID は displayId 優先（要望#8 のキャンセル経路でも顧客に短縮ID
      // を提示するため）。backfill 前の旧予約も generateDisplayId(id) で同じ規則で fallback。
      const cancelDisplayId = cancelledData?.displayId || generateDisplayId(id);
      if (cancelledData?.customer) {
        const mailData: MailData = {
          planName: planLabel(cancelledData.planId || ''), roomName: roomLabels(cancelledData.roomIds || []),
          planId: cancelledData.planId || '', roomIds: cancelledData.roomIds || [],
          timeText: cancelledData.isTennis ? (formatTennisTimeRanges(cancelledData.slots) || undefined) : undefined,
          startDate: cancelledData.startDate || '', endDate: cancelledData.endDate || '',
          customerName: cancelledData.customer.name || '', customerPhone: cancelledData.customer.phone || '',
          customerEmail: cancelledData.customer.email || '',
          customerAddress: formatCustomerAddress(cancelledData.customer),
          note: cancelledData.note || '',
          reservationId: cancelDisplayId,
        };
        // #7 メール送信は応答前に await（Gen2 応答後 CPU スロットリング対策）
        await Promise.allSettled([
          sendCancellationEmail(mailData).catch(logMailFailure('cancellation', { reservationId: id, displayId: cancelDisplayId }, req)),
          sendStaffNotification(mailData, 'cancel').catch(logMailFailure('staff', { reservationId: id, displayId: cancelDisplayId, kind: 'cancel' }, req)),
        ]);
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
