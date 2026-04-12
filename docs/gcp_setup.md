# ふれあい公園 Google Calendar API セットアップ手順

## アカウント情報
- Googleアカウント: `info@fureai-iyosasaeru.com`
- 用途: Google Calendar API でカレンダー読み取り → 予約システムへ移行

## 手順（所要時間: 約10分）

### Step 1: GCPコンソールにログイン
1. https://console.cloud.google.com/ にアクセス
2. `info@fureai-iyosasaeru.com` でログイン

### Step 2: プロジェクト作成
1. 上部の「プロジェクトを選択」→「新しいプロジェクト」
2. プロジェクト名: `futami-reservation`
3. 「作成」をクリック

### Step 3: Calendar API を有効化
1. 左メニュー「APIとサービス」→「ライブラリ」
2. 「Google Calendar API」を検索
3. 「有効にする」をクリック

### Step 4: OAuth同意画面の設定
1. 左メニュー「APIとサービス」→「OAuth同意画面」
2. ユーザータイプ: **外部**（Workspaceでない場合）
3. アプリ名: `ふたみ予約システム`
4. ユーザーサポートメール: `info@fureai-iyosasaeru.com`
5. デベロッパー連絡先: `info@fureai-iyosasaeru.com`
6. スコープ追加: `https://www.googleapis.com/auth/calendar.readonly`
7. テストユーザー追加: `info@fureai-iyosasaeru.com`
8. 「保存して続行」

### Step 5: OAuth認証情報の作成
1. 左メニュー「APIとサービス」→「認証情報」
2. 「＋認証情報を作成」→「OAuthクライアントID」
3. アプリケーションの種類: **デスクトップアプリ**
4. 名前: `futami-calendar-sync`
5. 「作成」→ **JSONをダウンロード**
6. ダウンロードしたファイルを以下に配置:
   ```
   G:\マイドライブ\nissho\00_projects\futami_reservation\scripts\credentials_fureai.json
   ```

### Step 6: Python スクリプトで認証
```bash
cd G:\マイドライブ\nissho\00_projects\futami_reservation\scripts
python auth_fureai.py
```
ブラウザが開く → `info@fureai-iyosasaeru.com` でログイン → 許可

成功すると `token_fureai.json` が生成される。

### Step 7: カレンダー一覧取得
```bash
python list_calendars.py
```
全カレンダーの名前・ID・色が表示される。

---

## 注意事項
- `credentials_fureai.json` と `token_fureai.json` は **Git管理しない**（.gitignoreに追加済み）
- OAuth同意画面が「テスト」モードの場合、テストユーザーに追加したアカウントのみ認証可能
- トークンは約1時間で期限切れ → スクリプトが自動リフレッシュ
