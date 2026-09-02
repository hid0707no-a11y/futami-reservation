#!/usr/bin/env node
/**
 * 料金表 (docs/pricing.json) と index.html の PLANS 配列を機械的に照合する。
 * pre-commit でも CI でも手動でも回せる。
 *
 * 使い方:
 *   node scripts/verify_pricing.js
 *
 * 失敗すると exit code 1。成功すると "✅ all pricing matched" を出力。
 *
 * このスクリプトが守るもの:
 *   - テニス料金の誤読（240/280 を照明料と誤認した過去事故の再発防止）
 *   - みどり料金の typo
 *   - 平日割の数値（0.5 を 0.05 と書き間違える事故の防止）
 *   - 夜間照明の単価
 *
 * 更新時:
 *   1. 料金表原本が改定されたら docs/pricing.json を先に更新
 *   2. その後 index.html の PLANS を合わせる
 *   3. このスクリプトで照合→パスすればデプロイOK
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRICING_PATH = path.join(ROOT, 'docs', 'pricing.json');
const INDEX_PATH = path.join(ROOT, 'index.html');

const pricing = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
const html = fs.readFileSync(INDEX_PATH, 'utf8');

// PLANS 配列からプラン定義を抽出する簡易パーサ
// nested braces（hourlyRange 等）を跨ぐため、ブレースカウントで対応する
function extractPlan(planId) {
  const startMarker = `id: '${planId}'`;
  const startIdx = html.indexOf(startMarker);
  if (startIdx < 0) throw new Error(`plan not found in index.html: ${planId}`);
  // start から逆向きに最初の `{` を見つける
  let open = startIdx;
  while (open > 0 && html[open] !== '{') open--;
  if (html[open] !== '{') throw new Error(`open brace not found for ${planId}`);
  // そこから前向きにブレース数を数えて閉じを探す
  let depth = 0;
  let end = open;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = html.slice(open, end + 1);
  const numField = (name) => {
    const match = block.match(new RegExp(`\\b${name}:\\s*(\\d+)`));
    return match ? parseInt(match[1], 10) : null;
  };
  return {
    id: planId,
    block,
    basePrice: numField('basePrice'),
    residentPrice: numField('residentPrice'),
    nonResidentPrice: numField('nonResidentPrice'),
    studentPrice: numField('studentPrice'),
    studentNonResidentPrice: numField('studentNonResidentPrice'),
    lightingPrice: numField('lightingPrice'),
    lightingHours: numField('lightingHours'),
    weekdayDiscountResident: numField('weekdayDiscountResident'),
    weekdayDiscountNonResident: numField('weekdayDiscountNonResident'),
  };
}

function check(label, expected, actual) {
  if (expected === actual) {
    console.log(`  ✅ ${label}: ${actual}`);
    return true;
  }
  console.error(`  ❌ ${label}: expected ${expected}, got ${actual}`);
  return false;
}

let pass = 0;
let fail = 0;
function run(label, fn) {
  console.log(`\n[${label}]`);
  const ok = fn();
  if (ok) pass++;
  else fail++;
}

// === テニス 一面貸切 ===
run('tennis_full (一面貸切)', () => {
  const plan = extractPlan('tennis_full');
  const spec = pricing.tennis.full;
  return [
    check('residentPrice', spec.resident, plan.residentPrice),
    check('nonResidentPrice', spec.nonResident, plan.nonResidentPrice),
    check('basePrice', spec.resident, plan.basePrice),
    check('lightingPrice', pricing.tennis.lighting.price, plan.lightingPrice),
    check('weekdayDiscountResident', spec.weekdayDiscount.resident, plan.weekdayDiscountResident),
    check('weekdayDiscountNonResident', spec.weekdayDiscount.nonResident, plan.weekdayDiscountNonResident),
  ].every(Boolean);
});

// === テニス 半面練習 ===
// 2026-05-13 削除（要望#11）→ 2026-07-22 復活。半面は壁打ちコート(court_wall)専用・
// 1枠(1時間)定額（2026-07-21 上村さん回答で確定）。
run('tennis_half (半面・壁打ち練習用)', () => {
  const plan = extractPlan('tennis_half');
  const spec = pricing.tennis.half;
  return [
    check('residentPrice', spec.resident, plan.residentPrice),
    check('nonResidentPrice', spec.nonResident, plan.nonResidentPrice),
    check('basePrice', spec.resident, plan.basePrice),
    check('lightingPrice', pricing.tennis.lighting.price, plan.lightingPrice),
    check('weekdayDiscountResident', spec.weekdayDiscount.resident, plan.weekdayDiscountResident),
    check('weekdayDiscountNonResident', spec.weekdayDiscount.nonResident, plan.weekdayDiscountNonResident),
    // 定額の生命線: 人数を掛ける旧表記・旧実装が再発していないか（perPerson フィールド禁止）
    check('perPerson禁止', false, /perPerson/.test(plan.block)),
    // 在庫はコートA〜Eではなく壁打ちコート専用
    check('rooms=court_wall', true, /rooms:\s*\['court_wall'\]/.test(plan.block)),
  ].every(Boolean);
});

// === みどり 午前 ===
run('midori_am (みどり午前)', () => {
  const plan = extractPlan('midori_am');
  const spec = pricing.midori.am;
  return [
    check('residentPrice', spec.resident, plan.basePrice),
    check('nonResidentPrice', spec.nonResident, plan.nonResidentPrice),
    check('studentResident', spec.studentResident, plan.studentPrice),
    check('studentNonResident', spec.studentNonResident, plan.studentNonResidentPrice),
  ].every(Boolean);
});

// === みどり 午後 ===
run('midori_pm (みどり午後)', () => {
  const plan = extractPlan('midori_pm');
  const spec = pricing.midori.pm;
  return [
    check('residentPrice', spec.resident, plan.basePrice),
    check('nonResidentPrice', spec.nonResident, plan.nonResidentPrice),
    check('studentResident', spec.studentResident, plan.studentPrice),
    check('studentNonResident', spec.studentNonResident, plan.studentNonResidentPrice),
  ].every(Boolean);
});

// === みどり 夜間 + 夜間照明 ===
run('midori_eve (みどり夜間)', () => {
  const plan = extractPlan('midori_eve');
  const specPlan = pricing.midori.eve;
  const specLight = pricing.midori.lighting;
  return [
    check('residentPrice', specPlan.resident, plan.basePrice),
    check('nonResidentPrice', specPlan.nonResident, plan.nonResidentPrice),
    check('studentResident', specPlan.studentResident, plan.studentPrice),
    check('studentNonResident', specPlan.studentNonResident, plan.studentNonResidentPrice),
    check('lightingPrice', specLight.price, plan.lightingPrice),
    check('lightingHours', specLight.maxHours, plan.lightingHours),
  ].every(Boolean);
});

// === みどり 日中 (2026-05-04 追加) ===
run('midori_day (みどり日中通し)', () => {
  const plan = extractPlan('midori_day');
  const spec = pricing.midori.day;
  return [
    check('residentPrice', spec.resident, plan.basePrice),
    check('nonResidentPrice', spec.nonResident, plan.nonResidentPrice),
    check('studentResident', spec.studentResident, plan.studentPrice),
    check('studentNonResident', spec.studentNonResident, plan.studentNonResidentPrice),
    // 内部整合性: am + pm = day
    check('day = am + pm (resident)', pricing.midori.am.resident + pricing.midori.pm.resident, spec.resident),
    check('day = am + pm (nonResident)', pricing.midori.am.nonResident + pricing.midori.pm.nonResident, spec.nonResident),
  ].every(Boolean);
});

// === 室別 日帰り日中 (2026-05-04 追加) ===
run('day_xx_daytime (室別 日中通し 8:30-17:00)', () => {
  const day27 = extractPlan('day_27_daytime');
  const dayExp = extractPlan('day_exp_daytime');
  const dayTrain = extractPlan('day_train_daytime');
  const spec = pricing.roomDay;
  return [
    check('day_27_daytime.basePrice', spec.twentySeven.daytime, day27.basePrice),
    check('day_exp_daytime.basePrice', spec.experience.daytime, dayExp.basePrice),
    check('day_train_daytime.basePrice', spec.training.daytime, dayTrain.basePrice),
    // 内部整合性: am + pm = daytime
    check('27畳 daytime = am + pm', spec.twentySeven.am + spec.twentySeven.pm, spec.twentySeven.daytime),
    check('体験 daytime = am + pm', spec.experience.am + spec.experience.pm, spec.experience.daytime),
    check('研修 daytime = am + pm', spec.training.am + spec.training.pm, spec.training.daytime),
  ].every(Boolean);
});

// === 平日割の実装確認 ===
run('平日割の実装確認', () => {
  // 新実装: 料金表の固定値を使う。PLANS に weekdayDiscountResident/weekdayDiscountNonResident が設定され、
  // pricing.js (calculateHourlyTennisPrice) で discountPrice として読み取っているか確認。
  // 2026-05-13 リファクタで料金計算コアが index.html → assets/js/pricing.js へ移動。
  const pricingJsPath = path.join(ROOT, 'assets', 'js', 'pricing.js');
  const pricingJs = fs.existsSync(pricingJsPath) ? fs.readFileSync(pricingJsPath, 'utf8') : '';
  const combined = html + '\n' + pricingJs;
  const hasFixedFields = /weekdayDiscountResident:\s*\d+/.test(html)
    && /weekdayDiscountNonResident:\s*\d+/.test(html);
  // ★pricing.js 単独で fallback ロジックが存在することを必須化（2026-05-13 追加）
  // ※ index.html へ間違って戻したリグレッションを検知できる
  const usesFixedFieldsInPricing = /plan\.weekdayDiscountResident/.test(pricingJs)
    && /plan\.weekdayDiscountNonResident/.test(pricingJs);
  const hasFallbackInPricing = /Math\.ceil\(\s*normalPrice\s*\*\s*0\.5\s*\/\s*10\s*\)\s*\*\s*10/.test(pricingJs);
  if (!usesFixedFieldsInPricing) {
    console.error('  ❌ pricing.js が plan.weekdayDiscountResident/NonResident を参照していない');
    return false;
  }
  if (!hasFallbackInPricing) {
    console.error('  ❌ pricing.js に Math.ceil(normalPrice*0.5/10)*10 のフォールバックがない');
    return false;
  }
  const usesFixedFields = /plan\.weekdayDiscountResident/.test(combined)
    && /plan\.weekdayDiscountNonResident/.test(combined);
  // フォールバックロジックも検証（範囲外の為の保険）
  const hasFallback = /Math\.ceil\(\s*normalPrice\s*\*\s*0\.5\s*\/\s*10\s*\)\s*\*\s*10/.test(combined);
  const ok1 = hasFixedFields;
  const ok2 = usesFixedFields;
  const ok3 = hasFallback;
  if (ok1 && ok2 && ok3) {
    console.log('  ✅ 平日割の固定値テーブル + フォールバック実装を確認');
    return true;
  }
  console.error('  ❌ 平日割の実装パターンが変化している可能性');
  console.error('     hasFixedFields=' + ok1 + ' usesFixedFields=' + ok2 + ' hasFallback=' + ok3);
  return false;
});

// === 利用人数目安の上限 ===
// 空間貸し運用で料金には影響しないが、行政報告用に入力を受け付けている。
// プラン定義に guestEstimateMax が正しく設定されているかを確認する。
run('利用人数目安の上限設定', () => {
  const tennisFull = extractPlan('tennis_full');
  const midoriAm = extractPlan('midori_am');
  const midoriPm = extractPlan('midori_pm');
  const midoriEve = extractPlan('midori_eve');
  // extractPlan に guestEstimateMax を追加していないのでここは block 直接 grep
  const parseMax = (p) => {
    const m = p.block.match(/guestEstimateMax:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  return [
    check('tennis_full.guestEstimateMax', 10, parseMax(tennisFull)),
    check('tennis_half.guestEstimateMax', 10, parseMax(extractPlan('tennis_half'))),
    check('midori_am.guestEstimateMax', pricing.midori.guestEstimateMax.value, parseMax(midoriAm)),
    check('midori_pm.guestEstimateMax', pricing.midori.guestEstimateMax.value, parseMax(midoriPm)),
    check('midori_eve.guestEstimateMax', pricing.midori.guestEstimateMax.value, parseMax(midoriEve)),
    check('midori_day.guestEstimateMax', pricing.midori.guestEstimateMax.value, parseMax(extractPlan('midori_day'))),
  ].every(Boolean);
});

// === サウナ基本料金 + オプション ===
run('sauna (サウナ料金・オプション)', () => {
  const plan = extractPlan('sauna_1');
  const spec = pricing.sauna;
  const ok1 = check('basePrice', spec.base.price, plan.basePrice);
  // extras からオプション料金を取得
  const parseExtra = (id) => {
    const re = new RegExp(`id:\\s*'${id}'[^}]*price:\\s*(\\d+)`);
    const m = plan.block.match(re);
    return m ? parseInt(m[1], 10) : null;
  };
  const ok2 = check('towel', spec.options.towel.price, parseExtra('towel'));
  const ok3 = check('tarpTent', spec.options.tarpTent.price, parseExtra('tarp_tent'));
  const ok4 = check('ice', spec.options.ice.price, parseExtra('ice'));
  return [ok1, ok2, ok3, ok4].every(Boolean);
});

// === 職員画面のサウナ料金（2026-09-02 追加）===
// ★staff.html は長らくこの照合の対象外で、4枠すべてが 12,000円（税別）のまま
//   サーバ・公開画面・公示料金表の 13,200円（税込）と食い違っていた。
//   電話受付の職員がこの表を見て案内すると1件あたり1,200円の取りこぼしになる。
//   「index.html だけ見ていれば料金は揃う」が成り立たないので、ここで staff.html も見る。
run('staff.html のサウナ料金（職員画面）', () => {
  const staffPath = path.join(ROOT, 'staff.html');
  if (!fs.existsSync(staffPath)) {
    console.error('  ❌ staff.html が見つからない');
    return false;
  }
  const staffHtml = fs.readFileSync(staffPath, 'utf8');
  const expected = pricing.sauna && pricing.sauna.base && pricing.sauna.base.price;
  if (typeof expected !== 'number') {
    console.error('  ❌ docs/pricing.json からサウナの正価を読めない');
    return false;
  }
  const expectedText = expected.toLocaleString('en-US') + '円';
  let ok = true;
  for (const id of ['sauna_1', 'sauna_2', 'sauna_3', 'sauna_4']) {
    const m = staffHtml.match(new RegExp(`id:\\s*'${id}'[^}]*price:\\s*'([^']+)'`));
    const actual = m ? m[1] : null;
    if (actual !== expectedText) {
      console.error(`  ❌ staff.html ${id}: 期待 ${expectedText} / 実際 ${actual}`);
      ok = false;
    } else {
      console.log(`  ✓ staff.html ${id}: ${actual}`);
    }
  }
  return ok;
});

console.log(`\n========================================`);
console.log(`結果: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('❌ pricing mismatch detected. 料金表 (docs/pricing.json) と index.html の整合が取れていません。');
  process.exit(1);
}
console.log('✅ all pricing matched');
