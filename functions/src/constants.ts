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
  CAMPS: ['camp_1', 'camp_2', 'camp_3', 'camp_4', 'camp_5', 'camp_6', 'camp_7', 'camp_8'],
  LODGES: ['lodge_a', 'lodge_b'],
  OTHERS: ['midori', 'sauna', 'sauna_share'],
} as const;

export const VALID_ROOM_IDS = new Set<string>([
  ...ROOM_IDS.ROOMS,
  ...ROOM_IDS.TENNIS_COURTS,
  ...ROOM_IDS.CAMPS,
  ...ROOM_IDS.LODGES,
  ...ROOM_IDS.OTHERS,
]);

// ─────────────────────────────────────────────
// SHEET_HEADERS（Google Sheets 同期）
// ─────────────────────────────────────────────
// 列を追加・順序変更する場合は同時に SYNC_CLEAR_RANGE_RESERVATIONS / SYNC_CLEAR_RANGE_CANCELLED の
// 列レンジ（A:Y）も更新する必要がある（25列 → 列が増えたら A:Z 等に拡張）。
// 直近の変更履歴：
//  - 2026-04-27: 郵便番号 / 住所 を追加（commit 856c194・25列）
//  - 2026-05-05: clear範囲を A:Y に限定（運営の Z列以降のメモを保護）
export const SHEET_HEADERS = [
  '予約ID', '登録日時', 'ステータス', 'プランID', '部屋ID',
  '利用開始日', '利用終了日', '泊数', '時間帯',
  'お名前', '電話番号', 'メール', '郵便番号', '住所',
  '大人', '小学生', '未就学児', '利用予定人数(目安)',
  '合計金額', '照明料金', '平日割適用枠数',
  '市民区分', '予約経路', 'サウナオプション', '備考',
] as const;

// SHEET_HEADERS の長さに対応するスプシ列レンジ（25列なら A:Y）。
// 列を増やす時は SHEET_HEADERS 拡張＋このレンジを A:Z 等に同期更新する。
export const SHEET_LAST_COLUMN = 'Y';
export const SYNC_CLEAR_RANGE_RESERVATIONS = `reservations!A:${SHEET_LAST_COLUMN}`;
export const SYNC_CLEAR_RANGE_CANCELLED = `cancelled!A:${SHEET_LAST_COLUMN}`;
export const SYNC_CLEAR_RANGE_META = 'meta!A:B';

// ─────────────────────────────────────────────
// 祝日テーブル期限（year-end-tasks）
// ─────────────────────────────────────────────
// index.html の JP_HOLIDAYS_2026_2027 と同期。
// staffHealthMonitor が 2027-10-01 から SMTP アラートを発火。
export const HOLIDAY_TABLE_END = '2027-12-31';
export const HOLIDAY_WARN_FROM = '2027-10-01';

// ─────────────────────────────────────────────
// レート制限既知制約
// ─────────────────────────────────────────────
// rateLimitStore: Map は単一インスタンス内ローカル。
// Cloud Functions Gen2 は同時インスタンスを増やすため、IP別カウントは共有されない。
// 冪等性キー（idempotency_keys）が最終防衛線。Phase A で Firestore 移行予定。
export const RATE_LIMIT_KNOWN_CONSTRAINTS = {
  isInMemory: true,
  sharedAcrossInstances: false,
  finalDefenseLayer: 'idempotency_keys (Firestore)',
} as const;
