# ふたみ予約システム バックエンド設計書

作成日：2026-04-07
対象稼働日：2026-04-10
担当：社長（Claude Code）が全実装を担当
協力：上村さん（ふたみ現場・データ構造確認）

---

## 1. 設計方針

### 基本原則
- **MVPに徹する**：4/10稼働に間に合わせる最小構成。過剰設計禁止
- **Firestoreがソース・オブ・トゥルース**：Googleカレンダーは初回移行のみ使用
- **楽観ロックではなく悲観ロック**：予約書込時は必ずトランザクションで競合検出
- **既存フロントの `isSlotFree()` をそのままAPIに差し替えられる構造**にする

### スタック
| レイヤ | 技術 |
|---|---|
| DB | **Firestore（Native mode）** リージョン `asia-northeast1` |
| API | **GCP Cloud Functions 2nd gen（Node.js 20）** `min_instances: 1`（コールドスタート回避／月約100円） |
| 言語 | TypeScript |
| 認証 | POST /reservations は認証なし（CORS＋レート制限）／ その他スタッフ系APIはAPIキー必須 |
| ホスティング | 既存のGitHub Pagesから直接fetch（CORS許可） |

---

## 2. Firestoreスキーマ

### 2.1 コレクション全体図

```
/reservations/{reservationId}           ← 予約の本体（1ドキュメント = 1予約）
/slots/{slotKey}                        ← 占有スロット（競合検出用キャッシュ）
/config/masters                         ← ROOMS/PLANS マスター（任意）
```

### 2.2 `/reservations/{reservationId}`

**1予約 = 1ドキュメント**。複数スロット・複数日・複数部屋の予約でも1ドキュメントに集約。

```typescript
{
  id: string;                  // auto-generated (Firestore)
  planId: string;              // "plan_stay_6" | "plan_day_27_am" など
  roomIds: string[];           // ["room_6a"] or ["room_6a", "room_6b"]（複数部屋予約時）
  slots: string[];             // ["room_6a|2026-04-12|16", ..., "room_6a|2026-04-13|09"]
                               // ↑ 宿泊なら2日分のスロット配列
  startDate: string;           // "2026-04-12"（検索用）
  endDate: string;             // "2026-04-13"（宿泊の場合は翌日、日帰りは同日）
  nights: number;              // 0=日帰り, 1=1泊, 2=2泊...
  customer: {
    name: string;
    phone: string;
    email?: string;
    isMember: boolean;         // 伊予市民フラグ
  };
  guests: {                    // 宿泊時のみ
    adult: number;             // 中学生以上
    elementary: number;        // 小学生
    child: number;             // 小学生未満
  };
  pricing: {
    basePrice: number;         // 室料
    personFee: number;         // 人数加算
    optionFee: number;         // 照明・タオル等
    total: number;             // 最終合計
  };
  payment: {
    method: "onsite" | "online";  // MVP期間は全部 "onsite"
    status: "unpaid" | "paid" | "refunded";
  };
  status: "confirmed" | "checked_in" | "completed" | "cancelled";
  note?: string;               // スタッフメモ
  createdAt: Timestamp;
  createdBy: "web" | "staff" | "phone";
  updatedAt: Timestamp;
  cancelledAt?: Timestamp;
}
```

### 2.3 `/slots/{slotKey}`

**スロットキー形式**：`{roomId}|{date}|{hour}` 例：`room_6a|2026-04-12|16`

**役割**：「このスロットは誰かに押さえられている」という事実をO(1)で引ける高速キャッシュ。予約作成時にトランザクションでここに書き込み、同時書込みの競合を検出する。

```typescript
{
  slotKey: string;             // "room_6a|2026-04-12|16"
  roomId: string;
  date: string;                // "2026-04-12"
  hour: number;                // 16
  reservationId: string;       // どの予約が押さえているか
  createdAt: Timestamp;
}
```

- **ドキュメントIDは slotKey そのもの**（Firestore的にユニーク保証）
- 予約キャンセル時は該当slotドキュメントを削除
- 初回移行時は `data.json` の occupied_slots をそのまま流し込む

### 2.4 なぜ reservations と slots を両方持つか

