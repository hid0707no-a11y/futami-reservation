# スプレッドシート列追加：フリガナ（AA列）

**日付**：2026-08-25
**要望**：運営（西田さん）改修要望⑩「予約画面で氏名にフリガナも入力して欲しい」
**変更**：`SHEET_HEADERS` に「フリガナ」を **末尾（27列目・AA列）** へ追加。26列（A:Z）→ 27列（A:AA）。

## 変更したファイル

| ファイル | 内容 |
|---|---|
| `functions/src/lib/sheets.ts` | `SHEET_HEADERS` に `'フリガナ'` 追加／`ReservationRow.customerKana`／`rowToArray` 末尾／`reservationToRow` で `customer.kana` を拾う |
| `functions/src/constants.ts` | `SHEET_LAST_COLUMN` を `'Z'` → `'AA'` |
| `functions/src/services/sheetsSync.ts` | 冒頭コメントのみ（clear範囲は `SHEET_LAST_COLUMN` を引数で受けるので実装変更なし） |
| `functions/tests/sheets.test.ts` | 列数27の固定／`SHEET_LAST_COLUMN` と列数の一致検証／列名重複検証／フリガナの位置と空欄埋め |

## なぜ「お名前の直後」ではなく末尾なのか

途中（K列）に挿すと **L列以降を参照している外部の集計・ピボットが静かにずれる**。
運営に確認したが既存の集計の有無を把握できていなかったため、壊れようがない末尾を選んだ。
2026-05-13 の「予約番号」追加（Z列・末尾）と同じ判断。

運営から「お名前の隣にしてほしい」と要望があれば、**列を参照している集計が無いことを確認した上で**移動できる。

## 運営メモの上書きが起きないことの確認（★重要）

日次同期は `A:<SHEET_LAST_COLUMN>` を clear → 再書込みするため、**その右側に運営が書いたメモは温存される**。
2026-05-13 の Z列拡張時に「メモは AA列以降へ」と案内していたので、**AA列を使うと運営のメモを消す**恐れがあった。

適用前に Sheets API で実データを確認した結果：

```
reservations : columnCount = 26
cancelled    : columnCount = 26
meta         : columnCount = 26
```

3タブとも **グリッドが26列で終わっており、AA列以降はセルごと存在しない**（`AA1:BZ5000` の取得は
「範囲がシート外」で HTTP 400）。＝ 運営メモは1件も無いため、AA列を使っても何も消さない。

**今後のメモ列は AB以降**。次に列を足す人は、同じ手順で当時の `SHEET_LAST_COLUMN` の
右隣が空であることを実測してから広げること。

## グリッドの自動拡張も実測で確認した

追加時点のシートは3タブとも `columnCount = 26` で、**AA列はセルとして存在しなかった**。
`values.clear` は範囲がグリッド外だと 400 を返す（実際に `AA1:BZ5000` の読取が 400 だった）ので、
`sheetsSync.writeTab` の2操作（`values.update(A1起点)` → `values.clear(A<n>:AA)`）が
そのまま通るのかを、**本番を1文字も触らずに複製で検証**した：

```
複製前 reservations : 26列
✅ values.update（27列ぶん・A1起点） 成功 → グリッドが自動拡張される
✅ values.clear（A3:AA）             成功
複製後 reservations : 27列
（複製は検証後に削除済み）
```

＝ **手でグリッドを広げる作業は不要**。`values.update` が先に走ってグリッドを27列へ広げるため、
後続の `clear(A<n>:AA)` も範囲内に入る。`writeTab` が 2026-05-05 に
「clear→update」から「update→clear」へ順序を変えていた（途中失敗でタブが空になる窓を潰すため）
ことが、結果的にこの拡張順序も正しくしている。**順序を戻すと列追加時に落ちる**ので戻さないこと。

## マイグレーションの要否

**不要**。Firestore はスキーマレスで、`customer.kana` を持たない既存予約は
`reservationToRow` が空文字で埋める（列はずれない）。日次同期は毎回 Firestore 全件から
作り直すため、**列を足した翌朝3:00の同期で過去分もまとめて反映される**（過去分は空欄）。

## 検知の穴（次に列を足す人へ）

- `[sheet-schema]` タグ強制（`hooks/commit-msg` / `.github/workflows/ci.yml`）は
  `SHEET_HEADERS|SYNC_CLEAR_RANGE|SHEET_LAST_COLUMN` **の語がある行の差分**しか見ない。
  配列の中に列名を1行足しただけのコミットでは**発火しない**。
- `constants.ts` の `SYNC_CLEAR_RANGE_RESERVATIONS` / `_CANCELLED` / `_META` は
  **定義だけで参照0件の死に定数**。直しても何も効かない。実際に範囲を決めているのは
  `SHEET_LAST_COLUMN` の方。
- 今回、その直し忘れを止めるテストを追加した
  （`SHEET_LAST_COLUMN` が `SHEET_HEADERS.length` と一致することを検証）。
