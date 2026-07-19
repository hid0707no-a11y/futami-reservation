import { canonicalizeReservation } from '../src/lib/reservationPlans';

const STAY_HOURS = [16,17,18,19,20,21,22,23,0,1,2,3,4,5,6,7,8,9];
const CAMP_HOURS = [14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5,6,7,8,9,10,11,12];
const ALL_STAY_ROOMS = ['room_6_1','room_6_2','room_6_3','room_6_4','room_27','room_exp'];

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fixedSlots(roomIds: string[], date: string, hours: number[]): string[] {
  return roomIds.flatMap(roomId => hours.map(hour => roomId + '|' + date + '|' + hour));
}

function overnightSlots(roomIds: string[], start: string, nights: number, hours: number[]): string[] {
  const checkinHour = hours[0];
  return roomIds.flatMap(roomId =>
    Array.from({ length: nights }, (_, night) =>
      hours.map(hour => roomId + '|' + addDays(start, night + (hour < checkinHour ? 1 : 0)) + '|' + hour),
    ).flat(),
  );
}

describe('canonicalizeReservation', () => {
  it.each(['__proto__', 'constructor', 'toString'])('継承プロパティ名planId %sを500にせず拒否する', planId => {
    expect(canonicalizeReservation({
      planId,
      roomIds: ['room_27'], slots: ['room_27|2026-08-05|8'],
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    })).toEqual({ ok: false, error: 'invalid_planId' });
  });

  it('固定日帰りは定義された全slotだけをcanonical化する', () => {
    const result = canonicalizeReservation({
      planId: 'day_27_am',
      roomIds: ['room_27'],
      slots: fixedSlots(['room_27'], '2026-08-05', [8,9,10,11]),
      startDate: '2026-08-05',
      endDate: '2026-08-05',
      nights: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nights).toBe(0);
      expect(result.value.serviceDates).toEqual(['2026-08-05']);
    }
  });

  it('旧日帰りのnights=1/end=翌日は受理するが保存値を同日に直す', () => {
    const result = canonicalizeReservation({
      planId: 'midori_am',
      roomIds: ['midori'],
      slots: fixedSlots(['midori'], '2026-08-05', [8,9,10,11]),
      startDate: '2026-08-05',
      endDate: '2026-08-06',
      nights: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.endDate).toBe('2026-08-05');
      expect(result.value.nights).toBe(0);
    }
  });

  it.each([
    ['slot欠落', [8,9,10]],
    ['slot追加', [8,9,10,11,12]],
  ])('固定プランの%sを拒否する', (_label, hours) => {
    const result = canonicalizeReservation({
      planId: 'day_27_am',
      roomIds: ['room_27'],
      slots: fixedSlots(['room_27'], '2026-08-05', hours as number[]),
      startDate: '2026-08-05',
      endDate: '2026-08-05',
      nights: 0,
    });
    expect(result).toEqual({ ok: false, error: 'plan_slot_mismatch' });
  });

  it('2泊は全slotを再導出しserviceDatesに中間宿泊日を含める', () => {
    const slots = overnightSlots(['room_27'], '2026-08-05', 2, STAY_HOURS);
    const result = canonicalizeReservation({
      planId: 'stay_27', roomIds: ['room_27'], slots,
      startDate: '2026-08-05', endDate: '2026-08-07', nights: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slots).toHaveLength(36);
      expect(result.value.serviceDates).toEqual(['2026-08-05', '2026-08-06']);
    }
  });

  it('宿泊の中間slotを1件でも省略すると拒否する', () => {
    const slots = overnightSlots(['room_27'], '2026-08-05', 2, STAY_HOURS);
    slots.splice(20, 1);
    expect(canonicalizeReservation({
      planId: 'stay_27', roomIds: ['room_27'], slots,
      startDate: '2026-08-05', endDate: '2026-08-07', nights: 2,
    })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
  });

  it.each([-1, 0, 1.5, '2', 15])('宿泊の不正泊数 %p を拒否する', nights => {
    const result = canonicalizeReservation({
      planId: 'stay_27', roomIds: ['room_27'], slots: ['room_27|2026-08-05|16'],
      startDate: '2026-08-05', endDate: '2026-08-06', nights,
    });
    expect(result).toEqual({ ok: false, error: 'invalid_nights' });
  });

  it('全室貸切は6室すべてと全slotが必須', () => {
    const valid = canonicalizeReservation({
      planId: 'stay_all',
      roomIds: ALL_STAY_ROOMS,
      slots: overnightSlots(ALL_STAY_ROOMS, '2026-08-05', 1, STAY_HOURS),
      startDate: '2026-08-05', endDate: '2026-08-06', nights: 1,
    });
    expect(valid.ok).toBe(true);
    expect(canonicalizeReservation({
      planId: 'stay_all',
      roomIds: ALL_STAY_ROOMS.slice(0, 5),
      slots: overnightSlots(ALL_STAY_ROOMS.slice(0, 5), '2026-08-05', 1, STAY_HOURS),
      startDate: '2026-08-05', endDate: '2026-08-06', nights: 1,
    })).toEqual({ ok: false, error: 'plan_room_mismatch', detail: 'all_rooms_required' });
  });

  it('キャンプ3泊は10〜12時も各チェックアウト日へ送る', () => {
    const slots = overnightSlots(['camp_1','camp_2'], '2026-08-05', 3, CAMP_HOURS);
    const result = canonicalizeReservation({
      planId: 'camp_stay', roomIds: ['camp_1','camp_2'], slots,
      startDate: '2026-08-05', endDate: '2026-08-08', nights: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slots).toContain('camp_1|2026-08-06|12');
      expect(result.value.slots).not.toContain('camp_1|2026-08-05|12');
    }
  });

  it('キャンプ4区画または4泊を拒否する', () => {
    expect(canonicalizeReservation({
      planId: 'camp_stay',
      roomIds: ['camp_1','camp_2','camp_3','camp_4'],
      slots: ['camp_1|2026-08-05|14'],
      startDate: '2026-08-05', endDate: '2026-08-06', nights: 1,
    })).toEqual({ ok: false, error: 'plan_room_mismatch' });
    expect(canonicalizeReservation({
      planId: 'camp_stay', roomIds: ['camp_1'],
      slots: overnightSlots(['camp_1'], '2026-08-05', 4, CAMP_HOURS),
      startDate: '2026-08-05', endDate: '2026-08-09', nights: 4,
    })).toEqual({ ok: false, error: 'invalid_nights' });
  });

  it('ロッジ日帰りはv2かつ選択した許可時間だけを受理する', () => {
    const base = {
      planId: 'lodge_day', roomIds: ['lodge_a'],
      slots: fixedSlots(['lodge_a'], '2026-08-05', [10,12,15]),
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    };
    expect(canonicalizeReservation(base)).toEqual({
      ok: false, error: 'client_update_required', detail: 'lodge_day_inventory_v2',
    });
    const result = canonicalizeReservation({ ...base, inventoryVersion: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.slots).toEqual(base.slots);
  });

  it('テニスHHMMを受理し旧tennis整数時をtennis_fullへ変換する', () => {
    const current = canonicalizeReservation({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|2026-08-05|0830', 'court_1|2026-08-05|0900'],
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    });
    expect(current.ok).toBe(true);

    const legacy = canonicalizeReservation({
      planId: 'tennis', roomIds: ['court_1'], slots: ['court_1|2026-08-05|8'],
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.value.planId).toBe('tennis_full');
      expect(legacy.value.slots).toEqual([
        'court_1|2026-08-05|0800',
        'court_1|2026-08-05|0830',
      ]);
    }
  });

  it('複数テニスコートで時間集合が違う場合と未ペアslotを拒否する', () => {
    expect(canonicalizeReservation({
      planId: 'tennis_full', roomIds: ['court_1','court_2'],
      slots: [
        'court_1|2026-08-05|0800', 'court_1|2026-08-05|0830',
        'court_2|2026-08-05|0900', 'court_2|2026-08-05|0930',
      ],
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
    expect(canonicalizeReservation({
      planId: 'tennis_full', roomIds: ['court_1'],
      slots: ['court_1|2026-08-05|0800'],
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
  });

  // 2026-07-20: 半面プラン復活（要望#11の真意は「削除」ではなく「コートを1面に絞る」）
  describe('tennis_half（半面・1面構成）', () => {
    it('court_1 の正しい30分ペアを受理する', () => {
      const result = canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1'],
        slots: ['court_1|2026-08-05|0900', 'court_1|2026-08-05|0930'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.planId).toBe('tennis_half');
        expect(result.value.kind).toBe('tennis');
        expect(result.value.roomIds).toEqual(['court_1']);
        expect(result.value.slots).toEqual([
          'court_1|2026-08-05|0900',
          'court_1|2026-08-05|0930',
        ]);
      }
    });

    it('court_1 以外のコートは拒否する（1面構成の要）', () => {
      for (const room of ['court_2', 'court_3', 'court_4', 'court_5']) {
        expect(canonicalizeReservation({
          planId: 'tennis_half', roomIds: [room],
          slots: [`${room}|2026-08-05|0900`, `${room}|2026-08-05|0930`],
          startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
        })).toEqual({ ok: false, error: 'plan_room_mismatch' });
      }
    });

    it('複数コートの同時指定を拒否する（maxRooms=1）', () => {
      expect(canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1', 'court_2'],
        slots: [
          'court_1|2026-08-05|0900', 'court_1|2026-08-05|0930',
          'court_2|2026-08-05|0900', 'court_2|2026-08-05|0930',
        ],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      })).toEqual({ ok: false, error: 'plan_room_mismatch' });
    });

    it('未ペア slot・範囲外時刻・日付ずれを拒否する', () => {
      // 30分1枠だけ（1時間ペアになっていない）
      expect(canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1'],
        slots: ['court_1|2026-08-05|0900'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
      // 営業時間外（22:00 開始）
      expect(canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1'],
        slots: ['court_1|2026-08-05|2200', 'court_1|2026-08-05|2230'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
      // slot の日付が startDate と違う
      expect(canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1'],
        slots: ['court_1|2026-08-06|0900', 'court_1|2026-08-06|0930'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
    });

    it('半面と全面は同じ slot キー空間を使う（同一コート同時間の二重予約が起きない）', () => {
      const half = canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1'],
        slots: ['court_1|2026-08-05|0900', 'court_1|2026-08-05|0930'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      });
      const full = canonicalizeReservation({
        planId: 'tennis_full', roomIds: ['court_1'],
        slots: ['court_1|2026-08-05|0900', 'court_1|2026-08-05|0930'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      });
      expect(half.ok && full.ok).toBe(true);
      if (half.ok && full.ok) expect(half.value.slots).toEqual(full.value.slots);
    });

    it('旧整数時フォーマットは tennis_half では受理しない（planId=tennis のみの互換）', () => {
      expect(canonicalizeReservation({
        planId: 'tennis_half', roomIds: ['court_1'],
        slots: ['court_1|2026-08-05|9'],
        startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
      })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
    });
  });

  it('ふたみの日サウナは定義4ブロックのいずれかだけを受理する', () => {
    const valid = canonicalizeReservation({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots(['sauna_share'], '2026-08-05', [12,13,14]),
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    });
    expect(valid.ok).toBe(true);
    expect(canonicalizeReservation({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'],
      slots: fixedSlots(['sauna_share'], '2026-08-05', [11,12]),
      startDate: '2026-08-05', endDate: '2026-08-05', nights: 0,
    })).toEqual({ ok: false, error: 'plan_slot_mismatch' });
  });
});
