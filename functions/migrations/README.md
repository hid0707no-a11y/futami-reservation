# Firestore Migration 管理

> 2026-05-05 新設（/gfu Phase A-1）。Firestore のスキーマ変更履歴をコード化＋追跡する仕組み。

## 役割
- Firestore スキーマ変更（コレクション追加・フィールド追加・データ移行・廃止）を**連番ファイル**で管理する
- 「いつ何を変えたか」が `git log` だけでなく `migrations/` ディレクトリと `schema_migrations` コレクションの両方で追跡できる

## 命名規則
```
NNN_<short_description>_<YYYYMMDD>.ts
```
- `NNN`：3桁連番（001, 002, ...）
- `<short_description>`：snake_case
- `<YYYYMMDD>`：適用予定日

例：`004_add_payment_status_field_20260801.ts`

## 1ファイルの構造（テンプレ）

```typescript
// migrations/NNN_xxx.ts
import * as admin from 'firebase-admin';

export const META = {
  id: 'NNN_xxx',
  description: '何を変えたか1行',
  appliedDate: '2026-MM-DD',
  reversible: true | false,
};

/** dry-run でも apply でも実行内容を返すだけ。 */
export async function up(db: admin.firestore.Firestore, opts: { dryRun: boolean }) {
  // 変更ロジック
}

export async function down(db: admin.firestore.Firestore, opts: { dryRun: boolean }) {
  // 可能ならロールバック
}
```

## 適用履歴の追跡

Firestore に `schema_migrations` コレクションを設け、適用済 migration の id・適用日時・実行者を記録する：

```
schema_migrations/{migration_id}
  - id: "001_initial_schema"
  - appliedAt: Timestamp
  - appliedBy: "hid0707no-a11y"
  - notes: "..."
```

`runMigrations()` 系のランナーは Phase B-1（市川さん発注予定）で実装。

## 適用フロー（Phase A 暫定）
ランナー実装前は以下を手動で守る：

1. 新 migration ファイルを `migrations/NNN_*.ts` として作成
2. dry-run スクリプトで実行内容を確認（`scripts/run_migration.js NNN --dry-run`）
3. social/staff レビュー後、`--apply` で本番適用
4. Firestore Console で `schema_migrations/{id}` ドキュメントを手動作成（`appliedAt`/`appliedBy`/`notes`）
5. `MIGRATIONS.md` を更新

## 既存履歴（過去 migration）

過去の migration 群は `/Users/hid07/futami-reservation/scripts/` 直下に historical reference として残置：

| ID | ファイル | 適用日 | 内容 |
|---|---|---|---|
| 001 | `scripts/patch_camp_migration_20260426.js` | 2026-04-26 | キャンプ予約の補正パッチ |
| 002 | `scripts/migrate_camp_to_individual_sites_20260428.js` | 2026-04-28 | キャンプ shared_slots → camp_1〜8 個別管理 |
| 003 | `scripts/clear_legacy_camp_shared_slots_20260428.js` | 2026-04-28 | 旧 shared_slots/camp|... ドキュメント削除 |

これら3本は **historical reference**（再実行不要・冪等skip設計）として `scripts/` に残す。次の migration（004〜）から `functions/migrations/` 配下に新規作成する。

## ★絶対ルール
- ALTER 相当の変更（フィールド追加・型変更・コレクション削除）を `index.ts` 起動時にこっそり混ぜるのは**禁止**
- すべて `migrations/` 経由で履歴に残す
- 過去 migration の編集は禁止（適用済のため。修正したいなら新 migration を切る）
