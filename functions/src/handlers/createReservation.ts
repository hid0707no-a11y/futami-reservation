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
import { MailData, sendConfirmationEmail, sendStaffNotification, sendMonitorAlert } from '../lib/mail';
import { validateReservationBody } from '../lib/validation';
import { VALID_ROOM_IDS } from '../constants';
import { getFutamiDaysFresh } from '../lib/futamiDays';
import { checkIdempotency as checkIdempotencyFs, saveIdempotencyKey as saveIdempotencyKeyFs } from '../lib/idempotency';

/**
 * displayId 衝突時の運用エスカレーション。
 *
 * 2026-05-13 強化（コードレビュー 🔴 指摘#2）。
 * 旧版は console.warn のみで上村さん（運営）に届かなかった。「F-XXXXXX で2件存在」
 * の状態は電話照会で判別不能になるため、severity=CRITICAL ログ + SMTP アラートで
 * 即時手動リネーム指示が出せるようにする。
 *
 * 失敗（メール送信エラー等）は console.error に握り、本予約成功には影響させない。
 */
function escalateDisplayIdCollision(
  displayId: string,
  newId: string,
  existingIds: string[],
  reservationType: string,
): void {
  console.error(JSON.stringify({
    severity: 'CRITICAL',
    audit: true,
    action: 'displayId.collision',
    displayId,
    newId,
    existingIds,
    type: reservationType,
    runbook: 'docs/RUNBOOK.md §6 Firestore データ復旧 — displayId 手動リネーム',
  }));
  const body = [
    `[CRITICAL] displayId 衝突が発生しました。`,
    ``,
    `displayId: ${displayId}`,
    `新規予約ID: ${newId}`,
    `既存予約ID: ${existingIds.join(', ')}`,
    `予約タイプ: ${reservationType}`,
    ``,
    `対応：Firestore で既存予約のいずれかの displayId を手動で別 ID に書き換え`,
    `（例：'F-XXXXXX' の末尾に文字追加 → 'F-XXXXXX-2'）。`,
    `内部 Auto ID は一意なので機能的影響なし。運営の電話照会対応のためのみの対応。`,
    ``,
    `参照: docs/RUNBOOK.md §6 Firestore データ復旧`,
  ].join('\n');
  sendMonitorAlert('[ふたみ予約] displayId 衝突 (要手動対応)', body).catch(e => {
    console.error('[collision] sendMonitorAlert failed:', e?.message || e);
  });
}

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
          // #7 メール送信は応答前に await（Gen2 は応答後 CPU スロットリングで未完になり得る）
          await Promise.allSettled([
            sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: tennisResult.id, type: 'tennis' }, req)),
            sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: tennisResult.id, type: 'tennis', kind: 'new' }, req)),
          ]);
          // #11 displayId 衝突検知を応答前に await（旧 fire-and-forget は CPU スロットリングで未実行→検知漏れ。
          //     完全な衝突“防止”（tx内一意確保）は採番3経路に跨るため別途）
          try {
            const c = await detectDisplayIdCollision(db, tennisResult.displayId, tennisResult.id);
            if (c.collided) escalateDisplayIdCollision(tennisResult.displayId, tennisResult.id, c.existingIds, 'tennis');
          } catch (e: any) { console.error('[collision-check] failed:', e?.message || e); }
          auditLog('reservation.create', { reservationId: tennisResult.id, displayId: tennisResult.displayId, planId, roomIds, startDate, customerName: customer.name, type: 'tennis' }, req);
          const tennisResp = { reservationId: tennisResult.displayId, internalId: tennisResult.id, status: 'confirmed', isTennis: true };
          // #6 冪等性キー保存を応答前に await（保存前リトライの素通り窓を塞ぐ）
          await saveIdempotencyKey(req, tennisResp).catch(logIdempotencyFailure(tennisResult.id, req));
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
        // #16 TOCTOU 対策：30秒キャッシュを使わず config/special_days を直読みして判定
        const futamiSet = await getFutamiDaysFresh();
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
          // #7 メール送信は応答前に await
          await Promise.allSettled([
            sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: result.id, type: 'futami_sauna', seats }, req)),
            sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: result.id, type: 'futami_sauna', kind: 'new' }, req)),
          ]);
          // #11 displayId 衝突検知を応答前に await
          try {
            const c = await detectDisplayIdCollision(db, result.displayId, result.id);
            if (c.collided) escalateDisplayIdCollision(result.displayId, result.id, c.existingIds, 'futami_sauna');
          } catch (e: any) { console.error('[collision-check] failed:', e?.message || e); }
          auditLog('reservation.create', { reservationId: result.id, displayId: result.displayId, planId, roomIds, startDate, customerName: customer.name, type: 'futami_sauna', seats }, req);
          const futamiResp = { reservationId: result.displayId, internalId: result.id, status: 'confirmed', isFutamiDay: true, seats };
          // #6 冪等性キー保存を応答前に await
          await saveIdempotencyKey(req, futamiResp).catch(logIdempotencyFailure(result.id, req));
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
        // #12 nights を Number 正規化：文字列等で型チェックを外す bypass を防ぐ
        // （slot 個数・日付範囲は validateReservationBody の #3 検査で別途担保）
        const nn = Number(nights);
        if (!Number.isFinite(nn) || nn > CAMP_MAX_NIGHTS) {
          res.status(400).json({ error: 'too_many_nights', detail: `${CAMP_MAX_NIGHTS}泊まで（数値で指定）` });
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
      // #7 メール送信は応答前に await
      await Promise.allSettled([
        sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: result.id, type: isCamp ? 'camp' : 'normal' }, req)),
        sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: result.id, type: isCamp ? 'camp' : 'normal', kind: 'new' }, req)),
      ]);
      // #11 displayId 衝突検知を応答前に await
      try {
        const c = await detectDisplayIdCollision(db, result.displayId, result.id);
        if (c.collided) escalateDisplayIdCollision(result.displayId, result.id, c.existingIds, isCamp ? 'camp' : 'normal');
      } catch (e: any) { console.error('[collision-check] failed:', e?.message || e); }
      auditLog('reservation.create', { reservationId: result.id, displayId: result.displayId, planId, roomIds, startDate, customerName: customer.name, type: isCamp ? 'camp' : 'normal' }, req);
      const normalResp = { reservationId: result.displayId, internalId: result.id, status: 'confirmed', ...(isCamp ? { isCamp: true, sites: roomIds.length } : {}) };
      // #6 冪等性キー保存を応答前に await
      await saveIdempotencyKey(req, normalResp).catch(logIdempotencyFailure(result.id, req));

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
