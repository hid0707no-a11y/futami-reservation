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
  };
});
