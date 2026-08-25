/**
 * 公園の連絡先とキャンセル案内（公開画面用の正本）。
 *
 * 2026-08-25 新設（運営要望⑨）。
 * ★サーバ側の正本は functions/src/lib/contact.ts。値は必ず一致させること
 *   （ドリフト検出は functions/tests/contact.test.ts が両方を読んで突合する）。
 *   index.html は Firebase SDK を読まない設計で TS モジュールを import できないため、
 *   同じ値をここに置く形にしている。
 *
 * 2026-08-11 に電話番号（089-986-0522 → 089-986-1559）を画面とメールの3箇所で
 * 同時に直す作業が発生した。キャンセル案内で出現箇所がさらに増えるため集約した。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NisshoContact = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PARK_TEL = '089-986-1559';
  var PARK_TEL_HOURS = '8:30〜17:30';
  var PARK_EMAIL = 'info@fureai-iyosasaeru.com';
  /** サウナ専用の問い合わせ先（2026-08-25 運営指定）。 */
  var SAUNA_EMAIL = 'futamisunsetsauna11.1@gmail.com';
  /**
   * キャンセルポリシーの掲載先。
   * ★料率はここに持たない＝規約が改定されたときにコードが古い数字を出し続けないため。
   *   （施設ごとに料率が違う：ふれあいの館／みどり・テニス／サウナ）
   */
  var CANCEL_POLICY_URL = 'https://www.fureai-iyosasaeru.com/terms/';

  /**
   * キャンセル・変更のご案内ブロック（HTML文字列）。
   * isSauna = true のときだけサウナ専用アドレスを併記する。
   */
  function cancelGuideHtml(isSauna) {
    var html = '<div class="cancel-guide">';
    html += '<div class="cancel-guide-title">ご予約の変更・キャンセルについて</div>';
    html += '<div class="cancel-guide-body">';
    html += 'お電話またはメールでご連絡ください。<br>';
    html += '<a href="tel:' + PARK_TEL.replace(/-/g, '') + '">' + PARK_TEL + '</a>（' + PARK_TEL_HOURS + '）<br>';
    html += '<a href="mailto:' + PARK_EMAIL + '">' + PARK_EMAIL + '</a>';
    if (isSauna) {
      html += '<br>サウナ専用：<a href="mailto:' + SAUNA_EMAIL + '">' + SAUNA_EMAIL + '</a>';
    }
    html += '<br><a href="' + CANCEL_POLICY_URL + '" target="_blank" rel="noopener noreferrer">キャンセル料について（利用規約）</a>';
    html += '</div></div>';
    return html;
  }

  return {
    PARK_TEL: PARK_TEL,
    PARK_TEL_HOURS: PARK_TEL_HOURS,
    PARK_EMAIL: PARK_EMAIL,
    SAUNA_EMAIL: SAUNA_EMAIL,
    CANCEL_POLICY_URL: CANCEL_POLICY_URL,
    cancelGuideHtml: cancelGuideHtml,
  };
}));
