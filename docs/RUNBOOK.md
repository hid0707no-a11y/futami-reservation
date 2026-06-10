# ふたみ予約システム RUNBOOK

> 2026-05-13 新設（運用ハーネス監査の指摘対応）。本番障害発生時の復旧手順を1ファイルに集約。

## 0. 障害判断フロー

```
staffHealthMonitor（SMTP）/ dailySyncToSheets 失敗通知（SMTP）アラート受信
   ↓  ※エラートラッキング（Sentry 等）は未導入。フロントの JS エラーは自動通知されない
1. 影響範囲を切り分け：
   - 予約画面（GitHub Pages）が落ちている → §3 GitHub Pages
   - 予約作成・キャンセル API が500 → §2 Functions
   - 朝3時の同期エラー → §4 dailySyncToSheets
   - スタッフ画面でログイン不可 → §5 Firebase Auth
   - データ不整合 → §6 Firestore データ
```

## 1. 通報ルート

| 種別 | 通知先 |
|---|---|
| Cloud Functions エラー | `STAFF_EMAIL` + `hid0707no@gmail.com`（自動・sendMonitorAlert） |
| dailySyncToSheets 失敗 | 同上 |
| GitHub Pages ビルド失敗 | GitHub Action 経由（未設定） |
| 運営連絡 | 上村さん（カさん） |

## 2. Firebase Functions ロールバック手順

### 2-A: 1コミット前への即時ロールバック
```bash
cd /Users/hid07/futami-reservation
git log --oneline -5            # 直前のコミットを確認
git revert <bad-commit-hash>    # revert commit を作成
git push origin main            # GitHub Pages も同時に戻る
firebase deploy --only functions
```

### 2-B: 特定の関数だけ削除（影響範囲を物理的に絞る）
```bash
firebase functions:delete dailySyncToSheets --region asia-northeast1
# 関数自体が消えるので onSchedule が発火しなくなる
# 復活は通常 deploy で
firebase deploy --only functions:dailySyncToSheets
```

### 2-C: deploy が壊れている場合の旧コードへの強制復帰
```bash
git checkout <known-good-commit> -- functions/src/
cd functions && npm run build && cd ..
firebase deploy --only functions
git checkout main -- functions/src/  # 戻す
```

## 3. GitHub Pages ロールバック

GitHub Pages は main ブランチを直接配信するため：
```bash
cd /Users/hid07/futami-reservation
git revert <bad-commit-hash>
git push origin main
# 30秒〜1分で反映
```

緊急時は直接 force push を避け、必ず revert commit を残す（履歴保全）。

## 4. dailySyncToSheets 障害

### 症状
- 5/14 03:00 以降、スプシ「ふたみ予約システム_予約マスタ_自動同期」の更新時刻が止まる
- `staffHealthMonitor` 由来の SMTP アラート受信

### 切り分け
```bash
firebase functions:log --only dailySyncToSheets --lines 50
```

### 復旧
```bash
# 手動同期トリガー（staff画面の同期ボタン or 直接API呼出）
# 但し triggerSyncToSheets は requireStaffAuth で守られているため、
# staff画面にログインしてからシークレットで叩く

# それでもダメなら旧コードに戻して再 deploy（§2-A）
```

### Z列退避（5/13 deploy 起因の特殊ケース）
2026-05-13 に SHEET_HEADERS の Z列を「予約番号」で上書きする変更を入れた。
運営が Z列にメモを置いていた場合に備えて：
```bash
node scripts/check_sheet_z_column_safety_20260513.js          # 確認
node scripts/check_sheet_z_column_safety_20260513.js --backup # 自動退避
```

## 5. Firebase Auth トラブル

### スタッフがログインできない
- Custom claim `staff: true` 未付与の可能性
- ユーザー作成: `node scripts/create_staff_user.js <email>`
- パスワードリセットリンクが発行される

## 6. Firestore データ復旧

