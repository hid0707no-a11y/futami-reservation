// ふたみ予約システム 定数 SSOT
//
// 2026-05-05 新設（/gfu Phase A-3）。
// 機能追加で文字列が散在しないための中央集約。今後の B-1（市川さん発注予定）の handlers/services/repositories
// 分割時に、ここから import する形で使用する。
//
// ★ index.ts の既存 inline 定数（VALID_ROOM_IDS / SHEET_HEADERS / 'confirmed'/'cancelled' 文字列）は
//    Phase B 着手まで触らない（A-2 の E2E テストが緑になるまで本体改修禁止）。

// ─────────────────────────────────────────────
// 予約ステータス
// ─────────────────────────────────────────────
export const RESERVATION_STATUS = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
} as const;
export type ReservationStatus = typeof RESERVATION_STATUS[keyof typeof RESERVATION_STATUS];

// ─────────────────────────────────────────────
// Firestore コレクション名
// ─────────────────────────────────────────────
export const COLLECTIONS = {
  RESERVATIONS: 'reservations',
  SLOTS: 'slots',                   // 通常室・キャンプ場（個別区画）
  TENNIS_SLOTS: 'tennis_slots',
  SHARED_SLOTS: 'shared_slots',     // 共有スロット（双海の日 等）
  AUDIT_LOG: 'audit_log',
  IDEMPOTENCY_KEYS: 'idempotency_keys',
  SCHEMA_MIGRATIONS: 'schema_migrations',  // 2026-05-05 Phase A-1 新設
  CONFIG_BUSINESS_CALENDAR: 'config/business_calendar',
  CONFIG_SPECIAL_DAYS: 'config/special_days',
} as const;

// ─────────────────────────────────────────────
// 部屋・施設ID（VALID_ROOM_IDS の SSOT）
// ─────────────────────────────────────────────
// 2026-04-28: shared_slots → camp_1〜camp_8 個別管理に移行（migration 002）
export const ROOM_IDS = {
  ROOMS: ['room_27', 'room_6_1', 'room_6_2', 'room_6_3', 'room_6_4',
          'room_exp', 'room_train', 'room_kitchen'],
  TENNIS_COURTS: ['court_1', 'court_2', 'court_3', 'court_4', 'court_5'],
  // 壁打ち練習用の半面コート。コートA〜Eとは別の独立施設（公式サイト施設案内・料金表【R8】別行）。
  // tennis_half 専用在庫。court_ 接頭辞なので tennis_slots 排他系に自動で乗る。
  TENNIS_WALL: ['court_wall'],
  CAMPS: ['camp_1', 'camp_2', 'camp_3', 'camp_4', 'camp_5', 'camp_6', 'camp_7', 'camp_8'],
  LODGES: ['lodge_a', 'lodge_b'],
  OTHERS: ['midori', 'sauna', 'sauna_share'],
} as const;

export const VALID_ROOM_IDS = new Set<string>([
  ...ROOM_IDS.ROOMS,
  ...ROOM_IDS.TENNIS_COURTS,
  ...ROOM_IDS.TENNIS_WALL,
  ...ROOM_IDS.CAMPS,
  ...ROOM_IDS.LODGES,
  ...ROOM_IDS.OTHERS,
]);

// ─────────────────────────────────────────────
// SHEET_HEADERS（Google Sheets 同期）
// ─────────────────────────────────────────────
// 2026-05-13: SSOT を `lib/sheets.ts` に一本化。本ファイルは re-export のみ。
// 旧 legacy 定義（重複コピー）は dead code 化していた（誰も import していなかった）ため削除。
// 列追加・順序変更時は `lib/sheets.ts` の SHEET_HEADERS だけ更新すれば全箇所に伝播する。
//
// 変更履歴：
//  - 2026-04-27: 郵便番号 / 住所 を追加（commit 856c194・25列）
//  - 2026-05-05: clear範囲を A:Y に限定（運営の Z列以降のメモを保護）
//  - 2026-05-13: 「予約番号」(displayId) を末尾に追加（26列・A:Z 拡張）
//  - 2026-05-13: SSOT を lib/sheets.ts に一本化（本ファイルは re-export のみ）
export { SHEET_HEADERS } from './lib/sheets';

