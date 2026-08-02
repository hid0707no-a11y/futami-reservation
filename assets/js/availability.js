// ふたみ予約システム 空き状況レベル判定 純粋関数ライブラリ
//
// 2026-08-01 新設（運営要望②「2枠埋まっても◎のまま」への対応）。
// index.html の getDayAvailability() に inline で書かれていた閾値を切り出し、
// Jest テストの対象にする（★崩壊防止ルール2「HTML の <script> は触らない」に準拠）。
//
// 設計方針は pricing.js と同一：
//  - 状態（グローバル変数）に依存しない純粋関数のみを置く
//  - ブラウザでは window.NisshoAvailability 経由でアクセス
//  - Node/jest では module.exports 経由でアクセス
//
// テスト：functions/tests/availability.test.ts

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NisshoAvailability = factory();
  }
})(
  typeof globalThis !== 'undefined' ? globalThis
    : typeof self !== 'undefined' ? self
    : typeof window !== 'undefined' ? window
    : this,
  function () {

  // ─────────────────────────────────────────
  // 日単位の空き状況レベル
  // ─────────────────────────────────────────
  //
  // freeCount: その日に予約できる枠（プラン）の数
  // total    : その施設グループの全枠数
  //
  // 返り値と記号の対応（index.html の renderMonthlyCalendar が描画）：
  //   'ok'   ◎ 空きあり     （全枠空き）
  //   'few'  ○ やや空きあり （1枠だけ埋まっている）
  //   'some' △ 半分ほど埋まり
  //   'last' ▲ 残りわずか   （残り1枠）
  //   'full' ×  満室
  //
  // サウナ（4枠）での結果 = 4枠空き◎ / 3枠○ / 2枠△ / 1枠▲ / 0枠× 。
  // 旧実装は「空き ≧ 全体の50%なら◎」だったため、4枠のサウナは2枠空きでも◎に
  // なり、○が構造上一度も出なかった（運営要望②の原因）。
  //
  // ★判定順が仕様：freeCount === total を freeCount === 1 より先に見ることで、
  //   1プランしかない施設（キャンプ場・6畳日帰り・厨房）は従来どおり ◎/× の2値に保たれる。
  //   逆にすると「1枠だけの施設が空いている」状態が常に▲になる。
  function dayAvailabilityLevel(freeCount, total) {
    var free = Number(freeCount);
    var all = Number(total);
    // 壊れた入力は「空きあり」と誤認させない側（満室）に倒す
    if (!isFinite(free) || !isFinite(all) || all <= 0) return 'full';
    if (free <= 0) return 'full';
    if (free >= all) return 'ok';
    if (free === 1) return 'last';
    if (free === all - 1) return 'few';
    return 'some';
  }

  // ─────────────────────────────────────────
  // 施設ごとの停止（facilityClosed）
  // ─────────────────────────────────────────
  //
  // 2026-08-02 新設。運営要望「サウナだけをその日は予約不可にしたい」への対応。
  // 従来の営業カレンダー（forceClosed）は日付単位・全施設一斉でしか閉じられず、
  // 代わりにダミー予約で塞いだ結果、運営宛メールの大量送信と行政報告スプシへの
  // 架空売上計上が起きていた。
  //
  // facilityClosed の要素は次の2形式のみ（config/business_calendar が持つ）：
  //   "roomId|YYYY-MM-DD"        … その施設をその日は終日停止
  //   "roomId|YYYY-MM-DD|hour"   … その施設のその時間だけ停止（hour はゼロ埋めしない文字列）
  // 例: "sauna|2026-09-20"  /  "sauna|2026-09-20|10"
  //
  // ★サウナ連動ルール（忘れると穴になる）
  //   サウナは通常日が roomId=sauna、毎月23日前後の「ふたみの日」だけ roomId=sauna_share を
  //   使う（同じ物理サウナ）。よって sauna の停止指定は sauna_share にも効き、その逆も効く。
  //   サーバ側 createReservation.ts の alternateSaunaKeys と同じ思想。
  var SAUNA_ROOM_IDS = ['sauna', 'sauna_share'];

  // 同じ物理施設として扱う roomId 群を返す
  function relatedRoomIds(roomId) {
    if (roomId === 'sauna' || roomId === 'sauna_share') return SAUNA_ROOM_IDS;
    return [roomId];
  }

  // 時間部分を「ゼロ埋めしない時（0〜23）の文字列」に正規化する。
  // 受け付ける形：10 / '10' / '08'（旧staff整数時）/ '0830'（テニスのHHMM。先頭2桁を時とみなす）
  //               / '8:30'（旧colon形式）
  // 判定できないもの（null・空・範囲外）は null を返す＝「時間指定なし」扱い。
  function normalizeHourPart(value) {
    if (value === null || value === undefined) return null;
    var s = String(value).trim();
    if (s === '') return null;
    if (/^\d{4}$/.test(s)) {
      s = s.slice(0, 2);            // テニス HHMM（0830 → 08）
    } else if (s.indexOf(':') >= 0) {
      s = s.split(':')[0];          // 8:30 → 8
    }
    if (!/^\d{1,2}$/.test(s)) return null;
    var h = Number(s);
    if (!isFinite(h) || h < 0 || h > 23) return null;
    return String(h);               // ゼロ埋めしない（slots コレクションのキーと同形式）
  }

  // roomId・date・hour の枠が停止中か
  //  - facilityClosed が未設定／空配列なら常に false（＝導入前と完全に同じ動作）
  //  - 壊れた要素（形式違い・時が範囲外）は黙って無視する
  //  - hour を渡さない場合は「終日停止」だけを見る（時間指定の停止では閉じない）
  function isFacilitySlotClosed(facilityClosed, roomId, date, hour) {
    if (!Array.isArray(facilityClosed) || facilityClosed.length === 0) return false;
    if (!roomId || !date) return false;
    var rooms = relatedRoomIds(String(roomId));
    var targetHour = normalizeHourPart(hour);
    for (var i = 0; i < facilityClosed.length; i++) {
      var entry = facilityClosed[i];
      if (typeof entry !== 'string') continue;
      var parts = entry.split('|');
      if (parts.length < 2 || parts.length > 3) continue;
      if (parts[1] !== date) continue;
      if (rooms.indexOf(parts[0]) < 0) continue;
      if (parts.length === 2) return true;             // 終日停止
      var closedHour = normalizeHourPart(parts[2]);
      if (closedHour === null) continue;               // 壊れた時間指定は無視
      if (targetHour !== null && closedHour === targetHour) return true;
    }
    return false;
  }

  // プラン単位の停止判定（hours のいずれか1つでも停止していれば true）
  //
  // 2026-08-02 追加。この規則はもともと index.html の <script> 内に
  // `plan.slots.some(h => isFacilitySlotClosed(...))` として書かれていた。
  // 「プランを構成する時間のうち1つでも止まっていればプランごと予約不可」は
  // 在庫規則そのものなので、テスト可能な純粋関数としてこちらへ移設した。
  //
  // 想定利用：ふたみの日サウナ（1予約で枠を丸ごと占有する）のように、
  // 個々の時間を利用者が選べないプラン。
  //
  //  - hours が配列でない／空配列のときは「終日停止」だけを見る。
  //    時間を利用者が選ぶプラン（テニス・ロッジ日帰り）を1枠の停止で
  //    日付ごと弾いてしまわないため（その場合は枠単位の isFacilitySlotClosed が担当）。
  //  - facilityClosed が未設定／空なら常に false（＝導入前と完全に同じ動作）
  function isPlanFacilityClosed(facilityClosed, roomId, date, hours) {
    if (!Array.isArray(facilityClosed) || facilityClosed.length === 0) return false;
    if (!roomId || !date) return false;
    if (!Array.isArray(hours) || hours.length === 0) {
      return isFacilitySlotClosed(facilityClosed, roomId, date, null);
    }
    for (var i = 0; i < hours.length; i++) {
      if (isFacilitySlotClosed(facilityClosed, roomId, date, hours[i])) return true;
    }
    return false;
  }

  // 凡例・バッジ用の日本語ラベル（記号は index.html 側が持つ）
  var LEVEL_LABELS = {
    ok: '空きあり',
    few: 'やや空きあり',
    some: '半分ほど埋まり',
    last: '残りわずか',
    full: '満室',
    closed: '定休日',
    unknown: '確認中',
  };

  function levelLabel(level) {
    return LEVEL_LABELS[level] || LEVEL_LABELS.unknown;
  }

  return {
    dayAvailabilityLevel: dayAvailabilityLevel,
    levelLabel: levelLabel,
    LEVEL_LABELS: LEVEL_LABELS,
    isFacilitySlotClosed: isFacilitySlotClosed,
    isPlanFacilityClosed: isPlanFacilityClosed,
  };
});