### 個別予約の状態を戻したい
Firestore Console で該当 reservation document を編集。
影響範囲：
- `status`: 'confirmed' / 'cancelled' / 'checked_in'
- `slots` 配列: 排他制御のキー（slots コレクションも同期削除/復活が必要）

### 全体バックアップ
- スプシ「ふたみ予約システム_予約マスタ_自動同期」が日次バックアップ（5/13 までは A:Y / 以降は A:Z）
- Firestore 自動エクスポートは設定**未実施**（要対応）

## 7. Migration ロールバック

> 2026-06-11 修正（backlog #43）：旧記載の `run_migration.js` は**存在しない**。また `functions/migrations/`
> は `tsconfig` の `rootDir:"src"`/`include:["src/**/*"]` の**対象外**で `npm run build` ではビルドされない。
> 下記の実行可能手順に置き換える。`down()` の挙動は `functions/tests/integration/migration004.integration.test.ts`
> （emulator）で検証済み。

migration 004 の関数シグネチャ：`up/down(db, { dryRun: boolean })`（`dryRun:true` は件数のみ・無書込み）。

```bash
cd /Users/hid07/futami-reservation/functions

# 1) migration を単体コンパイル（src 外なので個別に出す）
npx tsc migrations/004_backfill_display_id_20260513.ts \
  --outDir /tmp/futami_mig --module commonjs --target es2020 \
  --esModuleInterop --skipLibCheck

# 2) 本番 ADC で down() を dry-run（削除“予定”件数のみ・実書込みなし）
#    ※ functions/ ディレクトリから実行（firebase-admin を node_modules から解決させる）
GOOGLE_CLOUD_PROJECT=futami-yoyaku-492607 NODE_PATH="$PWD/node_modules" node -e '
  const admin = require("firebase-admin"); admin.initializeApp();
  const { down } = require("/tmp/futami_mig/004_backfill_display_id_20260513.js");
  down(admin.firestore(), { dryRun: true }).then(r => { console.log("dry-run:", r); process.exit(0); })
                                            .catch(e => { console.error(e); process.exit(1); });
'

# 3) 件数を確認して問題なければ dryRun:false で実削除（上記の dryRun を false に）
```

> ⚠️ 本番実行前に必ず (1) emulator で `npm run test:integration -- migration004` を通し、
> (2) dry-run の件数が想定どおりか確認すること。ワンボタンの `scripts/run_migration.js` 整備は follow-up（未着手）。

## 8. 緊急連絡先

| 役割 | 連絡先 |
|---|---|
| 社長 | hid0707no@gmail.com |
| 現地（双海町） | 上村さん（カさん） |
| 開発外部 | 市川さん（functions B-1 担当・未稼働） |

## 9. SA / 認証鍵 ローテーション計画

### Cloud Functions Service Account
本プロジェクトは Firebase 管理の **default SA** を利用しており、Google が自動ローテーションする内部署名鍵で稼働する。**運用側でのキーローテーション作業は不要**。

```bash
# 確認用コマンド
firebase projects:get futami-yoyaku-492607
gcloud iam service-accounts list --project=futami-yoyaku-492607
```

### 外部公開していないキー類
- `~/.config/nissho/token_write.json` (Sheets書込用)：個人 OAuth refresh_token。Mac mini #1 への配布時に再 OAuth が必要。
- `~/.config/nissho/credentials.json`：Google Cloud OAuth Client ID/Secret（client app type=installed）。漏洩時の影響は限定的だが、年1回の点検推奨。
- `STAFF_API_KEY`：2026-04 に Firebase Auth 化で**廃止**。コード内に残存なし（`hooks/pre-commit` の credential scan で保護）。

### ローテーション点検カレンダー
| 鍵 | 周期 | 最終確認 | 次回 |
|---|---|---|---|
| default SA（Firebase管理）| 自動 | 2026-05-13 | — |
| token_write.json | 年1 | 2026-05-13 | 2027-05 |
| credentials.json | 年1 | 2026-05-13 | 2027-05 |
| Firebase apiKey（クライアント公開OK）| 廃止予定なし | — | — |