// SHEET_HEADERS の長さに対応するスプシ列レンジ（27列なら A:AA）。
// 列を増やす時は SHEET_HEADERS 拡張＋このレンジを同期更新する。
// services/sheetsSync.ts のハードコード値もこの定数を import するよう統一済（2026-05-13）。
// ★実際に clear/update の範囲を決めているのはこの定数だけ。下の SYNC_CLEAR_RANGE_* は
//   定義だけで参照されていない（sheetsSync.ts は SHEET_LAST_COLUMN を引数で受け取る）。
//   ここを直し忘れると、増やした列がスプシに書かれないまま静かに落ちる。
// 2026-08-25: フリガナ列の追加で 'Z'(26列) → 'AA'(27列)。
export const SHEET_LAST_COLUMN = 'AA';
export const SYNC_CLEAR_RANGE_RESERVATIONS = `reservations!A:${SHEET_LAST_COLUMN}`;
export const SYNC_CLEAR_RANGE_CANCELLED = `cancelled!A:${SHEET_LAST_COLUMN}`;
export const SYNC_CLEAR_RANGE_META = 'meta!A:B';

// ─────────────────────────────────────────────
// 祝日テーブル（平日割のサーバ側自律判定に使用）
// ─────────────────────────────────────────────
// ★ index.html の JP_HOLIDAYS_2026_2027 と完全同期させること（毎年12月に翌々年分を追記）。
//   2026-07-20 #17 対応でサーバ側にも移植。従来のメンテ箇所（①index.html ②本 CLAUDE.md 手順
//   ③constants.ts の HOLIDAY_TABLE_END 期限）に加え、本テーブル自体が④番目のメンテ箇所になった。
//   4箇所が食い違うと「クライアントは平日割・サーバは通常料金」等の不一致（pricingMismatch）を生む。
// ★ 平日割はクライアントの割引フラグを信用せず、サーバがこのテーブル＋曜日から自律判定する（#17）。
export const JP_HOLIDAYS_2026_2027: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // 元日
  '2026-01-12', // 成人の日
  '2026-02-11', // 建国記念の日
  '2026-02-23', // 天皇誕生日
  '2026-03-20', // 春分の日
  '2026-04-29', // 昭和の日
  '2026-05-03', // 憲法記念日
  '2026-05-04', // みどりの日
  '2026-05-05', // こどもの日
  '2026-05-06', // 憲法記念日 振替休日
  '2026-07-20', // 海の日
  '2026-08-11', // 山の日
  '2026-09-21', // 敬老の日
  '2026-09-22', // 国民の休日
  '2026-09-23', // 秋分の日
  '2026-10-12', // スポーツの日
  '2026-11-03', // 文化の日
  '2026-11-23', // 勤労感謝の日
  // 2027
  '2027-01-01', // 元日
  '2027-01-11', // 成人の日
  '2027-02-11', // 建国記念の日
  '2027-02-23', // 天皇誕生日
  '2027-03-21', // 春分の日
  '2027-03-22', // 春分の日 振替休日
  '2027-04-29', // 昭和の日
  '2027-05-03', // 憲法記念日
  '2027-05-04', // みどりの日
  '2027-05-05', // こどもの日
  '2027-07-19', // 海の日
  '2027-08-11', // 山の日
  '2027-09-20', // 敬老の日
  '2027-09-23', // 秋分の日
  '2027-10-11', // スポーツの日
  '2027-11-03', // 文化の日
  '2027-11-23', // 勤労感謝の日
]);

// ─────────────────────────────────────────────
// 祝日テーブル期限（year-end-tasks）
// ─────────────────────────────────────────────
// index.html の JP_HOLIDAYS_2026_2027 / 上の JP_HOLIDAYS_2026_2027 と同期。
// staffHealthMonitor が 2027-10-01 から SMTP アラートを発火。
export const HOLIDAY_TABLE_END = '2027-12-31';
export const HOLIDAY_WARN_FROM = '2027-10-01';

// ─────────────────────────────────────────────
// レート制限既知制約
// ─────────────────────────────────────────────
// rateLimitStore: Map は単一インスタンス内ローカル。
// Cloud Functions Gen2 は同時インスタンスを増やすため、IP別カウントは共有されない。
// 冪等性キー（idempotency_keys）が最終防衛線。Firestore版(lib/rateLimitFirestore.ts)は実装済み・未配線。
export const RATE_LIMIT_KNOWN_CONSTRAINTS = {
  isInMemory: true,
  sharedAcrossInstances: false,
  finalDefenseLayer: 'idempotency_keys (Firestore)',
} as const;
