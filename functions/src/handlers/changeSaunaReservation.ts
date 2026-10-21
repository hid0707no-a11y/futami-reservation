// サウナ予約の日付・時間枠・人数を職員が変更する（2026-10-16 運営要望②）
//
// それまでは「キャンセル → 新規で取り直し」しか無く、予約番号が変わっていた。
// 旧slotの解放・新slotの確保・予約docの更新・audit_log を1トランザクションで行う（★3）。
// 判定の純粋部分は lib/saunaChange.ts（テスト対象）。

import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestore';
import { setCors, checkOrigin } from '../lib/cors';
import { checkRateLimit } from '../lib/rateLimit';
import { requireStaffAuth } from '../lib/auth';
import { audit as auditLog } from '../lib/logger';
import {
  businessCalendarFromData,
  findClosedDayInServiceDates,
  findClosedFacilitySlot,
} from '../lib/businessDays';
import {
  validateSaunaChangeBody,
  isStoredSaunaReservation,
  buildSaunaTarget,
  oppositeSaunaKeys,
  diffSlots,
  recomputeSaunaPricing,
} from '../lib/saunaChange';

/** POST /changeSaunaReservation { id, startDate, frame: sauna_1〜4, guestCount } */
export const changeSaunaReservation = onRequest(
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

    const valid = validateSaunaChangeBody(req.body);
    if (!valid.ok) {
      res.status(400).json(valid.detail ? { error: valid.error, detail: valid.detail } : { error: valid.error });
      return;
    }
    const input = valid.value;
    const id = input.id;

    try {
      const result = await db.runTransaction(async tx => {
        const resRef = db.collection('reservations').doc(id);
        // Firestore は「書込みの前に全ての読取」＝カレンダー・ふたみの日もここで読む。
        const [resDoc, calendarDoc, specialDaysDoc] = await Promise.all([
          tx.get(resRef),
          tx.get(db.doc('config/business_calendar')),
          tx.get(db.doc('config/special_days')),
        ]);
        if (!resDoc.exists) throw { code: 'not_found' };
        const cur = resDoc.data() as any;
        if (cur.status !== 'confirmed') throw { code: 'invalid_status', detail: cur.status };
        if (!isStoredSaunaReservation(cur)) throw { code: 'not_sauna_reservation' };

        // 通常日 ⇄ ふたみの日 はサーバが決める（画面の申告は見ない）。
        const futamiDates: string[] = specialDaysDoc.exists
          && Array.isArray((specialDaysDoc.data() as any)?.sauna_capacity_days)
          ? (specialDaysDoc.data() as any).sauna_capacity_days
          : [];
        const isFutamiDay = futamiDates.includes(input.startDate);
        const built = buildSaunaTarget(input, isFutamiDay);
        if (!built.ok) throw { code: built.error, detail: built.detail, status: 400 };
        const target = built.value;

        const cal = businessCalendarFromData(calendarDoc.exists ? calendarDoc.data() : {});
        const closedDay = findClosedDayInServiceDates(target.serviceDates, cal);
        if (closedDay) throw { code: 'closed_day', detail: closedDay, status: 400 };
        const closedFacility = findClosedFacilitySlot(target.slots, cal, target.serviceDates);
        if (closedFacility) throw { code: 'facility_closed', detail: closedFacility, status: 400 };

        const oldSlots: string[] = Array.isArray(cur.slots) ? cur.slots : [];
        const { toDelete, toWrite } = diffSlots(oldSlots, target.slots);

        // 新しく取る slot と、その反対側（通常 ⇄ ふたみの日）に他の予約が無いこと。
        // 自分の予約の slot は競合に数えない（同じ枠のまま人数だけ変える・通常→ふたみの日に移る等）。
        const checkKeys = Array.from(new Set([...toWrite, ...oppositeSaunaKeys(target.slots)]));
        const checkDocs = await Promise.all(checkKeys.map(k => tx.get(db.collection('slots').doc(k))));
        const conflicts = checkKeys.filter((k, i) =>
          checkDocs[i].exists && (checkDocs[i].data() as any)?.reservationId !== id);
        if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };

        // 消すのは、この予約のものと確かめられた slot だけ（他の予約の在庫を巻き添えにしない）。
        const deleteDocs = await Promise.all(toDelete.map(k => tx.get(db.collection('slots').doc(k))));

        const now = admin.firestore.FieldValue.serverTimestamp();
        toDelete.forEach((k, i) => {
          const d = deleteDocs[i];
          if (d.exists && (d.data() as any)?.reservationId === id) tx.delete(d.ref);
        });
        const room = target.roomIds[0];
        toWrite.forEach(k => {
          const [, date, hourStr] = k.split('|');
          tx.set(db.collection('slots').doc(k), {
            slotKey: k, roomId: room, date,
            hour: parseInt(hourStr, 10),
            reservationId: id, createdAt: now,
          });
        });

        const pricing = recomputeSaunaPricing(cur, target, input.guestCount);
        tx.update(resRef, {
          planId: target.planId,
          roomIds: target.roomIds,
          slots: target.slots,
          startDate: target.startDate,
          endDate: target.endDate,
          nights: 0,
          guestCount: input.guestCount,
          pricing,
          isFutamiDay: isFutamiDay ? true : admin.firestore.FieldValue.delete(),
          updatedAt: now,
        });

        tx.set(resRef.collection('audit_log').doc(), {
          at: now,
          actor: ((req as any).auth?.email) || 'unknown',
          action: 'change_sauna',
          before: {
            planId: cur.planId ?? null, roomIds: cur.roomIds ?? null, startDate: cur.startDate ?? null,
            guestCount: cur.guestCount ?? null, pricingTotal: cur.pricing?.total ?? null,
          },
          after: {
            planId: target.planId, roomIds: target.roomIds, startDate: target.startDate,
            guestCount: input.guestCount, pricingTotal: pricing?.total ?? null,
          },
        });

        return {
          planId: target.planId, roomIds: target.roomIds, slots: target.slots,
          startDate: target.startDate, guestCount: input.guestCount, isFutamiDay,
          pricingTotal: pricing?.total ?? null,
        };
      });

      auditLog('reservation.change_sauna', { reservationId: id, startDate: result.startDate, planId: result.planId }, req);
      res.status(200).json({ id, ...result });
    } catch (e: any) {
      if (e?.code === 'not_found') { res.status(404).json({ error: 'not_found' }); return; }
      if (e?.code === 'slot_conflict') { res.status(409).json({ error: 'slot_conflict', conflicts: e.conflicts }); return; }
      if (e?.code === 'invalid_status' || e?.code === 'not_sauna_reservation' || e?.status === 400) {
        res.status(400).json(e.detail ? { error: e.code, detail: e.detail } : { error: e.code });
        return;
      }
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