## 10. 運営通知ルート（上村さん＝カさん向け）

### 主要ルート（優先度順）
1. **スプシ「予約システム改修要望」** D列（SSOT・上村さんが日次で見る）
2. **Discord** （即時性が必要な場合）
3. **電話／SMS** （緊急時）

### 通知 SOP
- **★5 ルール準拠の事前通知**：SHEET_HEADERS 変更等は**1週間前**にスプシ＋Discord 両方で通知
- **deploy 後通知**：本番反映と同時にスプシD列に追記（既存パターン）
- **障害発生時**：Discord に即時投稿 → 電話確認

### 通知忘れ防止
本日 5/13 の SHEET_HEADERS A:Z 拡張は同日通知（運営影響:Z列メモ上書きリスク）になったが、Z列実調査で既存値0件確認済（§4 Z列退避フロー）。

## 11. Firestore TTL Policy（2026-05-13 設定）

`idempotency_keys.expireAt` / `rate_limits.expireAt` フィールドに対して Firestore TTL Policy を設定済（gcloud firestore fields ttls update --enable-ttl）。

```bash
gcloud firestore fields ttls list --project=futami-yoyaku-492607
# expectation:
#   idempotency_keys/fields/expireAt → state: ACTIVE
#   rate_limits/fields/expireAt      → state: ACTIVE
```

これによりコレクションの無限膨張が防止される。Firestore は `expireAt` < now のドキュメントを 24h 以内に自動削除する。

### ⚠️ 有効化直後の本番影響（2026-05-13 実測ベース）

TTL Policy を**初めて**有効化すると、過去に書き込まれたドキュメントが Firestore の次回 sweep（最大24h）で**一斉削除**される。実測：

| コレクション | TTL | 過去蓄積 | 初回 sweep 後 |
|---|---|---|---|
| `idempotency_keys` | 24h | 直近24h 内の冪等性キー | 24h 以前のキーは全削除（実害なし：本来 24h で破棄予定だった） |
| `rate_limits` | 2分 | 直近2分内のレート制限バケット | 2分以前のバケットは全削除（実害なし：すでに無効） |

**Cloud Functions 動作中の影響なし**を確認。これらは「すでに有効期限を過ぎた」レコードのため、削除されても機能に影響しない。

> **※ rate_limits コレクションは2026-06時点で本番未配線**：本番のレート制限は in-memory（`lib/rateLimit.ts`・インスタンスローカル）で稼働しており、Firestore 版 `lib/rateLimitFirestore.ts` は実装済みだが src からの import 0件＝未使用。上表の rate_limits TTL は同コレクションが配線された後に効く設計値で、現状は書き込みゼロ。下記 Check 6 の rate_limits 残留検知も配線までは常に空振り（合格）になる点に注意。

### TTL Policy の後退検知

`staffHealthMonitor`（毎朝08:30 onSchedule）に TTL state の間接検証を **2026-05-13 実装済**（`healthMonitor.ts` Check 6・`idempotency_keys` / `rate_limits` の48h残留を検知し SMTP アラート）。フォールバック（healthMonitor 障害時）として月1回手動で `gcloud firestore fields ttls list` を実行し ACTIVE 状態を確認する。

## 12. 過去の障害履歴

| 日付 | 内容 | 復旧 |
|---|---|---|
| 2026-04-08 | Googleカレンダー→Firestore 移行データで6畳全4部屋占有エラー | 該当 slots を手動削除 |
| 2026-04-27 | スプシ Z列以降のメモ温存対応で clear range A:Y 限定運用開始 | 設定変更で対応 |
| 2026-05-13 | SHEET_HEADERS A:Y → A:Z 拡張（要望#8 displayId 列追加）| Z列退避スクリプトで事前対応 |
