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
import { isVerifiedStaffRequest } from '../lib/auth';
import { checkRateLimit } from '../lib/rateLimit';
import { audit as auditLog, logMailFailure, logIdempotencyFailure } from '../lib/logger';
import { formatCustomerAddress, formatPartyText, formatSaunaOptions, generateDisplayId } from '../lib/format';
import { detectDisplayIdCollision } from '../lib/displayId';
import { MailData, sendConfirmationEmail, sendStaffNotification, sendMonitorAlert } from '../lib/mail';
import { validateReservationBody, isCustomerEmailRequired } from '../lib/validation';
import { VALID_ROOM_IDS } from '../constants';
import { getFutamiDaysFresh } from '../lib/futamiDays';
import {
  businessCalendarFromData,
  findClosedDayInServiceDates,
  findClosedFacilitySlot,
  getBusinessCalendarFresh,
} from '../lib/businessDays';
import { canonicalizeReservation } from '../lib/reservationPlans';
import { planLabel, roomLabels, formatTennisTimeRanges } from '../lib/labels';
import { computeServerPricing } from '../lib/pricingServer';
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
async function escalateDisplayIdCollision(
  displayId: string,
  newId: string,
  existingIds: string[],
  reservationType: string,
): Promise<void> {
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
  try {
    await sendMonitorAlert('[ふたみ予約] displayId 衝突 (要手動対応)', body);
  } catch (e: any) {
    console.error('[collision] sendMonitorAlert failed:', e?.message || e);
  }
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

function legacyTennisKeysForCanonicalSlots(slots: string[]): string[] {
  const keys = new Set<string>();
  for (const slot of slots) {
    const [roomId, date, time] = slot.split('|');
    if (!roomId || !date || !/^\d{4}$/.test(time || '')) continue;
    const hourPadded = time.slice(0, 2);
    const hour = String(Number(hourPadded));
    const minute = time.slice(2);
    // 旧staff整数時（8/08）は1時間占有、旧colon形式は30分docとして照合する。
    keys.add(`${roomId}|${date}|${hour}`);
    keys.add(`${roomId}|${date}|${hourPadded}`);
    keys.add(`${roomId}|${date}|${hour}:${minute}`);
    keys.add(`${roomId}|${date}|${hourPadded}:${minute}`);
  }
  return Array.from(keys);
}

function alternateSaunaKeys(slots: string[], targetRoomId: 'sauna' | 'sauna_share'): string[] {
  return slots.map(key => {
    const [, date, hour] = key.split('|');
    return `${targetRoomId}|${date}|${hour}`;
  });
}

// 薄いラッパ：db を束ねる（互換維持）
// isStaff=true のときだけ「予約受付期間（宿泊365日/その他90日）」を免除する（2026-08-25 要望④）。
// 過去日の拒否（booking_in_past）は職員でも維持する＝日付の打ち間違いを静かに通さないため。
function validateAndRespond(body: any, res: any, isStaff: boolean): boolean {
  const result = validateReservationBody(body, { validRoomIds: VALID_ROOM_IDS, isStaff });
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
      let {
        planId, roomIds, slots,
        startDate, endDate,
        nights = 0,
        customer, guests, pricing,
        note,
        guestCount, // ふたみの日用：占有人数（1〜8）
      } = body;

      if (!checkOrigin(req, res)) return;

      // createdBy はクライアント申告を信用せず、任意Bearerの実検証結果から決める。
      // ★2026-08-25 要望④：職員だけ予約受付期間を免除するため、この判定を
      //   validateAndRespond より前に移した。副作用は無い＝Bearer の検証だけを行う
      //   純粋な読取で、Firestore への書込みも res への送信もしない。
      //   （レート制限・CORS・Origin チェックはこれより前のまま。冪等性チェックと
      //     canonicalize の順序も従来どおり「検証 → 冪等 → canonical」を維持する）
      const createdBy = await isVerifiedStaffRequest(req) ? 'staff' : 'web';

      if (!validateAndRespond(body, res, createdBy === 'staff')) return;
      // 旧payloadで既に成立した予約の応答再取得を、canonical移行後も先に通す。
      if (!(await checkIdempotency(req, res))) return;

      // planId/room/date/slots をサーバ側カタログから再導出し、完全一致した予約だけを受理する。
      // 以降の分岐・Firestore書込みではクライアント申告値でなくcanonical値を使用する。
      const canonicalResult = canonicalizeReservation(body);
      if (!canonicalResult.ok) {
        const payload: any = { error: canonicalResult.error };
        if (canonicalResult.detail) payload.detail = canonicalResult.detail;
        res.status(400).json(payload);
        return;
      }
      const canonical = canonicalResult.value;
      planId = canonical.planId;
      roomIds = canonical.roomIds;
      slots = canonical.slots;
      startDate = canonical.startDate;
      endDate = canonical.endDate;
      nights = canonical.nights;

      // サウナはメール必須（2026-08-16 運営要望③）。職員入力（電話受付）は対象外。
      // 判定は canonical 化後の planId/roomIds で行う（クライアント申告の planId では
      // ふたみの日サウナが sauna_1〜4 のまま届く経路がある）。
      if (isCustomerEmailRequired({ planId, roomIds }, createdBy) && !customer?.email) {
        res.status(400).json({ error: 'email_required_for_sauna' });
        return;
      }

      // #17 料金はサーバが canonical plan/slots と選択事実（市民区分・照明・オプション）から
      // 権威的に再計算し、この serverPricing だけを保存する。クライアント申告の pricing.total は
      // 保存しない（total:1 等の改ざんは上書きされる）。丸め差等で total が一致しなくても予約は
      // 拒否せず、pricingMismatch を予約に併記＋構造化ログするだけにする（顧客予約の取りこぼし防止）。
      //
      // ただし職員手動予約（staff.html）だけは計算しない。職員画面に市民/市外の入力UIが無く
      // customer.isMember を false 固定で送るため、サーバが計算すると伊予市民のお客様の予約でも
      // 必ず市外料金（例 テニス半面 240→280）が保存され、日次同期でスプレッドシートの
      // 「合計金額」列に載ってしまう。0円（＝明らかに未記入）なら人が気づけるが、尤もらしい
      // 誤った金額は検知されないまま行政報告用の台帳に残る。分からない区分は埋めない方針で、
      // 従来どおり pricing: null を保存する（職員画面への市民/市外入力追加が恒久対応・別途）。
      const pricingResult = createdBy === 'staff' ? null : computeServerPricing(canonical, {
        guests,
        isResident: customer?.isMember === true,
        declaredPricing: pricing,
        guestCount,
      });
      const serverPricing = pricingResult?.pricing ?? null;
      const pricingMismatch = pricingResult?.mismatch ?? null;
      if (pricingMismatch) {
        console.error(JSON.stringify({
          severity: 'WARNING',
          audit: true,
          action: 'pricing.mismatch',
          planId, startDate, createdBy,
          claimedTotal: pricingMismatch.claimedTotal,
          computedTotal: pricingMismatch.computedTotal,
        }));
      }

      // 定休日はcanonical planから導出したサービス提供日だけで判定する。
      // checkout時刻の推測やクライアントslot省略に依存しない。
      const businessCal = await getBusinessCalendarFresh();
      const closedDay = findClosedDayInServiceDates(canonical.serviceDates, businessCal);
      if (closedDay) {
        res.status(400).json({ error: 'closed_day', detail: closedDay });
        return;
      }

      // 施設単位の停止（例：サウナだけその日は受け付けない）。日付単位の closed_day と違い
      // 部屋×日（×時間）で当たるので、canonical slots をそのまま突き合わせる。
      // 終日停止の突合は canonical.serviceDates 基準（＝定休日判定と同じ規約）。
      // 渡さないと、宿泊の翌朝チェックアウト分の slot まで終日停止に当たり、
      // 「その日にチェックアウトするだけ」の連泊が作れなくなる。
      const closedFacilitySlot = findClosedFacilitySlot(slots, businessCal, canonical.serviceDates);
      if (closedFacilitySlot) {
        res.status(400).json({ error: 'facility_closed', detail: closedFacilitySlot });
        return;
      }

      // ===== テニス専用ルート（tennis_slots 30分単位）=====
      const isTennis = canonical.kind === 'tennis' && isTennisPayload(roomIds);
      if (isTennis) {
        try {
          const tennisResult = await db.runTransaction(async tx => {
            const calendarDoc = await tx.get(db.doc('config/business_calendar'));
            const txCal = businessCalendarFromData(calendarDoc.exists ? calendarDoc.data() : {});
            const txClosedDay = findClosedDayInServiceDates(canonical.serviceDates, txCal);
            if (txClosedDay) throw { code: 'closed_day', detail: txClosedDay };
            const txClosedFacility = findClosedFacilitySlot(slots, txCal, canonical.serviceDates);
            if (txClosedFacility) throw { code: 'facility_closed', detail: txClosedFacility };

            const slotRefs = slots.map((key: string) => db.collection('tennis_slots').doc(key));
            // staff旧形式（court|date|8）が残っていても、新HHMM形式と二重予約させない。
            const legacyKeys = legacyTennisKeysForCanonicalSlots(slots);
            const legacyRefs = legacyKeys.map(key => db.collection('tennis_slots').doc(key));
            const [slotDocs, legacyDocs] = await Promise.all([
              Promise.all(slotRefs.map((ref: any) => tx.get(ref))),
              Promise.all(legacyRefs.map((ref: any) => tx.get(ref))),
            ]);
            const conflicts = [
              ...slotDocs
              .map((d: any, i: number) => (d.exists ? slots[i] : null))
              .filter((x: any) => x !== null),
              ...legacyDocs
                .map((d: any, i: number) => (d.exists ? legacyKeys[i] : null))
                .filter((x: any) => x !== null),
            ];
            if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };
            const resRef = db.collection('reservations').doc();
            const displayId = generateDisplayId(resRef.id);
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId, roomIds, slots, startDate, endDate, nights: 0,
              customer, guests: guests || null, pricing: serverPricing,
              ...(pricingMismatch ? { pricingMismatch } : {}),
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
            planName: planLabel(planId), roomName: roomLabels(roomIds), startDate, endDate,
            planId, roomIds,
            customerName: customer.name, customerKana: customer.kana || '', customerPhone: customer.phone,
            customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
            note: note || '', reservationId: tennisResult.displayId, isTennis: true,
            timeText: formatTennisTimeRanges(slots) || undefined,
            // テニスは「ご利用予定人数(目安)」＝ pricing.sportGuestEstimate（職員経路は
            // serverPricing=null なので guests.adult の単純人数が採用される）。
            partyText: formatPartyText({
              planId, roomIds, createdBy, guests,
              sportGuestEstimate: serverPricing?.sportGuestEstimate,
            }) || undefined,
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
            if (c.collided) await escalateDisplayIdCollision(tennisResult.displayId, tennisResult.id, c.existingIds, 'tennis');
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
      const isFutamiSauna = canonical.kind === 'futami_sauna';
      const isRegularSauna = /^sauna_[1-4]$/.test(planId);
      let futamiSet: Set<string> | null = null;
      if (isFutamiSauna || isRegularSauna) {
        futamiSet = await getFutamiDaysFresh();
        const isSpecialDate = futamiSet.has(startDate);
        if (isRegularSauna && isSpecialDate) {
          res.status(400).json({ error: 'futami_day_requires_shared_sauna', detail: startDate });
          return;
        }
        if (isFutamiSauna && !isSpecialDate) {
          res.status(400).json({ error: 'not_futami_day', detail: startDate });
          return;
        }
      }
      if (isFutamiSauna) {
        // roomIds は ['sauna_share'] のみ許可（2026-07-19）：planId だけで発火するため、
        // camp_*/room_* ペイロードをこのルートに逸らすとキャンプ上限をスキップでき、
        // slot doc キーと roomId フィールドが食い違う腐敗データが在庫を封鎖する。
        if (roomIds.length !== 1 || roomIds[0] !== 'sauna_share') {
          res.status(400).json({ error: 'invalid_roomIds', detail: 'ふたみの日サウナは sauna_share のみ' });
          return;
        }
        const seats = guestCount ?? guests?.adult ?? 2;
        if (!Number.isSafeInteger(seats) || seats < 2 || seats > 8) {
          res.status(400).json({ error: 'invalid_guest_count', detail: '2〜8人' });
          return;
        }

        try {
          const result = await db.runTransaction(async tx => {
            const [calendarDoc, specialDaysDoc] = await Promise.all([
              tx.get(db.doc('config/business_calendar')),
              tx.get(db.doc('config/special_days')),
            ]);
            const txCal = businessCalendarFromData(calendarDoc.exists ? calendarDoc.data() : {});
            const txClosedDay = findClosedDayInServiceDates(canonical.serviceDates, txCal);
            if (txClosedDay) throw { code: 'closed_day', detail: txClosedDay };
            // sauna_share の slots でも、'sauna' 側への停止指定に当たる（連動ルール）。
            const txClosedFacility = findClosedFacilitySlot(slots, txCal, canonical.serviceDates);
            if (txClosedFacility) throw { code: 'facility_closed', detail: txClosedFacility };
            const txFutamiDates: string[] = specialDaysDoc.exists
              && Array.isArray((specialDaysDoc.data() as any)?.sauna_capacity_days)
              ? (specialDaysDoc.data() as any).sauna_capacity_days
              : [];
            if (!txFutamiDates.includes(startDate)) {
              throw { code: 'not_futami_day', detail: startDate };
            }

            const slotRefs = slots.map((key: string) => db.collection('slots').doc(key));
            const regularKeys = alternateSaunaKeys(slots, 'sauna');
            const regularRefs = regularKeys.map(key => db.collection('slots').doc(key));
            const [slotDocs, regularDocs] = await Promise.all([
              Promise.all(slotRefs.map((ref: any) => tx.get(ref))),
              Promise.all(regularRefs.map((ref: any) => tx.get(ref))),
            ]);
            const conflicts = [
              ...slotDocs.map((d: any, i: number) => (d.exists ? slots[i] : null)),
              ...regularDocs.map((d: any, i: number) => (d.exists ? regularKeys[i] : null)),
            ].filter((x: any) => x !== null);
            if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };

            const resRef = db.collection('reservations').doc();
            const displayId = generateDisplayId(resRef.id);
            const now = admin.firestore.FieldValue.serverTimestamp();
            tx.set(resRef, {
              planId, roomIds: ['sauna_share'], slots, startDate, endDate, nights: 0,
              customer, guests: guests || null, guestCount: seats,
              pricing: serverPricing,
              ...(pricingMismatch ? { pricingMismatch } : {}),
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
            planName: planLabel(planId), roomName: 'サンセットサウナ（ふたみの日）', startDate, endDate,
            planId, roomIds: ['sauna_share'],
            customerName: customer.name, customerKana: customer.kana || '', customerPhone: customer.phone,
            customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
            note: note || '', reservationId: result.displayId, guestCount: seats, isFutamiDay: true,
            partyText: formatPartyText({
              planId, roomIds: ['sauna_share'], createdBy, guests, guestCount: seats,
            }) || undefined,
            // 職員経路は serverPricing=null（区分不明のため計算しない）→ オプション表記は省略。
            saunaOptionsText: formatSaunaOptions(serverPricing?.saunaOptions) || undefined,
          };
          // #7 メール送信は応答前に await
          await Promise.allSettled([
            sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: result.id, type: 'futami_sauna', seats }, req)),
            sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: result.id, type: 'futami_sauna', kind: 'new' }, req)),
          ]);
          // #11 displayId 衝突検知を応答前に await
          try {
            const c = await detectDisplayIdCollision(db, result.displayId, result.id);
            if (c.collided) await escalateDisplayIdCollision(result.displayId, result.id, c.existingIds, 'futami_sauna');
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
      const isCamp = canonical.kind === 'overnight' && planId === 'camp_stay';

      // 通常サウナ（sauna_1〜4）の利用人数。ふたみの日と同じ guestCount で受け取る。
      // 2026-08-03 追加（運営要望④）：それまでサーバは通常サウナの guestCount を
      // 一切保存せず、通知メール・職員画面のどちらにも人数が出せなかった。
      // 定員は8名。範囲外・未送信は従来どおり「人数不明」として無視する
      // （ここで 400 を返すと、これまで成立していた予約を新たに落とすことになる）。
      const saunaSeats = isRegularSauna
        && Number.isSafeInteger(guestCount) && guestCount >= 1 && guestCount <= 8
        ? guestCount as number
        : null;

      // ===== 通常プラン（slots collection）=====
      const result = await db.runTransaction(async tx => {
        const calendarDoc = await tx.get(db.doc('config/business_calendar'));
        const txCal = businessCalendarFromData(calendarDoc.exists ? calendarDoc.data() : {});
        const txClosedDay = findClosedDayInServiceDates(canonical.serviceDates, txCal);
        if (txClosedDay) throw { code: 'closed_day', detail: txClosedDay };
        // 通常サウナ（sauna）の slots は 'sauna_share' 側への停止指定にも当たる（連動ルール）。
        const txClosedFacility = findClosedFacilitySlot(slots, txCal, canonical.serviceDates);
        if (txClosedFacility) throw { code: 'facility_closed', detail: txClosedFacility };

        if (isRegularSauna) {
          const specialDaysDoc = await tx.get(db.doc('config/special_days'));
          const txFutamiDates: string[] = specialDaysDoc.exists
            && Array.isArray((specialDaysDoc.data() as any)?.sauna_capacity_days)
            ? (specialDaysDoc.data() as any).sauna_capacity_days
            : [];
          if (txFutamiDates.includes(startDate)) {
            throw { code: 'futami_day_requires_shared_sauna', detail: startDate };
          }
        }

        const slotRefs = slots.map((key: string) => db.collection('slots').doc(key));
        const alternateKeys = isRegularSauna ? alternateSaunaKeys(slots, 'sauna_share') : [];
        const alternateRefs = alternateKeys.map(key => db.collection('slots').doc(key));
        const [slotDocs, alternateDocs] = await Promise.all([
          Promise.all(slotRefs.map((ref: any) => tx.get(ref))),
          Promise.all(alternateRefs.map((ref: any) => tx.get(ref))),
        ]);
        const conflicts = [
          ...slotDocs.map((d: any, i: number) => (d.exists ? slots[i] : null)),
          ...alternateDocs.map((d: any, i: number) => (d.exists ? alternateKeys[i] : null)),
        ].filter((x: any) => x !== null);
        if (conflicts.length > 0) throw { code: 'slot_conflict', conflicts };

        const resRef = db.collection('reservations').doc();
        const displayId = generateDisplayId(resRef.id);
        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(resRef, {
          planId, roomIds, slots, startDate, endDate, nights,
          customer, guests: guests || null,
          ...(isCamp ? { guestCount: roomIds.length, isCamp: true } : {}),
          ...(saunaSeats !== null ? { guestCount: saunaSeats } : {}),
          pricing: serverPricing,
          ...(pricingMismatch ? { pricingMismatch } : {}),
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
        : roomLabels(roomIds);
      const mailData: MailData = {
        planName: planLabel(planId), roomName: roomNameForMail, startDate, endDate,
        planId, roomIds,
        customerName: customer.name, customerKana: customer.kana || '', customerPhone: customer.phone,
        customerEmail: customer.email || '', customerAddress: formatCustomerAddress(customer),
        note: note || '', reservationId: result.displayId,
        ...(isCamp ? { isCamp: true, guestCount: roomIds.length } : {}),
        // キャンプは「区画数」＋（職員入力があれば）人数、宿泊は3区分、みどりの広場は
        // 目安人数、通常サウナは guestCount。入力欄が無いプラン（日帰り各室・ロッジの
        // web 予約）はデータ自体が存在しないので行ごと出さない。
        partyText: formatPartyText({
          planId, roomIds, createdBy, guests,
          isCamp,
          guestCount: saunaSeats ?? undefined,
          sportGuestEstimate: serverPricing?.sportGuestEstimate,
        }) || undefined,
        // 職員経路は serverPricing=null（区分不明のため計算しない）→ オプション表記は省略。
        saunaOptionsText: formatSaunaOptions(serverPricing?.saunaOptions) || undefined,
      };
      // #7 メール送信は応答前に await
      await Promise.allSettled([
        sendConfirmationEmail(mailData).catch(logMailFailure('confirmation', { reservationId: result.id, type: isCamp ? 'camp' : 'normal' }, req)),
        sendStaffNotification(mailData, 'new').catch(logMailFailure('staff', { reservationId: result.id, type: isCamp ? 'camp' : 'normal', kind: 'new' }, req)),
      ]);
      // #11 displayId 衝突検知を応答前に await
      try {
        const c = await detectDisplayIdCollision(db, result.displayId, result.id);
        if (c.collided) await escalateDisplayIdCollision(result.displayId, result.id, c.existingIds, isCamp ? 'camp' : 'normal');
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
      if (e?.code === 'closed_day' || e?.code === 'facility_closed'
          || e?.code === 'not_futami_day'
          || e?.code === 'futami_day_requires_shared_sauna') {
        res.status(400).json({ error: e.code, detail: e.detail });
        return;
      }
      console.error(e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
