// ふたみ予約システム 月俯瞰台帳（staff2.html）のセル表記 純粋関数ライブラリ
//
// 2026-08-16 新設（運営要望①②）。
//   ① 1泊2日で「1」が両日に出るのをやめ、チェックイン日／チェックアウト日を区別する
//   ② 日帰り（日中）利用を宿泊と別の見た目にする
//
// ★なぜ「1」が両日に出ていたか（バグではない）
//   宿泊の在庫枠は 16:00〜翌9:00（reservationPlans.ts の STAY_HOURS）。翌朝の 0〜9時が
//   チェックアウト日の slot として実在するため、月俯瞰は「その日も部屋が埋まっている」と
//   正直に数えていた。数えること自体は正しく、表記だけが用途（日別の受入件数）と噛み合って
//   いなかった。
//
// ★「2」の正体
//   1部屋＝1行なので、同じ行の同じ日に2件並ぶのは「朝出る組＋夕方入る組」しかない
//   （6畳は日帰り 8-21時 とチェックアウト 0-9時 が 8,9時でぶつかるため併存できない）。
//   単純に「1」を消すと件数は正しくなるが、朝に出る組が台帳から消えて清掃・鍵の段取りが
//   読めなくなる。よって IN / 泊 / OUT に振り替える。
//
// ★意味は「色」でなく「文字」に載せる
//   この台帳は 2026-08-06 に「印刷すると色が薄くて読めない」で一度直している
//   （ブラウザが背景色を刷らない）。色だけに意味を持たせると、プリンタ設定次第で
//   意味ごと消える。IN / OUT / 日 / 泊 は文字で出す。
//
// 設計方針は pricing.js / availability.js と同一：
//  - 状態（グローバル変数）に依存しない純粋関数のみを置く
//  - ブラウザでは window.NisshoLedger 経由でアクセス
//  - Node/jest では module.exports 経由でアクセス
//
// テスト：functions/tests/ledger.test.ts

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NisshoLedger = factory();
  }
})(
  typeof globalThis !== 'undefined' ? globalThis
    : typeof self !== 'undefined' ? self
    : typeof window !== 'undefined' ? window
    : this,
  function () {

  // ─────────────────────────────────────────
  // プラン分類
  // ─────────────────────────────────────────
  //
  // 正本は functions/src/lib/reservationPlans.ts の RESERVATION_PLAN_RULES。
  // 向こうで kind:'overnight' のものが STAY、それ以外が DAY。プランを増やしたら
  // こちらにも足すこと（★足し忘れても数字表示にフォールバックするだけで、
  //   セルが空になったり誤った IN/OUT が出ることはない＝安全側に倒してある）。

  var STAY_PLAN_IDS = [
    'stay_6', 'stay_27', 'stay_exp', 'stay_all', // ふれあいの館
    'camp_stay',                                  // キャンプ場
    'lodge_stay',                                 // ロッジ
  ];

  var DAY_PLAN_IDS = [
    'day_6_all',
    'day_27_am', 'day_27_pm', 'day_27_eve', 'day_27_daytime', 'day_27_all',
    'day_exp_am', 'day_exp_pm', 'day_exp_eve', 'day_exp_daytime', 'day_exp_all',
    'day_train_am', 'day_train_pm', 'day_train_eve', 'day_train_daytime', 'day_train_all',
    'day_kitchen',
    'lodge_day',
    'midori_am', 'midori_pm', 'midori_day', 'midori_eve',
    'sauna_1', 'sauna_2', 'sauna_3', 'sauna_4', 'plan_sauna_futami',
    'tennis', 'tennis_full', 'tennis_half', // 月俯瞰に行は無いが分類は揃えておく
  ];

  function toSet(list) {
    var set = {};
    for (var i = 0; i < list.length; i++) set[list[i]] = true;
    return set;
  }
  var STAY_SET = toSet(STAY_PLAN_IDS);
  var DAY_SET = toSet(DAY_PLAN_IDS);

  function isStayPlan(planId) {
    return typeof planId === 'string' && STAY_SET[planId] === true;
  }
  function isDayPlan(planId) {
    return typeof planId === 'string' && DAY_SET[planId] === true;
  }

  // ─────────────────────────────────────────
  // 1予約が「その日に何であるか」
  // ─────────────────────────────────────────
  //
  //   'in'    チェックイン日（その日から泊まり始める）
  //   'mid'   中日（前日から続いていて、翌日も泊まる）
  //   'out'   チェックアウト日（その日の朝に出る）
  //   'day'   日帰り利用
  //   'other' 分類できないプラン（＝従来どおり数で扱う）
  //
  // ★判定は startDate / endDate だけを見る。nights は使わない。
  //   旧クライアントは日帰りにも nights=1 / endDate=翌日 を送っていた時期があり、
  //   canonical 化前に保存された予約は nights の値が当てにならない。planId で
  //   宿泊/日帰りを決め、日付は startDate/endDate で決めるのが最も安全。
  function reservationRoleOnDate(reservation, date) {
    var planId = reservation && reservation.planId;
    var startDate = reservation && reservation.startDate;
    var endDate = reservation && reservation.endDate;

    if (isDayPlan(planId)) return 'day';
    if (!isStayPlan(planId)) return 'other';
    if (typeof startDate !== 'string' || typeof date !== 'string') return 'other';

    // startDate を先に見る。endDate === startDate の壊れた/旧データでも
    // 「OUT だけの予約」にはならない（＝件数が消えない）。
    if (date === startDate) return 'in';
    if (typeof endDate === 'string' && date === endDate) return 'out';
    if (typeof endDate === 'string' && date > startDate && date < endDate) return 'mid';
    return 'other';
  }

  // ─────────────────────────────────────────
  // セル1つぶんの集計
  // ─────────────────────────────────────────
  function ledgerCellMarks(reservations, date) {
    var marks = { in: 0, mid: 0, out: 0, day: 0, other: 0 };
    var list = Array.isArray(reservations) ? reservations : [];
    for (var i = 0; i < list.length; i++) {
      marks[reservationRoleOnDate(list[i], date)] += 1;
    }
    return marks;
  }

  /**
   * 実際にその日「利用がある」件数。
   * OUT（朝に出るだけ）は含めない＝チェックアウト日は新しい宿泊を受けられるため、
   * 満室色で塗ると空きを見落とす。
   */
  function activeCount(marks) {
    return marks.in + marks.mid + marks.day + marks.other;
  }

  /** その日に何かしら触れている総件数（詳細ポップアップを開けるかの判定に使う）。 */
  function totalCount(marks) {
    return activeCount(marks) + marks.out;
  }

  /**
   * その日に実際に埋まっている「施設の数」。
   *
   * ★キャンプ場のように複数施設を1行へ集約している行では、予約の「件数」と
   *   埋まった「区画数」が一致しない。1組が8区画すべてを貸切った日は件数1なので、
   *   件数で色を決めると満室の日が薄い色（空きあり）に見える。
   *   2026-08-25 に区画上限を 3→8 へ広げた（要望③）ことで実際に起こりうるようになった。
   *
   * OUT（その日の朝に出るだけ）は数えない＝ledgerCellLevel の従来の考え方（チェックアウト日は
   * 新しい宿泊を受けられる）をそのまま踏襲する。
   * roomIds を持たない旧データは 1 施設として数える（0件にして空きに見せない）。
   */
  function ledgerActiveUnits(reservations, date) {
    var seen = {};
    var count = 0;
    var list = Array.isArray(reservations) ? reservations : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (reservationRoleOnDate(r, date) === 'out') continue;
      var rooms = (r && Array.isArray(r.roomIds)) ? r.roomIds : [];
      if (rooms.length === 0) { count += 1; continue; }
      for (var j = 0; j < rooms.length; j++) {
        var key = String(rooms[j]);
        if (!seen[key]) { seen[key] = true; count += 1; }
      }
    }
    return count;
  }

  // ─────────────────────────────────────────
  // 表示する行（上から時系列：朝に出る → 日中 → 泊まる）
  // ─────────────────────────────────────────
  //
  // 返り値: [{ text: 'out', kind: 'out' }, { text: 'IN', kind: 'in' }, ...]
  //   kind は staff2.html 側の CSS クラス（.mark-out / .mark-day / .mark-mid / .mark-in）に対応。
  //
  // 件数は2件以上のときだけ添える（キャンプ場は8区画を1行に集約しているため
  // 「IN3」「out2」が出る。1部屋1行の部屋では常に1件なので数字は出ない）。
  //
  // 最大3行。物理的にそれ以上は起きない：
  //   部屋   … 宿泊の中日は 0-9時と16-23時を占有するので日帰りと併存できない → 最大2行
  //   ロッジ … 日帰りが10-15時なので out(0-9) + 日(10-15) + IN(16-) の3行が最大
  //   キャンプ… 日帰りプランが無いので out + 泊 + IN の3行が最大
  function ledgerCellLines(marks) {
    var lines = [];
    function push(kind, label, count) {
      if (count <= 0) return;
      lines.push({ kind: kind, text: count > 1 ? label + count : label });
    }
    push('out', 'out', marks.out);
    push('day', '日', marks.day);
    push('mid', '泊', marks.mid);
    push('in', 'IN', marks.in);
    return lines;
  }

  // ─────────────────────────────────────────
  // セルの色レベル
  // ─────────────────────────────────────────
  //
  //   'empty'    予約なし
  //   'out-only' その日は朝に出るだけ（＝新しい宿泊は受けられる）
  //   'some'     一部予約
  //   'many'     多め
  //   'full'     満
  //
  // capacity … その行が代表している施設の数（キャンプ場は8区画で1行）。
  //   省略・1以下なら1部屋1行とみなし、従来の月俯瞰と同じしきい値（見慣れた色を変えない）。
  //
  // ★複数施設をまとめた行に1部屋1行のしきい値を当てると「満」が早すぎる。
  //   キャンプ場は8区画あるので4件で赤「満」になり、半分空いているのに運営が
  //   予約を断りかねない（2026-08-17 のレビュー指摘）。埋まった区画の数を
  //   区画数と比べて決める：全部埋まって初めて「満」、半分を超えたら「多め」。
  //
  // activeUnits … 実際に埋まっている施設の数（ledgerActiveUnits の返り値）。
  //   capacity > 1 の行でだけ使う。省略時は従来どおり「予約件数」で判定する
  //   （呼び出し元を一度に直さなくても壊れないため）。
  //   ★1予約が複数区画を取るキャンプ場では、件数と埋まった区画数が一致しない。
  //     ここを件数のままにすると、1組が8区画を貸切った日が「空きあり」に見える。
  function ledgerCellLevel(marks, capacity, activeUnits) {
    var active = activeCount(marks);
    if (active === 0) return marks.out > 0 ? 'out-only' : 'empty';
    var cap = (typeof capacity === 'number' && capacity > 1) ? capacity : 0;
    if (cap === 0) {
      if (active === 1) return 'some';
      if (active <= 3) return 'many';
      return 'full';
    }
    var filled = (typeof activeUnits === 'number' && activeUnits > 0) ? activeUnits : active;
    if (filled >= cap) return 'full';
    if (filled * 2 >= cap) return 'many';
    return 'some';
  }

  return {
    STAY_PLAN_IDS: STAY_PLAN_IDS,
    DAY_PLAN_IDS: DAY_PLAN_IDS,
    isStayPlan: isStayPlan,
    isDayPlan: isDayPlan,
    reservationRoleOnDate: reservationRoleOnDate,
    ledgerCellMarks: ledgerCellMarks,
    ledgerCellLines: ledgerCellLines,
    ledgerCellLevel: ledgerCellLevel,
    ledgerActiveUnits: ledgerActiveUnits,
    activeCount: activeCount,
    totalCount: totalCount,
  };
});
