// 管理者向けハンドラ群（health / listAuditLog / triggerSyncToSheets）
//
// 2026-05-05 新設（/gfu Phase B-1 完全分割）。
// 旧 index.ts に分散していた小ぶり3ハンドラを集約。

import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestore';
import { setCors } from '../lib/cors';
import { checkRateLimit } from '../lib/rateLimit';
import { requireStaffAuth } from '../lib/auth';
import { syncReservationsToSheets } from '../services/sheetsSync';

/** GET /health — サーバ生死確認（無認証・公開） */
export const health = onRequest(
  { region: 'asia-northeast1' },
  async (req, res) => {
    if (setCors(req, res)) return;
    res.status(200).json({ ok: true, time: new Date().toISOString() });
  }
);

/** GET /listAuditLog?id=<reservationId> — 予約の操作履歴 50件（staff認証） */
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

/** POST /triggerSyncToSheets — staff画面からの手動スプシ同期トリガ */
export const triggerSyncToSheets = onRequest(
  { region: 'asia-northeast1' },
  async (req, res) => {
    if (setCors(req, res)) return;
    if (!(await requireStaffAuth(req, res))) return;
    try {
      const result = await syncReservationsToSheets(db);
      res.status(200).json({ ok: true, ...result });
    } catch (e: any) {
      console.error('[sync] manual trigger failed:', e);
      res.status(500).json({ error: 'sync_failed', detail: e.message || String(e) });
    }
  }
);
