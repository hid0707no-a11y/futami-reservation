// lib/labels.ts の単体テスト（2026-07-21 新設）
//
// 目的3つ：
//  1. 未知 ID が fail-visible（ID そのまま返却・空文字やクラッシュにしない）であること
//  2. サーバが受理しうる全 room / 全 plan にラベルが存在すること（＝メールに生IDが出ない）
//  3. ラベル文字列が index.html の ROOMS/PLANS と一字一句一致していること
//     （創作でないことの機械検証。片側だけ変更されたらこのテストが落ちる）

import * as fs from 'fs';
import * as path from 'path';
import { ROOM_LABELS, PLAN_LABELS, roomLabel, planLabel, formatRoomLabels } from '../src/lib/labels';
import { VALID_ROOM_IDS } from '../src/constants';
import { RESERVATION_PLAN_RULES } from '../src/lib/reservationPlans';

// index.html / staff.html に日本語名の定義が無く、創作を避けて未収録にした ID。
// （lib/labels.ts の ★要確認 コメントと対応。運営確認後にラベルを追加する）
const UNLABELED_ROOM_IDS = ['sauna_share'];
const UNLABELED_PLAN_IDS = ['plan_sauna_futami'];

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

/** index.html の `const NAME = [ ... ];` ブロックから { id, name } を抜き出す。 */
function parseIndexHtmlCatalog(arrayName: string): Record<string, string> {
  const block = new RegExp('const ' + arrayName + ' = \\[([\\s\\S]*?)\\n\\];').exec(INDEX_HTML);
  if (!block) throw new Error(`index.html に ${arrayName} 定義が見つからない`);
  const out: Record<string, string> = {};
  const entry = /\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block[1])) !== null) out[m[1]] = m[2];
  return out;
}

describe('labels: 未知IDは fail-visible', () => {
  it('未知の room ID は ID をそのまま返す', () => {
    expect(roomLabel('court_999')).toBe('court_999');
    expect(roomLabel('__proto__')).toBe('__proto__');
    expect(roomLabel('constructor')).toBe('constructor');
    expect(roomLabel('toString')).toBe('toString');
  });

  it('未知の plan ID は ID をそのまま返す', () => {
    expect(planLabel('tennis_quarter')).toBe('tennis_quarter');
    expect(planLabel('plan_sauna_futami')).toBe('plan_sauna_futami');
    expect(planLabel('hasOwnProperty')).toBe('hasOwnProperty');
  });

  it('空文字・非文字列でもクラッシュせず空文字を返す', () => {
    expect(roomLabel('')).toBe('');
    expect(planLabel('')).toBe('');
    expect(roomLabel(undefined)).toBe('');
    expect(roomLabel(null)).toBe('');
    expect(roomLabel(42)).toBe('');
    expect(planLabel({})).toBe('');
  });

  it('formatRoomLabels は配列以外・空配列で空文字（メール施設行が空になるだけ）', () => {
    expect(formatRoomLabels([])).toBe('');
    expect(formatRoomLabels(null)).toBe('');
    expect(formatRoomLabels(undefined)).toBe('');
    expect(formatRoomLabels('court_1')).toBe('');
  });

  it('formatRoomLabels は既知/未知が混在しても全件出す', () => {
    expect(formatRoomLabels(['court_1', 'court_2'])).toBe('コートA・コートB');
    expect(formatRoomLabels(['court_wall'])).toBe('半面コート（壁打ち練習用）');
    expect(formatRoomLabels(['court_1', 'court_zzz'])).toBe('コートA・court_zzz');
    expect(formatRoomLabels(['camp_1', 'camp_2'])).toBe('キャンプ区画①・キャンプ区画②');
  });
});

describe('labels: 半面プラン是正後の実表示', () => {
  it('tennis_half / court_wall が日本語で出る（生IDが顧客に届かない）', () => {
    expect(planLabel('tennis_half')).toBe('テニスコート（半面・練習用）');
    expect(roomLabel('court_wall')).toBe('半面コート（壁打ち練習用）');
  });

  it('tennis_full の複数コートも日本語で出る', () => {
    expect(planLabel('tennis_full')).toBe('テニスコート（一面貸切）');
    expect(formatRoomLabels(['court_1', 'court_2', 'court_3', 'court_4', 'court_5']))
      .toBe('コートA・コートB・コートC・コートD・コートE');
  });
});

describe('labels: 全room網羅', () => {
  const roomIds = Array.from(VALID_ROOM_IDS).sort();

  it.each(roomIds)('VALID_ROOM_IDS の %s にラベルがある（未確認IDは明示的な除外リストのみ）', id => {
    if (UNLABELED_ROOM_IDS.includes(id)) {
      expect(roomLabel(id)).toBe(id); // 未収録＝IDそのまま（fail-visible）
      return;
    }
    expect(Object.prototype.hasOwnProperty.call(ROOM_LABELS, id)).toBe(true);
    expect(roomLabel(id)).not.toBe(id);
    expect(roomLabel(id).length).toBeGreaterThan(0);
  });

  it('ROOM_LABELS に VALID_ROOM_IDS 外の余計なIDが無い', () => {
    for (const id of Object.keys(ROOM_LABELS)) {
      expect(VALID_ROOM_IDS.has(id)).toBe(true);
    }
  });
});

describe('labels: 全plan網羅', () => {
  const planIds = Object.keys(RESERVATION_PLAN_RULES).sort();

  it.each(planIds)('RESERVATION_PLAN_RULES の %s にラベルがある（未確認IDは明示的な除外リストのみ）', id => {
    if (UNLABELED_PLAN_IDS.includes(id)) {
      expect(planLabel(id)).toBe(id); // 未収録＝IDそのまま（fail-visible）
      return;
    }
    expect(Object.prototype.hasOwnProperty.call(PLAN_LABELS, id)).toBe(true);
    expect(planLabel(id)).not.toBe(id);
    expect(planLabel(id).length).toBeGreaterThan(0);
  });

  it('PLAN_LABELS に RESERVATION_PLAN_RULES 外の余計なIDが無い', () => {
    for (const id of Object.keys(PLAN_LABELS)) {
      expect(Object.prototype.hasOwnProperty.call(RESERVATION_PLAN_RULES, id)).toBe(true);
    }
  });
});

describe('labels: index.html との一字一句一致（創作でないことの検証）', () => {
  it('ROOM_LABELS は index.html の ROOMS[].name と一致する', () => {
    const html = parseIndexHtmlCatalog('ROOMS');
    expect(Object.keys(html).length).toBeGreaterThan(20); // パーサ健全性
    for (const [id, label] of Object.entries(ROOM_LABELS)) {
      expect(html[id]).toBe(label);
    }
  });

  it('PLAN_LABELS は index.html の PLANS[].name と一致する', () => {
    const html = parseIndexHtmlCatalog('PLANS');
    expect(Object.keys(html).length).toBeGreaterThan(20); // パーサ健全性
    for (const [id, label] of Object.entries(PLAN_LABELS)) {
      expect(html[id]).toBe(label);
    }
  });
});
