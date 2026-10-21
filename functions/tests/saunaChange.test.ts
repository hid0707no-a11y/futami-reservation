// サウナ予約の日付・時間枠・人数の変更（2026-10-16 運営要望②）
//
// 「予約内容の変更の際、一度キャンセルして入力し直しているので、
//   すべての項目の変更が運営者権限でいじれるようにしたい」
//
// 純粋部分（lib/saunaChange.ts）を見る。Firestore の読み書きは handlers/changeSaunaReservation.ts。

import * as fs from 'fs';
import * as path from 'path';
import {
  validateSaunaChangeBody,
  isStoredSaunaReservation,
  buildSaunaTarget,
  oppositeSaunaKeys,
  diffSlots,
  recomputeSaunaPricing,
  SAUNA_FRAME_HOURS,
} from '../src/lib/saunaChange';

// 2026-10-16 10:00 JST
const NOW = new Date('2026-10-16T01:00:00Z');

describe('validateSaunaChangeBody', () => {
  const ok = { id: 'abcDEF123', startDate: '2026-10-20', frame: 'sauna_2', guestCount: 4 };

  it('正しい入力を通し、余計なキーは返さない（素通しにしない）', () => {
    const r = validateSaunaChangeBody({ ...ok, status: 'cancelled', pricing: { total: 1 } }, NOW);
    expect(r).toEqual({ ok: true, value: ok });
  });

  it('受付期間（90日）を超える日付も通す＝職員は期間の制限なし（要望①）', () => {
    expect(validateSaunaChangeBody({ ...ok, startDate: '2027-09-30' }, NOW).ok).toBe(true);
  });

  it('当日（4時間前を過ぎた枠でも）は通す＝職員は締切の対象外', () => {
    expect(validateSaunaChangeBody({ ...ok, startDate: '2026-10-16', frame: 'sauna_1' }, NOW).ok).toBe(true);
  });

  it('過去日は職員でも拒否する（createReservation と同じ）', () => {
    expect(validateSaunaChangeBody({ ...ok, startDate: '2026-10-15' }, NOW))
      .toEqual({ ok: false, error: 'booking_in_past' });
  });

  it.each([
    [{ id: '' }, 'id_required'],
    [{ id: '../x' }, 'id_required'],
    [{ startDate: '2026-02-30' }, 'invalid_date_format'],
    [{ frame: 'sauna_5' }, 'invalid_frame'],
    [{ frame: 'toString' }, 'invalid_frame'],
    [{ frame: 'plan_sauna_futami' }, 'invalid_frame'],
    [{ guestCount: 0 }, 'invalid_guest_count'],
    [{ guestCount: 9 }, 'invalid_guest_count'],
    [{ guestCount: '3' }, 'invalid_guest_count'],
    [{ guestCount: 2.5 }, 'invalid_guest_count'],
  ])('不正な入力 %j は %s', (patch, error) => {
    const r = validateSaunaChangeBody({ ...ok, ...patch }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });
});

describe('isStoredSaunaReservation（サウナ以外はこの経路で触らせない）', () => {
  it.each([
    [{ planId: 'sauna_3', roomIds: ['sauna'] }, true],
    [{ planId: 'plan_sauna_futami', roomIds: ['sauna_share'] }, true],
    [{ planId: 'stay_27', roomIds: ['room_27'] }, false],
    [{ planId: 'sauna_3', roomIds: ['sauna', 'room_27'] }, false],
    [{ planId: 'plan_sauna_futami', roomIds: ['sauna'] }, false],
    [{ planId: 'camp_stay', roomIds: ['sauna_share'] }, false],
    [{}, false],
  ])('%j → %s', (cur, expected) => {
    expect(isStoredSaunaReservation(cur)).toBe(expected);
  });
});

describe('buildSaunaTarget', () => {
  const req = { id: 'x', startDate: '2026-10-20', frame: 'sauna_4', guestCount: 3 };

  it('通常日は sauna_N・sauna の slot', () => {
    const r = buildSaunaTarget(req, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.planId).toBe('sauna_4');
    expect(r.value.roomIds).toEqual(['sauna']);
    expect(r.value.slots).toEqual(['sauna|2026-10-20|17', 'sauna|2026-10-20|18', 'sauna|2026-10-20|19']);
    expect(r.value.serviceDates).toEqual(['2026-10-20']);
  });

  it('ふたみの日は plan_sauna_futami・sauna_share の slot（同じ時間）', () => {
    const r = buildSaunaTarget(req, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.planId).toBe('plan_sauna_futami');
    expect(r.value.roomIds).toEqual(['sauna_share']);
    expect(r.value.slots).toEqual([
      'sauna_share|2026-10-20|17', 'sauna_share|2026-10-20|18', 'sauna_share|2026-10-20|19',
    ]);
  });

  it('ふたみの日は1人では入れない（createReservation と同じ 2〜8人）', () => {
    const r = buildSaunaTarget({ ...req, guestCount: 1 }, true);
    expect(r).toEqual({ ok: false, error: 'invalid_guest_count', detail: 'ふたみの日は2〜8人' });
  });

  it('4枠すべてが createReservation の canonicalize を通る（枠の時間が2か所でずれていない）', () => {
    for (const frame of Object.keys(SAUNA_FRAME_HOURS)) {
      expect(buildSaunaTarget({ ...req, frame }, false).ok).toBe(true);
      expect(buildSaunaTarget({ ...req, frame, guestCount: 2 }, true).ok).toBe(true);
    }
  });
});

describe('oppositeSaunaKeys / diffSlots', () => {
  it('通常 ⇄ ふたみの日 の反対側のキー', () => {
    expect(oppositeSaunaKeys(['sauna|2026-10-20|10', 'sauna_share|2026-10-21|15']))
      .toEqual(['sauna_share|2026-10-20|10', 'sauna|2026-10-21|15']);
  });

  it('同じ枠のまま人数だけ変える時は slot を触らない', () => {
    const s = ['sauna|2026-10-20|10', 'sauna|2026-10-20|11'];
    expect(diffSlots(s, s)).toEqual({ toDelete: [], toWrite: [] });
  });

  it('枠を変える時は旧を消して新を取る', () => {
    expect(diffSlots(
      ['sauna|2026-10-20|10', 'sauna|2026-10-20|11'],
      ['sauna|2026-10-20|12', 'sauna|2026-10-20|13', 'sauna|2026-10-20|14'],
    )).toEqual({
      toDelete: ['sauna|2026-10-20|10', 'sauna|2026-10-20|11'],
      toWrite: ['sauna|2026-10-20|12', 'sauna|2026-10-20|13', 'sauna|2026-10-20|14'],
    });
  });
});

describe('recomputeSaunaPricing', () => {
  const futami = buildSaunaTarget({ id: 'x', startDate: '2026-10-20', frame: 'sauna_1', guestCount: 5 }, true);
  const regular = buildSaunaTarget({ id: 'x', startDate: '2026-10-20', frame: 'sauna_1', guestCount: 5 }, false);
  if (!futami.ok || !regular.ok) throw new Error('setup');

  it('職員が作った予約（pricing=null）は null のまま＝市民区分が分からない金額を埋めない', () => {
    expect(recomputeSaunaPricing({ pricing: null }, regular.value, 5)).toBeNull();
  });

  it('公開画面の予約はオプションを引き継いで計算し直す（ふたみの日は人数で変わる）', () => {
    const cur = { pricing: { total: 4600, saunaOptions: { towels: 0, tarpTent: 0, ice20kg: 0 } } };
    const p = recomputeSaunaPricing(cur, futami.value, 5);
    expect(p.total).toBe(2300 * 5);
  });

  it('通常日の貸切は人数に関係なく 13,200円＋オプション', () => {
    const cur = { pricing: { total: 13200, saunaOptions: { towels: 0, tarpTent: 0, ice20kg: 0 } } };
    expect(recomputeSaunaPricing(cur, regular.value, 3).total).toBe(13200);
  });
});

describe('配線（handler）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/handlers/changeSaunaReservation.ts'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');

  it('職員認証を通している', () => {
    expect(src).toMatch(/requireStaffAuth\(req, res\)/);
  });

  it('書込みはトランザクション内だけ（★3）', () => {
    expect(src).toMatch(/db\.runTransaction/);
    expect(src).not.toMatch(/\.add\(|db\.collection\([^)]*\)\.doc\([^)]*\)\.(set|update|delete)\(/);
  });

  it('index.ts は re-export だけ（★1）', () => {
    expect(index).toMatch(/export \{ changeSaunaReservation \} from '\.\/handlers\/changeSaunaReservation';/);
  });
});
