// 公園の連絡先とキャンセル案内の SSOT。
//
// 2026-08-25 新設（運営要望⑨）。それまで電話番号は index.html / mail.ts の3箇所に
// 直書きされており、2026-08-11 に「089-986-0522（誤）」を3箇所とも直す作業が発生した。
// キャンセル案内で連絡先の出現箇所がさらに増えるため、サーバ側の正本をここへ集約する。
//
// ★公開画面（index.html）は Firebase SDK を読まない設計でこのモジュールを import できないため、
//   画面側の正本は assets/js/contact.js に置く（値は本ファイルと一致させること）。
//   ドリフト検出は functions/tests/contact.test.ts が index.html / assets/js/contact.js を
//   読んで突合する。

/** 公園代表の電話番号。 */
export const PARK_TEL = '089-986-1559';

/** 電話受付時間（assets/js/contact.js の PARK_TEL_HOURS と一致させる・突合はテスト）。 */
export const PARK_TEL_HOURS = '8:30〜17:30';

/** 公園代表のメールアドレス。 */
export const PARK_EMAIL = 'info@fureai-iyosasaeru.com';

/**
 * サウナ専用の問い合わせ先（2026-08-25 運営指定）。
 * サウナの予約・キャンセルはこちらでも受け付ける。
 */
export const SAUNA_EMAIL = 'futamisunsetsauna11.1@gmail.com';

/**
 * キャンセルポリシーの掲載先。
 * ★公式サイトの「利用規約」ページにキャンセル料が載っている（施設ごとに料率が異なる）。
 *   金額・料率はこちらに持たない＝規約が改定された時にコードが古い数字を出し続けないため。
 */
export const CANCEL_POLICY_URL = 'https://www.fureai-iyosasaeru.com/terms/';

/**
 * 顧客向けメール末尾に入れるキャンセル・変更の案内。
 * サウナ予約のときだけサウナ専用アドレスを併記する。
 */
export function cancelGuideText(isSauna: boolean): string {
  const contactLines = [`TEL: ${PARK_TEL}（${PARK_TEL_HOURS}）`, `MAIL: ${PARK_EMAIL}`];
  if (isSauna) contactLines.push(`サウナ専用: ${SAUNA_EMAIL}`);
  return `【ご予約の変更・キャンセル】
お電話またはメールでご連絡ください。
${contactLines.join('\n')}

キャンセル料については利用規約をご覧ください。
${CANCEL_POLICY_URL}`;
}
