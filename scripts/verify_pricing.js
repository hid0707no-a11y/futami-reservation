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
  ].every(Boolean);
});

// === テニス 半面練習 ===
run('tennis_half (半面練習)', () => {
  const plan = extractPlan('tennis_half');
  const spec = pricing.tennis.half;
  return [
    check('residentPrice', spec.resident, plan.residentPrice),
    check('nonResidentPrice', spec.nonResident, plan.nonResidentPrice),
    check('basePrice', spec.resident, plan.basePrice),
    check('lightingPrice', pricing.tennis.lighting.price, plan.lightingPrice),
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

// === 平日割の定数確認 ===
run('平日割の rate 確認', () => {
  // calculateTotal 内に `? 0.5 : 1` のハードコードがあるか
  const has05 = /\?\s*0\.5\s*:\s*1\b/.test(html);
  if (has05) {
    console.log('  ✅ 平日割 rate = 0.5 (hardcoded in calculateTotal)');
    return true;
  }
  console.error('  ❌ calculateTotal に 0.5 倍の平日割実装が見つからない');
  return false;
});

// === 半面人数上限 ===
run('半面人数上限', () => {
  const spec = pricing.tennis.half.maxGuests;
  const m = html.match(/stepTennisHalfGuests[\s\S]*?Math\.min\((\d+)/);
  const actual = m ? parseInt(m[1], 10) : null;
  return check('tennisHalfGuests max', spec, actual);
});

console.log(`\n========================================`);
console.log(`結果: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('❌ pricing mismatch detected. 料金表 (docs/pricing.json) と index.html の整合が取れていません。');
  process.exit(1);
}
console.log('✅ all pricing matched');
