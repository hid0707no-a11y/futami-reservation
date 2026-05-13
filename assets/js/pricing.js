// ふたみ予約システム 価格計算 純粋関数ライブラリ
//
// 2026-05-13 新設（Evaluator 不足3 への対応）。index.html 内に inline で書かれていた
// 純粋関数群を切り出し、Jest テストの対象にする。
//
// 設計方針：
//  - 状態（state グローバル変数）に依存しない純粋関数のみを置く
//  - 呼び出し側は state から必要な値を取り出して引数渡しする
//  - ブラウザでは window.NisshoPricing 経由でアクセス
//  - Node/jest では module.exports 経由でアクセス（typeof module check）
//
// テスト：functions/tests/pricing.test.ts（jest jsdom 不要・純粋関数のため）

// 2026-05-13: root 解決を globalThis 優先に（strict mode / ESM 化耐性）
// 旧版は `this` フォールバックだったが strict mode で undefined になり、将来
// `<script type="module">` 化したら壊れる罠だった。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NisshoPricing = factory();
  }
})(
  typeof globalThis !== 'undefined' ? globalThis
    : typeof self !== 'undefined' ? self
    : typeof window !== 'undefined' ? window
    : this,
  function () {

  // ─────────────────────────────────────────
  // 日付・時刻ヘルパ
  // ─────────────────────────────────────────

  /** YYYY-MM-DD に n日加算した YYYY-MM-DD を返す（タイムゾーン安全）。 */
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  /**
   * "HHMM" 形式の時刻に分を加算して "HHMM" を返す。
   *
   * 2026-05-13: HH の 24時超え (例 '2430') を出さないよう mod 24 正規化する。
   * 旧版は 24:30 → '2430' のように桁あふれを返していた。テニス営業時間 8-22 では
   * 実害ゼロだが、将来営業時間が深夜帯に拡張された瞬間に slot key 整合が崩れる
   * 罠だったため事前修正。日跨ぎ判定は呼出側で別途行う（呼出側が同じ日付の
   * slot key を扱う前提なので、本関数では 24h で wrap するだけ）。
   */
  function addMinutes(timeStr, mins) {
    const h = parseInt(timeStr.slice(0, 2), 10);
    const m = parseInt(timeStr.slice(2), 10);
    let total = h * 60 + m + mins;
    // 24h で wrap（負の値も正規化）
    const dayMin = 24 * 60;
    total = ((total % dayMin) + dayMin) % dayMin;
    const nh = Math.floor(total / 60);
    const nm = total % 60;
    return String(nh).padStart(2, '0') + String(nm).padStart(2, '0');
  }

  /** YYYY-MM-DD → "M月D日(曜)" 表記。 */
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + days[d.getDay()] + ')';
  }

  // ─────────────────────────────────────────
  // 連泊スロット展開（plan + baseDate + nights → [{date,hour},...]）
  // ─────────────────────────────────────────

  /**
   * 宿泊・キャンプの slot を「日付×時刻」配列に展開する。
   *
   * slots 配列の先頭をチェックイン時刻として扱い、それより前の時刻は翌日扱いにする。
   * 例：stay は slots=[16..23, 0..9]、checkinHour=16 → 0-9 は翌日。
   */
  function expandStaySlots(plan, baseDate, nights) {
    const slots = Array.isArray(plan.slots) ? plan.slots : [];
    if (slots.length === 0) return [];

    const checkinHour = slots[0];
    const result = [];
    for (let n = 0; n < nights; n++) {
      const checkinDate = addDays(baseDate, n);
      const nextDate = addDays(baseDate, n + 1);
      for (const h of slots) {
        const date = h < checkinHour ? nextDate : checkinDate;
        result.push({ date: date, hour: h });
      }
    }
    return result;
  }

  // ─────────────────────────────────────────
  // 価格計算コア
  // ─────────────────────────────────────────

  /**
   * 宿泊（planType=stay）の料金計算。室数倍率（複数選択 UI 対応）と人数加算と泊数を反映。
   *
   * @param plan          {basePrice, extraAdult, extraChild, extraInfant}
   * @param opts.roomCount     選択中の部屋数（>=1）
   * @param opts.nights        泊数（>=1）
   * @param opts.guestsAdult   中学生以上の人数
   * @param opts.guestsChild   小学生の人数
   * @param opts.guestsInfant  小学生未満の人数
   */
  function calculateStayPrice(plan, opts) {
    const roomCount = Math.max(1, opts.roomCount || 1);
    const nights = Math.max(1, opts.nights || 1);
    const baseCost = plan.basePrice * roomCount;
    const adultCost = (plan.extraAdult || 0) * (opts.guestsAdult || 0);
    const childCost = (plan.extraChild || 0) * (opts.guestsChild || 0);
    const infantCost = (plan.extraInfant || 0) * (opts.guestsInfant || 0);
    return (baseCost + adultCost + childCost + infantCost) * nights;
  }

  /**
   * テニス一面貸切（hourly + tennis_full）の料金計算。
   * 平日割は料金表の固定値（weekdayDiscountResident/NonResident）を優先。
   * フィールド未設定時は Math.ceil(price*0.5/10)*10 を fallback。
   * 複数コート選択（要望#7）は courtCount で倍率指定。
   *
   * @param plan                  プラン定義
   * @param opts.hours            選択時間（"0900","0930"... の HHMM 配列）
   * @param opts.isResident       市民フラグ
   * @param opts.useLighting      照明 ON/OFF
   * @param opts.courtCount       選択コート数（>=1）
   * @param opts.isWeekdayDiscountHour  (hour: string) => boolean
   */
  function calculateHourlyTennisPrice(plan, opts) {
    const hours = Array.isArray(opts.hours) ? opts.hours : [];
    const courtCount = Math.max(1, opts.courtCount || 1);
    const normalPrice = opts.isResident ? plan.residentPrice : plan.nonResidentPrice;
    const fallbackDiscount = Math.ceil(normalPrice * 0.5 / 10) * 10;
    const discountPrice = opts.isResident
      ? (plan.weekdayDiscountResident != null ? plan.weekdayDiscountResident : fallbackDiscount)
      : (plan.weekdayDiscountNonResident != null ? plan.weekdayDiscountNonResident : fallbackDiscount);
    let total = 0;
    for (const h of hours) {
      const isDiscounted = plan.weekdayDiscount && opts.isWeekdayDiscountHour && opts.isWeekdayDiscountHour(h);
      total += (isDiscounted ? discountPrice : normalPrice) * courtCount;
    }
    if (opts.useLighting && plan.lightingPrice) {
      total += plan.lightingPrice * hours.length * courtCount;
    }
    return total;
  }

  /**
   * キャンプ（planType=camp）の料金計算。
   * テント追加（旧 50円/張）は 2026-05-13 廃止（要望#10）。
   */
  function calculateCampPrice(plan, opts) {
    const siteCount = Math.max(0, opts.siteCount || 0);
    const nights = Math.max(1, opts.nights || 1);
    return plan.basePrice * siteCount * nights;
  }

  return {
    addDays: addDays,
    addMinutes: addMinutes,
    formatDate: formatDate,
    expandStaySlots: expandStaySlots,
    calculateStayPrice: calculateStayPrice,
    calculateHourlyTennisPrice: calculateHourlyTennisPrice,
    calculateCampPrice: calculateCampPrice,
  };
});
