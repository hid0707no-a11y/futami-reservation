// 顧客向け表示ラベル（メール等）。
//
// 背景（2026-07-22 tennis_half 復活時に新設）:
// 確認メール/職員通知メールは planName / roomName を生ID（例: tennis_full / court_1）の
// まま本文に載せていた。顧客が読む文面なので、ここで日本語ラベルへ解決する。
// 未知IDはフォールバックで生IDのまま返す（送信自体は止めない）。
//
// 表示名の正本は index.html の PLANS / ROOMS 配列。列挙を変えたらここも追随すること。

export const PLAN_LABELS: Readonly<Record<string, string>> = {
  stay_6: '宿泊（6畳）',
  stay_27: '宿泊（27畳）',
  stay_exp: '宿泊（体験学習室）',
  stay_all: '全室貸切パック',
  day_6_all: '日帰り通し（6畳）',
  day_27_am: '日帰り午前（27畳）',
  day_27_pm: '日帰り午後（27畳）',
  day_27_eve: '日帰り夜間（27畳）',
  day_27_daytime: '日帰り日中（27畳）',
  day_27_all: '日帰り通し（27畳）',
  day_exp_am: '日帰り午前（体験学習室）',
  day_exp_pm: '日帰り午後（体験学習室）',
  day_exp_eve: '日帰り夜間（体験学習室）',
  day_exp_daytime: '日帰り日中（体験学習室）',
  day_exp_all: '日帰り通し（体験学習室）',
  day_train_am: '日帰り午前（研修室）',
  day_train_pm: '日帰り午後（研修室）',
  day_train_eve: '日帰り夜間（研修室）',
  day_train_daytime: '日帰り日中（研修室）',
  day_train_all: '日帰り通し（研修室）',
  day_kitchen: '日帰り通し（厨房・食堂）',
  camp_stay: 'キャンプ泊',
  lodge_stay: 'ロッジ宿泊',
  lodge_day: 'ロッジ日帰り',
  tennis: 'テニスコート（一面貸切）', // 旧planId（canonicalize前）保険
  tennis_full: 'テニスコート（一面貸切）',
  tennis_half: '半面コート（壁打ち練習用）',
  // 2026-08-25 運営要望⑤：みどりの広場は時間帯が名前から読めなかったので括弧書きで併記する。
  // 表記は運営承認済み（午前 8:30〜12:00 / 午後 12:00〜17:00 / 日中 8:30〜17:00 / 夜間 17:00〜22:00）。
  midori_am: 'みどりの広場 午前（8:30〜12:00）',
  midori_pm: 'みどりの広場 午後（12:00〜17:00）',
  midori_day: 'みどりの広場 日中（8:30〜17:00）',
  midori_eve: 'みどりの広場 夜間（17:00〜22:00）',
  sauna_1: '貸切サウナ A（10:00-12:00）',
  sauna_2: '貸切サウナ B（12:30-14:30）',
  sauna_3: '貸切サウナ C（15:00-17:00）',
  sauna_4: '貸切サウナ D（17:30-19:30）',
  plan_sauna_futami: '貸切サウナ（ふたみの日）',
};

export const ROOM_LABELS: Readonly<Record<string, string>> = {
  room_27: '1号室（大部屋・27畳）',
  room_6_1: '2号室（6畳）',
  room_6_2: '3号室（6畳）',
  room_6_3: '5号室（6畳）',
  room_6_4: '6号室（6畳）',
  room_exp: '体験学習室（25畳）',
  room_train: '研修室',
  room_kitchen: '厨房・食堂',
  camp_1: 'キャンプ区画①',
  camp_2: 'キャンプ区画②',
  camp_3: 'キャンプ区画③',
  camp_4: 'キャンプ区画④',
  camp_5: 'キャンプ区画⑤',
  camp_6: 'キャンプ区画⑥',
  camp_7: 'キャンプ区画⑦',
  camp_8: 'キャンプ区画⑧',
  lodge_a: 'ロッジA',
  lodge_b: 'ロッジB',
  court_1: 'テニスコートA',
  court_2: 'テニスコートB',
  court_3: 'テニスコートC',
  court_4: 'テニスコートD',
  court_5: 'テニスコートE',
  court_wall: '半面コート（壁打ち練習用）',
  midori: 'みどりの広場',
  sauna: 'サンセットサウナ',
  sauna_share: 'サンセットサウナ（ふたみの日）',
};

export function planLabel(planId: unknown): string {
  return (typeof planId === 'string' && PLAN_LABELS[planId]) || String(planId ?? '');
}

export function roomLabel(roomId: unknown): string {
  return (typeof roomId === 'string' && ROOM_LABELS[roomId]) || String(roomId ?? '');
}

export function roomLabels(roomIds: unknown): string {
  if (!Array.isArray(roomIds)) return '';
  return roomIds.map(roomLabel).join('、');
}

/**
 * テニス canonical slots（`court|date|HHMM` の30分ペア列）を人が読む時刻帯へ整形する。
 * 例: [0800,0830,0900,0930, 1300,1330] → 「08:00〜10:00、13:00〜14:00」
 * 連続する30分スロットは1つの帯にまとめる。不正形式は黙って無視（メールを止めない）。
 */
export function formatTennisTimeRanges(slots: unknown): string {
  if (!Array.isArray(slots)) return '';
  const minutes = new Set<number>();
  for (const slot of slots) {
    if (typeof slot !== 'string') continue;
    const time = slot.split('|')[2];
    if (!/^\d{4}$/.test(time || '')) continue;
    const h = Number(time.slice(0, 2));
    const m = Number(time.slice(2, 4));
    if (m !== 0 && m !== 30) continue;
    minutes.add(h * 60 + m);
  }
  if (minutes.size === 0) return '';
  const sorted = Array.from(minutes).sort((a, b) => a - b);
  const fmt = (t: number) =>
    `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 30) {
      prev = cur;
      continue;
    }
    ranges.push(`${fmt(start)}〜${fmt(prev + 30)}`);
    if (cur === undefined) break;
    start = cur;
    prev = cur;
  }
  return ranges.join('、');
}
