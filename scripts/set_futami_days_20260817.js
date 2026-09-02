#!/usr/bin/env node
/**
 * ふたみの日（Futami Special Day）の日付リストをルールから再計算して更新する
 *
 * 2026-08-17 運営（西田さん）要望：
 *   「毎月23日。23日が土・日・祝日に当たる場合は翌平日を代替日とする」
 *   （公式サイト https://www.fureai-iyosasaeru.com/ サウナページの記載どおり）
 *   ＋ 社長確認 2026-08-17：「火曜日も翌営業日でお願いします」
 *      → 公園の定休日は火曜（config/business_calendar.defaultClosedDays = [2]）。
 *        火曜に置くとカレンダーが「休」になり、ふたみマークも出ず予約導線が消える
 *        （index.html の disabled 判定でマーク描画ごと落ちるため、静かに開催なしになる）。
 *
 * ★9月までは触らない：2026-09-23 に既にふたみの日の予約が入っているため。
 *   適用は 2026-10-01 以降のみ（運営指示「10月以降のカレンダーから順次適用」）。
 *
 * 書き込み先：Firestore /config/special_days.sauna_capacity_days（配列）
 *   → Cloud Functions は lib/futamiDays.ts が 30秒キャッシュで読む（キャッシュは自然に切れる）。
 *   → 公開カレンダー・staff2 月俯瞰・料金(2,300円/人)・8名共有枠・通知メールが全部これ1本で連動する。
 *
 * 使い方:
 *   node scripts/set_futami_days_20260817.js          # DRY-RUN（差分表示のみ）
 *   node scripts/set_futami_days_20260817.js --apply  # 実書込み
 *   ※ firebase-admin は functions/node_modules にあるので functions ディレクトリから実行するか
 *      NODE_PATH=../functions/node_modules を付ける。
 */

const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
const CUTOVER = '2026-10-01';   // これ以降だけ入れ替える（9月までの既存予約を守る）
const UNTIL = { year: 2028, month: 3 };  // 現行リストと同じ地平線を維持

// 祝日テーブル（出典: https://holidays-jp.github.io/api/v1/date.json 取得 2026-08-17）
// 2028年ぶんは内閣府未公表のため、日付が法定で固定の祝日のみ手当てしてある。
// 対象は「23日〜その数日後」だけなので、変動祝日（春分・秋分）の未確定は影響しない。
const HOLIDAYS = new Set([
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
  '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22',
  '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11',
  '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23',
  '2028-01-01', '2028-02-11', '2028-02-23', '2028-03-20',
]);

const WD = '日月火水木金土';

/** businessDays.ts の isClosedDay と同じ規約：YYYY-MM-DD を UTC 日付として曜日を取る。 */
function utcDow(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isSatSunHoliday(dateStr) {
  const dow = utcDow(dateStr);
  return dow === 0 || dow === 6 || HOLIDAYS.has(dateStr);
}
/** 公園の休館日か（forceClosed > forceOpen > defaultClosedDays の順は businessDays.ts と同じ）。 */
function isParkClosed(dateStr, cal) {
  if (cal.forceClosed.includes(dateStr)) return true;
  if (cal.forceOpen.includes(dateStr)) return false;
  return cal.defaultClosedDays.includes(utcDow(dateStr));
}

/**
 * その月のふたみの日を返す。23日から始めて「土日祝でなく、かつ公園が開いている日」まで前に送る。
 * 送り先が無限に伸びないよう 14 日で打ち切る（実運用では最大でも数日）。
 */
function futamiDayForMonth(year, month, cal) {
  let d = `${year}-${String(month).padStart(2, '0')}-23`;
  for (let i = 0; i < 14; i++) {
    if (!isSatSunHoliday(d) && !isParkClosed(d, cal)) return d;
    d = addDays(d, 1);
  }
  throw new Error(`14日送っても営業日が見つからない: ${year}-${month}`);
}

admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
const db = admin.firestore();

(async () => {
  console.log('Mode:', APPLY ? '★APPLY（実書込み）' : 'DRY-RUN');
  console.log('');

  const [specialDoc, calDoc] = await Promise.all([
    db.doc('config/special_days').get(),
    db.doc('config/business_calendar').get(),
  ]);
  const calData = calDoc.exists ? calDoc.data() : {};
  const cal = {
    defaultClosedDays: Array.isArray(calData.defaultClosedDays) ? calData.defaultClosedDays : [2],
    forceOpen: Array.isArray(calData.forceOpen) ? calData.forceOpen : [],
    forceClosed: Array.isArray(calData.forceClosed) ? calData.forceClosed : [],
  };
  console.log('定休日(曜日番号 0=日):', cal.defaultClosedDays,
    '→', cal.defaultClosedDays.map(n => WD[n]).join('・') + '曜');

  const current = (specialDoc.exists && specialDoc.data().sauna_capacity_days) || [];
  const keep = current.filter(d => d < CUTOVER).sort();

  const recomputed = [];
  let y = Number(CUTOVER.slice(0, 4));
  let m = Number(CUTOVER.slice(5, 7));
  while (y < UNTIL.year || (y === UNTIL.year && m <= UNTIL.month)) {
    recomputed.push(futamiDayForMonth(y, m, cal));
    if (++m === 13) { m = 1; y++; }
  }

  const next = [...keep, ...recomputed];
  if (next.length > 365) throw new Error(`365件上限を超えた: ${next.length}`);

  console.log('');
  console.log(`■ ${CUTOVER} より前（据え置き・${keep.length}件）`);
  keep.forEach(d => console.log(`   ${d} (${WD[utcDow(d)]})`));

  console.log('');
  console.log(`■ ${CUTOVER} 以降（再計算・${recomputed.length}件）`);
  const beforeByMonth = new Map();
  current.filter(d => d >= CUTOVER).forEach(d => beforeByMonth.set(d.slice(0, 7), d));
  let changed = 0;
  for (const d of recomputed) {
    const before = beforeByMonth.get(d.slice(0, 7));
    const base = `${d.slice(0, 7)}-23`;
    const why = d === base ? '' : `23日(${WD[utcDow(base)]})が土日祝/定休日 → 翌営業日`;
    if (before !== d) {
      changed++;
      console.log(`   ${d} (${WD[utcDow(d)]})  ← 変更 (旧 ${before || 'なし'})  ${why}`);
    } else {
      console.log(`   ${d} (${WD[utcDow(d)]})    変更なし  ${why}`);
    }
  }

  console.log('');
  console.log(`合計 ${next.length}件 / 変更 ${changed}件`);

  if (!APPLY) {
    console.log('');
    console.log('DRY-RUN のため書き込みませんでした。--apply で反映します。');
    process.exit(0);
  }

  // ★3（Firestore 書込みはトランザクション内）に合わせる。handlers/availability.ts の
  //    POST /futamiDays と同じ形（merge + updatedAt）で書く。
  await db.runTransaction(async tx => {
    tx.set(
      db.doc('config/special_days'),
      {
        sauna_capacity_days: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  console.log('✅ 書き込み完了。Functions 側の30秒キャッシュが切れ次第、公開カレンダーへ反映されます。');
  process.exit(0);
})().catch(e => {
  console.error('失敗:', e.message);
  process.exit(1);
});
