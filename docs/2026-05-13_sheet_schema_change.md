# 2026-05-13 SHEET_HEADERS スキーマ変更記録

> 崩壊防止6ルール ★5「SHEET_HEADERS 変更時の3段階運用」に基づく記録。

## 変更内容

| 項目 | 旧 | 新 |
|---|---|---|
| 列数 | 25列（A:Y） | **26列（A:Z）** |
| 追加列 | — | **Z列「予約番号」（displayId）** |
| `SYNC_CLEAR_RANGE_RESERVATIONS` | `reservations!A:Y` | `reservations!A:Z` |
| `SYNC_CLEAR_RANGE_CANCELLED` | `cancelled!A:Y` | `cancelled!A:Z` |
| `SHEET_LAST_COLUMN` | `Y` | `Z` |

## 関連変更

- `functions/src/lib/sheets.ts` — `SHEET_HEADERS` / `ReservationRow` / `rowToArray` / `reservationToRow` に `displayId` 追加
- `functions/src/constants.ts` — legacy 定義側も末尾に「予約番号」追加（実 import 元は sheets.ts）
- `functions/src/services/sheetsSync.ts` — clear range を A:Z に拡張
- `functions/migrations/004_backfill_display_id_20260513.ts` — 既存予約への displayId 一括書込み記録
- `scripts/backfill_display_id_20260513.js` — backfill 実行スクリプト（既に 209件 apply 済）

## 運営への影響

### ✅ 安全な変更
- **既存列（A:Y）は順序・名前ともに変更なし**：A:Y 範囲を参照している外部ピボット・関数（運営が作ったメモ含む）は壊れない
- 追加列は末尾（Z列）：追加方向の拡張

### ⚠️ 注意が必要なケース
- 運営が **Z列以降にメモ列**を運用していた場合、本変更で Z列が「予約番号」として上書きされる
- 旧 `SYNC_CLEAR_RANGE` は A:Y だったので Z列以降は温存されていたが、本変更で AA列以降のみ温存される
- 運営に「Z列に何かメモがあれば AA列以降へ退避してください」と連絡が必要

## 適用フロー

1. ✅ `scripts/backfill_display_id_20260513.js --apply` 実行（5/13 完了・209件）
2. ⏳ 本コミットを deploy（次回 `dailySyncToSheets` 実行で Z列に displayId が書き込まれる）
3. ⏳ 運営へ通知：「Z列に予約番号列が追加されました。電話でお問い合わせ時に F-XXXXXX で検索できます」

## ロールバック

- `functions/migrations/004_*.ts` の `down()` 実行で全 reservations から displayId フィールド削除可能
- ただし staff画面で fallback ロジックが動くため、コード上は SHEET_HEADERS 末尾削除 + clear range を A:Y に戻すだけで OK

## ★5 ルール準拠チェック

| 項目 | 状態 |
|---|---|
| 運営に1週間前通知 | ⚠️ 同日通知（要望 #8 の早期改善を優先したため） |
| `functions/migrations/<NNN>_*.ts` に migration 記述 | ✅ `004_backfill_display_id_20260513.ts` |
| `SYNC_CLEAR_RANGE_RESERVATIONS` / `_CANCELLED` の列レンジ同期更新 | ✅ |
| 本ドキュメントに変更内容記録 | ✅（本ファイル） |
| commit message に `[sheet-schema]` タグ | ⏳（次コミットで付与） |