| 要件 | reservations | slots |
|---|---|---|
| 予約一覧・詳細表示 | ◎（顧客情報含む） | × |
| 空きチェック（競合検出） | △（範囲クエリ必要） | ◎（ID直接引き） |
| キャンセル時の復元 | ◎ | △ |
| スタッフ画面表示 | ◎ | △ |

→ **reservationsが真実／slotsは高速検索用の導出データ**。トランザクションで両方同時更新する。

### 2.5 インデックス

必要な複合インデックス：
- `reservations: (status, startDate, endDate)` ← スタッフ画面の日付別表示
- `reservations: (roomIds, startDate)` ← 部屋別の予約検索

---

## 3. Cloud Functions API 仕様

### エンドポイント一覧（MVP）

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| GET | `/availability` | 空きスロット取得（予約者UI用） | なし（公開） |
| POST | `/reservations` | 予約作成 | なし（CORS＋レート制限で保護） |
| GET | `/reservations` | 予約一覧（スタッフ用） | APIキー |
| GET | `/reservations/:id` | 予約詳細 | APIキー |
| PATCH | `/reservations/:id` | ステータス更新（チェックイン等） | APIキー |
| DELETE | `/reservations/:id` | キャンセル | APIキー |

### 3.1 GET `/availability`

**目的**：予約者UIの起動時に占有スロット一覧を返す。現行 `data.json` の置き換え。

**リクエスト**
```
GET /availability?from=2026-04-10&to=2026-06-30
```

**レスポンス**
```json
{
  "generatedAt": "2026-04-07T10:00:00Z",
  "occupiedSlots": [
    "room_6a|2026-04-12|16",
    "room_6a|2026-04-12|17",
    ...
  ]
}
```

**実装方針**：`slots` コレクションを `date` で範囲クエリ → 配列化。件数が多い場合はレスポンスを gzip 圧縮。

---

### 3.2 POST `/reservations`

**目的**：予約を作成する。競合は**Firestoreトランザクション**で検出。

**リクエスト**
```json
{
  "planId": "plan_stay_6",
  "roomIds": ["room_6a"],
  "slots": ["room_6a|2026-04-12|16", ..., "room_6a|2026-04-13|09"],
  "startDate": "2026-04-12",
  "endDate": "2026-04-13",
  "nights": 1,
  "customer": { "name": "田中太郎", "phone": "090-...", "isMember": true },
  "guests": { "adult": 2, "elementary": 0, "child": 0 },
  "pricing": { "basePrice": 2310, "personFee": 3160, "optionFee": 0, "total": 5470 },
  "createdBy": "web"
}
```

**レスポンス（成功）**
```json
{ "reservationId": "abc123", "status": "confirmed" }
```

**レスポンス（競合）**
```json
{ "error": "slot_conflict", "conflictSlots": ["room_6a|2026-04-12|16"] }
```

**トランザクション処理**
```typescript
await db.runTransaction(async tx => {
  // 1. 全slotKeyを同時にget
  const slotDocs = await Promise.all(
    req.slots.map(key => tx.get(db.doc(`slots/${key}`)))
  );
  // 2. 1つでも存在したら競合エラー
  const conflicts = slotDocs.filter(d => d.exists).map(d => d.id);
  if (conflicts.length) throw { code: "slot_conflict", conflicts };
  // 3. reservationsに書込
  const resRef = db.collection("reservations").doc();
  tx.set(resRef, { ...req, createdAt: FieldValue.serverTimestamp() });
  // 4. 全slotKeyに書込
  req.slots.forEach(key => {
    tx.set(db.doc(`slots/${key}`), { slotKey: key, reservationId: resRef.id, ... });
  });
});
```

---

### 3.3 GET `/reservations`

**目的**：スタッフPWAの日付表示用。

**クエリ**
- `date=2026-04-12`（その日に関わる予約を返す）
- `status=confirmed` など
- `from=&to=` 範囲指定

**レスポンス**
```json
{
  "reservations": [
    { "id": "...", "planId": "...", "roomIds": [...], "customer": {...}, ... }
  ]
}
```

---

### 3.4 PATCH `/reservations/:id`

**目的**：チェックイン・ステータス変更・スタッフメモ追加。

