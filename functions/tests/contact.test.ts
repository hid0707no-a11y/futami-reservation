// 連絡先・キャンセル案内のドリフト検出（2026-08-25 運営要望⑨）
//
// 電話番号は 2026-08-11 に 089-986-0522 → 089-986-1559 の修正を画面とメールの3箇所で
// 同時に行う作業が発生した（うち1箇所は「予約した客が繋がらない番号に掛けていた」）。
// キャンセル案内で出現箇所がさらに増えるため、
//   サーバ = functions/src/lib/contact.ts
//   公開画面 = assets/js/contact.js
// の2本を正本にし、値が食い違ったらここで落とす。

import * as fs from 'fs';
import * as path from 'path';
import { PARK_TEL, PARK_TEL_HOURS, PARK_EMAIL, SAUNA_EMAIL, CANCEL_POLICY_URL, cancelGuideText } from '../src/lib/contact';

const ROOT = path.join(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClientContact = require('../../assets/js/contact.js');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('連絡先の正本がサーバと公開画面で一致している', () => {
  it('電話番号', () => {
    expect(ClientContact.PARK_TEL).toBe(PARK_TEL);
    expect(PARK_TEL).toBe('089-986-1559');
  });
  it('電話受付時間（2026-08-26 追加・メールと画面で食い違わない）', () => {
    expect(ClientContact.PARK_TEL_HOURS).toBe(PARK_TEL_HOURS);
    expect(cancelGuideText(false)).toContain(PARK_TEL_HOURS);
  });
  it('代表メールアドレス', () => {
    expect(ClientContact.PARK_EMAIL).toBe(PARK_EMAIL);
  });
  it('サウナ専用メールアドレス（2026-08-25 運営指定）', () => {
    expect(ClientContact.SAUNA_EMAIL).toBe(SAUNA_EMAIL);
    expect(SAUNA_EMAIL).toBe('futamisunsetsauna11.1@gmail.com');
  });
  it('キャンセルポリシーの掲載先', () => {
    expect(ClientContact.CANCEL_POLICY_URL).toBe(CANCEL_POLICY_URL);
    expect(CANCEL_POLICY_URL).toBe('https://www.fureai-iyosasaeru.com/terms/');
  });
});

describe('キャンセル案内の中身', () => {
  it('サーバ：電話・メール・規約リンクを含む', () => {
    const text = cancelGuideText(false);
    expect(text).toContain(PARK_TEL);
    expect(text).toContain(PARK_EMAIL);
    expect(text).toContain(CANCEL_POLICY_URL);
  });
  it('サーバ：サウナ以外にサウナ専用アドレスを出さない', () => {
    expect(cancelGuideText(false)).not.toContain(SAUNA_EMAIL);
    expect(cancelGuideText(true)).toContain(SAUNA_EMAIL);
  });
  it('画面：サウナ以外にサウナ専用アドレスを出さない', () => {
    expect(ClientContact.cancelGuideHtml(false)).not.toContain(SAUNA_EMAIL);
    expect(ClientContact.cancelGuideHtml(true)).toContain(SAUNA_EMAIL);
  });
  it('画面：規約リンクは別タブ＋rel=noopener', () => {
    const html = ClientContact.cancelGuideHtml(false);
    expect(html).toContain('href="' + CANCEL_POLICY_URL + '"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it('画面：料率の数字をコードに持たない（規約改定で古い数字が残らないように）', () => {
    const html = ClientContact.cancelGuideHtml(true);
    expect(html).not.toMatch(/\d+\s*[%％]/);
  });
});

describe('index.html が案内ブロックを組み込んでいる', () => {
  it('contact.js をキャッシュ破棄つきで読んでいる', () => {
    expect(indexHtml).toMatch(/assets\/js\/contact\.js\?v=\d{8}/);
  });
  it('最終確認画面と完了画面の両方に差し込み口がある', () => {
    expect(indexHtml).toContain('id="review-cancel-guide"');
    expect(indexHtml).toContain('id="done-cancel-guide"');
  });
  it('旧「確定後の変更は電話にてご連絡ください」だけの案内が残っていない', () => {
    expect(indexHtml).not.toContain('確定後の変更は電話にてご連絡ください');
  });
  it('連絡先を index.html に直書きしていない（.info-section の施設情報を除く）', () => {
    // .info-section は施設案内としての掲載なので対象外。ここで見るのは
    // 「キャンセル案内のために新しく直書きが増えていないか」。
    const occurrences = indexHtml.split('089-986-1559').length - 1;
    expect(occurrences).toBeLessThanOrEqual(2); // 表示テキスト + tel: リンク
  });
});
