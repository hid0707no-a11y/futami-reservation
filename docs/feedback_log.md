# ふたみ予約システム フィードバックログ

## 運用方針（2026-04-08 決定）

ふたみ予約システムの改善は、**実運用フィードバックループ**で進める。

### サイクル
1. 上村さん・現場スタッフが日常運用で気づいた点を共有
2. 髙橋社長経由でこのファイルに記録
3. 一定量たまったら or 緊急性高いものから順にプロンプト/コードに反映
4. `vercel --prod` ではなく `git push` で反映（GitHub Pages）
5. CHANGELOG（このファイル下部）にバージョン追記

---

## 記録フォーマット

各フィードバックは以下の形式で下に追記：

```
## YYYY-MM-DD #N カテゴリ
### 状況
（誰が・いつ・何をしようとしたか）

### 課題・改善要望
（具体的に何が問題か / どうしたいか）

### 反映方針
- [ ] バックエンド修正
- [ ] フロント修正
- [ ] 運用ルール変更
- [ ] 未対応（検討中）

### 対応結果
（実装内容・コミットID・反映日）
```

カテゴリ例：
- `予約者UI` / `スタッフ詳細` / `月俯瞰` / `テニス画面`
- `データ` / `運用ルール` / `バグ` / `機能追加`

---

## 既知の改善候補（現時点で社長が把握しているもの）

- [x] **APIキー強化**：2026-04-09 64文字ランダム（openssl rand -hex 32）に差し替え完了
- [x] **管理画面パスワードゲート**：2026-04-09 staff/staff2/staff_tennis にsessionStorage方式ゲート追加（PW: `Futamii202604`）
- [ ] **カスタムドメイン**：`yoyaku.fureai-iyosasaeru.com` 試行→Wix管理のためDNS設定不可で保留。Cloudflare移譲 or 別ドメイン取得で再挑戦
- [ ] **Firebase Auth 本格導入**（案C）：sessionStorage方式は暫定。稼働安定後にメール/PW認証＋IDトークン検証に移行
- [ ] **営業カレンダー機能**：夏休み期間の無休設定など
- [ ] **reCAPTCHA / Auth 強化**：稼働安定後
- [ ] **min_instances 復活検討**：コールドスタートが現場で気になるなら
- [ ] **リアルタイム同期**：30秒ポーリング → Firestoreリスナーへ移行検討
- [ ] **印刷レイアウト最適化**：staff_tennis.html の手書きシート風 A4縦印刷

---

## フィードバック履歴

（ここに随時追記）

---

## CHANGELOG

### v1.1 — 2026-04-09
- スタッフ画面3種（staff/staff2/staff_tennis）にパスワードゲート追加（sessionStorage方式、PW: `Futamii202604`）
- Cloud Functions の STAFF_API_KEY を64文字ランダムに強化
- カスタムドメイン化は Wix側の制約により保留、GitHub PagesデフォルトURLで本番稼働継続

### v1.0 — 2026-04-08
**初期リリース・並行運用開始**

主要機能:
- Cloud Functions API 7本（availability/createReservation/list/update/cancel/futamiDays/health）
- Firestore 4コレクション（reservations/slots/shared_slots/tennis_slots/config）
- ふたみの日 capacity 方式（毎月23日・8名定員）
- テニス30分単位スロット
- index.html（予約者UI）API接続
- staff.html（詳細管理）30秒自動更新・キャンセル
- staff2.html（月俯瞰）カテゴリフィルタ
- staff_tennis.html（テニス専用）30分刻み手書きシート風
- 既存164予約を Firestore に移行
- 部屋名を1〜6号室の正式呼称に統一
- サウナ ABCD 4枠制

### v0.x — 2026-04-06〜07
- 設計・実装着手
- バックエンド設計書作成
- GCPプロジェクト作成（途中で組織ポリシー問題で作り直し）
- Firestore・Cloud Functions 初期構築

---

## 関連ファイル

- 設計書：[backend_design.md](./backend_design.md)
- 進捗ログ：[progress.md](./progress.md) / [progress_20260407.md](./progress_20260407.md)
- スタッフ案内：[staff_announcement.md](./staff_announcement.md)
- カレンダーマッピング：[calendar_mapping.md](./calendar_mapping.md)

## 本番URL
- 予約者：https://hid0707no-a11y.github.io/futami-reservation/
- 詳細管理：https://hid0707no-a11y.github.io/futami-reservation/staff.html
- 月俯瞰：https://hid0707no-a11y.github.io/futami-reservation/staff2.html
- テニス：https://hid0707no-a11y.github.io/futami-reservation/staff_tennis.html
- API Base：https://asia-northeast1-futami-yoyaku-492607.cloudfunctions.net