**リクエスト例**
```json
{ "status": "checked_in", "note": "夕食なし" }
```

---

### 3.5 DELETE `/reservations/:id`

**目的**：予約キャンセル。

**処理**：
1. reservation を `status: "cancelled"` に更新（物理削除しない）
2. 該当 `slots/*` を全て**物理削除**（他の予約が入れるように）
3. トランザクションで両方を同時実行

---

## 4. フロントエンド改修


### 4.1 `src/index.html` の変更箇所

**現状（1376行あたり）**
```javascript
const res = await fetch('data.json?t=' + Date.now());
const data = await res.json();
(data.occupiedSlots || []).forEach(s => OCCUPIED_SLOTS.add(s));
```

**変更後**
```javascript
const API_BASE = "https://asia-northeast1-futami-reservation.cloudfunctions.net/api";
const res = await fetch(`${API_BASE}/availability?from=${today}&to=${plus90days}`);
const data = await res.json();
(data.occupiedSlots || []).forEach(s => OCCUPIED_SLOTS.add(s));
```

### 4.2 予約送信処理（現状はダミー）を実APIに置き換え

予約確定ボタン押下時：
```javascript
const res = await fetch(`${API_BASE}/reservations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': '...' },
  body: JSON.stringify(reservationPayload)
});
if (res.status === 409) {
  alert('申し訳ありません、その時間帯は先ほど他の方が予約されました。もう一度お選びください。');
  await reloadAvailability();
  return;
}
```

### 4.3 staff.html

`GET /reservations?date=` を**30秒ごとにポーリング**（現場スタッフの「今入った予約が出ない」を防ぐため）。Firestore無料枠・Functions無料枠内で余裕。リアルタイムリスナーは疎結合を保つため見送り。

---

## 5. セキュリティ

### MVP期間の方針（4/10稼働版）
- **予約作成（POST）は認証なし**（公開UIから直接叩くため）
  - 保護手段：CORS で `https://hid0707no-a11y.github.io` のみ許可＋Cloud Functionsのレート制限（1IP/分あたり10回）
- **予約一覧・更新・削除（GET/PATCH/DELETE）はAPIキー必須**
  - スタッフPWAのビルド時に環境変数注入
- Firestore Security Rulesは「全拒否」→ Cloud Functions経由のみ許可

### 将来（稼働安定後）
- reCAPTCHA v3 導入（POST保護強化）
- Firebase Authでスタッフログイン
- 本人確認SMS（Twilio）
- Cloud Armor で本格レート制限

---

## 6. データ移行（4/9実施予定）

### ソース
- 既存 `data.json`（170イベント／164予約分の occupiedSlots）
- 元のGoogleカレンダーイベント（`docs/events_raw.json`）←こちらに顧客名情報あり

### 手順
1. `scripts/migrate_to_firestore.ts` を新規作成
2. `events_raw.json` を読み込み、イベントタイトルを正規表現でパース
   - 例：`予約済み(1号室) 田中様` → roomId: `room_27`, customerName: `田中様`
   - 部屋番号のマッピングは `calendar_mapping.md` のテーブルを使用
3. **1イベント = 1 reservation ドキュメント**として投入（ダミー集約は禁止）
4. 各reservationの全slotKeyを `slots/` にも同時投入（トランザクションで）
5. 完了後、件数突合：
   - `reservations` ドキュメント数 = 164
   - `slots` ドキュメント数 = `data.json` の occupiedSlots 数と一致
6. 上村さん目視確認：「佐藤様の予約」等が正しく紐付いているかサンプリング

### 注意
- 4/9までに**新規カレンダー書込みを停止**するよう上村さんに依頼（二重管理防止）
- 移行後は Firestore が正、カレンダーは参照のみ

---

## 7. デプロイ構成

```
futami_reservation/
├── src/                     # フロント（既存）
├── functions/               # ← 新規：Cloud Functions
│   ├── src/
│   │   ├── index.ts        # エンドポイント定義
│   │   ├── availability.ts
│   │   ├── reservations.ts
│   │   └── lib/
│   │       ├── firestore.ts
│   │       └── validation.ts
│   ├── package.json
│   └── tsconfig.json
├── scripts/
│   └── migrate_to_firestore.ts  # ← 新規
└── docs/
    └── backend_design.md    # ← 本書
```

