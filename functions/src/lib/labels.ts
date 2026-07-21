// 予約ID → 人が読めるラベル（日本語表記）
//
// 2026-07-21 新設。
// 背景：確認メール／キャンセルメール／職員通知メールが planId / roomIds を
// そのまま出力しており、顧客の控えに「プラン：tennis_half」「施設：court_wall」と
// 英数字 ID が届いていた（半面プランの在庫是正レビューで検出）。
// functions/src 配下に日本語ラベル表が1つも無く、日本語名は index.html / staff.html の
// フロントにしか存在しなかったため、サーバ側の SSOT としてここに写す。
//
// ★同期ルール（重要）
//   ここの文字列は **創作せず** index.html の ROOMS[].name / PLANS[].name を写したもの。
//   index.html（および staff.html）の name を変更したら本ファイルも更新すること。
//   ズレは functions/tests/labels.test.ts が index.html を実読みして検出する
//   （テストが落ちる＝どちらかが片側だけ変わった、という意味）。
//
// ★fail-visible 方針
//   未知の ID は空文字やクラッシュにせず **ID をそのまま返す**。
//   ラベル漏れが「プラン：新ID」という形で目に見えて残り、静かに消えない。

/**
 * 施設（room）ID → 日本語名。
 * 出典：index.html の `const ROOMS = [...]` の `name` フィールド（staff.html の ROOMS と一致）。
 *
 * ★要確認（未収録の ID）
 *   - `sauna_share`（ふたみの日サウナの共有在庫）は index.html の ROOMS に定義が無い。
 *     創作せず未収録とし、ID がそのまま出る（＝従来と同じ表示）。
 *     ふたみの日サウナの新規予約メールは createReservation.ts が施設名を直接指定するため、
 *     実際に ID が出るのはキャンセルメールのみ。日本語名は運営に要確認。
 */
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
  court_1: 'コートA',
  court_2: 'コートB',
  court_3: 'コートC',
  court_4: 'コートD',
  court_5: 'コートE',
  // 壁打ち練習用の半面コート（コートA〜Eの5面とは別の独立施設・2026-07-21）
  court_wall: '半面コート（壁打ち練習用）',
  midori: 'みどりの広場',
  sauna: 'サンセットサウナ',
};

/**
 * プラン（plan）ID → 日本語名。
 * 出典：index.html の `const PLANS = [...]` の `name` フィールド。
 *
 * ★要確認（未収録の ID）
 *   - `plan_sauna_futami`（ふたみの日サウナ）は index.html の PLANS に定義が無く、
 *     送信時に生成される合成 ID（index.html:4022 / staff.html:2273）。日本語名が
 *     フロントのどこにも無いため創作せず未収録とし、ID がそのまま出る（＝従来と同じ表示）。
 *     正式なプラン表記は運営に要確認。
 */
export const PLAN_LABELS: Readonly<Record<string, string>> = {
  stay_6: '宿泊（6畳）',
  stay_27: '宿泊（27畳）',
  stay_exp: '宿泊（体験学習室）',
  stay_all: '全室貸切パック（最大52名）',
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
  tennis_full: 'テニスコート（一面貸切）',
  tennis_half: 'テニスコート（半面・練習用）',
  midori_am: 'みどりの広場 午前',
  midori_pm: 'みどりの広場 午後',
  midori_day: 'みどりの広場 日中',
  midori_eve: 'みどりの広場 夜間',
  sauna_1: 'A 10:00-12:00',
  sauna_2: 'B 12:30-14:30',
  sauna_3: 'C 15:00-17:00',
  sauna_4: 'D 17:30-19:30',
};

/** プロトタイプ汚染を避けつつ own property だけを引く。未知なら null。 */
function lookup(table: Readonly<Record<string, string>>, id: unknown): string | null {
  if (typeof id !== 'string' || id === '') return null;
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
}

/** 施設ID → 日本語名。未知の ID は ID をそのまま返す（fail-visible）。空・非文字列は ''。 */
export function roomLabel(roomId: unknown): string {
  const hit = lookup(ROOM_LABELS, roomId);
  if (hit !== null) return hit;
  return typeof roomId === 'string' ? roomId : '';
}

/** プランID → 日本語名。未知の ID は ID をそのまま返す（fail-visible）。空・非文字列は ''。 */
export function planLabel(planId: unknown): string {
  const hit = lookup(PLAN_LABELS, planId);
  if (hit !== null) return hit;
  return typeof planId === 'string' ? planId : '';
}

/**
 * 施設ID配列 → '半面コート（壁打ち練習用）' / 'コートA・コートB' のような1行表記。
 * 配列でない・空・全要素が空文字なら ''（メール側で施設行が空になるだけでクラッシュしない）。
 */
export function formatRoomLabels(roomIds: unknown): string {
  if (!Array.isArray(roomIds)) return '';
  return roomIds
    .map(id => roomLabel(id))
    .filter(label => label !== '')
    .join('・');
}