---

## 8. 開発スケジュール（4/7夜〜4/9）

### 4/7（月・本日・定休日）← 疎通確認を終わらせる
- [ ] GCPプロジェクト `futami-reservation` 作成
- [ ] Firestore（Native mode）有効化＋リージョン `asia-northeast1`
- [ ] Cloud Functions 2nd gen 環境構築＋`functions/` TypeScriptプロジェクト初期化
- [ ] `GET /availability` の最小実装＋デプロイ＋**疎通確認**（カラ配列返すだけでOK）
- [ ] CORS設定（`https://hid0707no-a11y.github.io` 許可）
- [ ] 上村さんに「4/9までにカレンダー書込停止可能か」確認メッセージ送信

### 4/8（火）← 最難関のトランザクションに集中
- [ ] `POST /reservations` のトランザクション実装
- [ ] 競合検出の単体テスト（二重予約が弾かれるか確認）
- [ ] レート制限設定（1IP/分あたり10回）

### 4/9（水）
- [ ] `GET/PATCH/DELETE /reservations` 実装
- [ ] 移行スクリプト実行 → 164予約を投入
- [ ] フロント `index.html` の `fetch('data.json')` → API差し替え
- [ ] staff.html のAPI接続
- [ ] エンドツーエンドテスト（予約作成→競合検出→キャンセル）
- [ ] 上村さんに動作確認依頼

### 4/10（木）本番稼働
- [ ] 朝一で最終動作確認
- [ ] 予約受付開始
- [ ] 障害時の切り戻し手順確認（旧data.json方式にいつでも戻せるよう保険）

---

## 9. コスト試算

### 4/10〜当面（月間）
| 項目 | 想定 | コスト |
|---|---|---|
| Firestore 書込 | 月500予約 × 平均10スロット = 5,000書込 | 無料枠（2万書込/日）内 |
| Firestore 読込 | 月10,000空き照会 + 30秒ポーリング | 無料枠（5万読込/日）内 |
| Firestore ストレージ | 〜100MB | 無料枠内 |
| Cloud Functions 実行 | 月30,000回 | 無料枠（200万回/月）内 |
| Cloud Functions CPU時間 | | 無料枠内 |
| **min_instances: 1**（コールドスタート回避） | 常時1台待機 | **約100円/月** |
| Cloud Logging | | 無料枠内 |
| **月額合計** | | **約100円** |

→ MVP期間は完全に無料枠内で運用可能。

### スケール時の分岐点
- 月予約数が **3,000件を超えたら** Firestore書込コストが発生（それでも月数百円）
- アクセスが急増したらCloud Functions実行料（でも月数千円レベル）

---

## 10. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 4/10に間に合わない | 致命的 | 4/8-9で最優先・ブロッカー即エスカレ／保険：`data.json` 方式で稼働開始→後日切替 |
| 予約競合（二重予約） | 重大 | トランザクション＋slotsコレクション設計で技術的に排除 |
| Firestoreセキュリティルール不備 | 重大 | 全拒否 + Functions経由のみ許可を徹底 |
| スタッフがGUIに慣れない | 中 | staff.htmlはほぼ現状維持・API差し替えのみ |
| 移行漏れ | 中 | 移行後に件数突合＋上村さん目視確認 |
| カレンダー二重管理 | 中 | 4/9までに書込停止を依頼 |

---

## 11. 確認事項（4/7中にクリアしたい）

- [ ] 上村さんに「カレンダーの未来予約件数」確認
- [ ] 上村さんに「4/9までに新規カレンダー書込を止められるか」確認
- [ ] GCP課金アカウント（社長名義）の確認
- [ ] GitHub Pages CORS設定の確認
- [ ] APIキーの発行・保管方法決定

---

## 12. 次のアクション

1. 本設計書の**社長レビュー＆承認**
2. 承認後、`functions/` ディレクトリを作成してTypeScriptプロジェクト初期化
3. `POST /reservations` のトランザクション実装から着手（最難関なので先にやる）
4. 並行してGCPプロジェクト準備
