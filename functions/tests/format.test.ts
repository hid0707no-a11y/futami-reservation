// 純粋関数フォーマッタのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2）

import {
  formatCustomerAddress,
  formatPartyText,
  formatSaunaOptions,
  generateDisplayId,
  partyPlanKind,
} from '../src/lib/format';

describe('formatCustomerAddress', () => {
  it('全フィールド揃っている場合は 〒+住所1+住所2 を整形する', () => {
    expect(formatCustomerAddress({
      zip: '791-3120',
      address1: '愛媛県伊予市双海町',
      address2: '高野川123',
    })).toBe('〒791-3120 愛媛県伊予市双海町 高野川123');
  });

  it('zipなしでも住所1+2を整形する', () => {
    expect(formatCustomerAddress({
      address1: '東京都品川区',
      address2: '東品川1-2-3',
    })).toBe('東京都品川区 東品川1-2-3');
  });

  it('address2がない場合はaddress1のみ', () => {
    expect(formatCustomerAddress({
      zip: '100-0001',
      address1: '東京都千代田区',
    })).toBe('〒100-0001 東京都千代田区');
  });

  it('address1/address2の両方が空文字なら空文字を返す（zipのみは住所扱いしない）', () => {
    expect(formatCustomerAddress({ zip: '791-3120', address1: '', address2: '' })).toBe('');
    expect(formatCustomerAddress({ zip: '791-3120' })).toBe('');
  });

  it('null/undefined を渡しても安全に空文字を返す', () => {
    expect(formatCustomerAddress(null)).toBe('');
    expect(formatCustomerAddress(undefined)).toBe('');
  });

  it('前後の空白はトリムする', () => {
    expect(formatCustomerAddress({
      zip: '  791-3120  ',
      address1: '  愛媛県  ',
      address2: '  双海町  ',
    })).toBe('〒791-3120 愛媛県 双海町');
  });
});

describe('formatSaunaOptions', () => {
  it('null/undefined/空オブジェクト → 空文字', () => {
    expect(formatSaunaOptions(null)).toBe('');
    expect(formatSaunaOptions(undefined)).toBe('');
    expect(formatSaunaOptions({})).toBe('');
  });

  it('タオル数のみ → タオル×N', () => {
    expect(formatSaunaOptions({ towels: 2 })).toBe('タオル×2');
  });

  it('複数オプションは／区切り、氷は20kg単位で表示', () => {
    expect(formatSaunaOptions({ towels: 2, tarpTent: 1, ice20kg: 1 }))
      .toBe('タオル×2／タープテント／氷20kg');
  });

  it('氷2袋 → 氷40kg', () => {
    expect(formatSaunaOptions({ ice20kg: 2 })).toBe('氷40kg');
  });

  it('値が 0 のオプションは無視する', () => {
    expect(formatSaunaOptions({ towels: 0, tarpTent: 0, ice20kg: 1 })).toBe('氷20kg');
  });
});

describe('generateDisplayId', () => {
  it('Auto ID 先頭6文字を大文字化して F- prefix で返す', () => {
    expect(generateDisplayId('abcdef123456ghijklmn')).toBe('F-ABCDEF');
  });

  it('全部数字でも問題なく動く', () => {
    expect(generateDisplayId('012345abcdef')).toBe('F-012345');
  });

  it('大小英字混在は大文字化で正規化', () => {
    expect(generateDisplayId('aBcDeFghij')).toBe('F-ABCDEF');
  });

  it('空文字を渡したら空文字を返す（フォールバック側で処理）', () => {
    expect(generateDisplayId('')).toBe('');
  });

  it('6文字未満の Auto ID（理論上ありえない短い ID）でも空文字でなく短縮 ID を返す', () => {
    // Firestore Auto ID は 20文字固定だが、テスト時の手作り ID 用に堅牢性確保
    expect(generateDisplayId('abc')).toBe('F-ABC');
  });
});

// ============================================================================
// formatPartyText（2026-08-03・運営要望④「通知メールに予約人数が無い」）
// ============================================================================
//
// 施設11グループ × 予約経路（公開画面 web / 職員画面 staff）で、
// 「どこから人数を拾うか」が正しいことと、拾えない時に行を出さないことを固定する。
//
// 公開画面は人数の入力欄が無いプランでも guests={adult:1,elementary:0,child:0} を
// 必ず送ってくる（index.html selectPlan の初期値）。この 1 を人数として印字しない
// ことがこのテスト群の主目的。

describe('partyPlanKind', () => {
  it.each([
    ['stay_6', 'stay'], ['stay_27', 'stay'], ['stay_exp', 'stay'], ['stay_all', 'stay'],
    ['camp_stay', 'camp'],
    ['sauna_1', 'sauna'], ['sauna_4', 'sauna'], ['plan_sauna_futami', 'sauna'],
    ['tennis_full', 'sport'], ['tennis_half', 'sport'], ['midori_am', 'sport'], ['midori_eve', 'sport'],
    ['day_6_all', 'other'], ['day_27_all', 'other'], ['day_exp_am', 'other'],
    ['day_train_pm', 'other'], ['day_kitchen', 'other'],
    ['lodge_stay', 'other'], ['lodge_day', 'other'],
    ['', 'other'], ['sauna_5', 'other'], ['staycation', 'other'],
  ])('%s → %s', (planId, expected) => {
    expect(partyPlanKind(planId)).toBe(expected);
  });

  it('文字列以外は other 扱いで落ちない', () => {
    expect(partyPlanKind(undefined)).toBe('other');
    expect(partyPlanKind(null)).toBe('other');
    expect(partyPlanKind(123)).toBe('other');
  });
});

describe('formatPartyText — 公開画面（createdBy=web）', () => {
  const web = (over: Record<string, any>) =>
    formatPartyText({ createdBy: 'web', guests: { adult: 1, elementary: 0, child: 0 }, ...over });

  // ① 宿泊）ふれあいの館 … 画面の3区分ステッパーが唯一の実入力
  it('宿泊：3区分すべて入力されていれば内訳と合計を出す', () => {
    expect(web({ planId: 'stay_27', roomIds: ['room_27'], guests: { adult: 2, elementary: 1, child: 1 } }))
      .toBe('人数：中学生以上2名／小学生1名／小学生未満1名（計4名）');
  });

  it('宿泊：1区分だけなら「（計N名）」は付けない（同じ数字の繰り返しを避ける）', () => {
    expect(web({ planId: 'stay_6', roomIds: ['room_6_1'], guests: { adult: 3, elementary: 0, child: 0 } }))
      .toBe('人数：中学生以上3名');
    expect(web({ planId: 'stay_all', guests: { adult: 0, elementary: 4, child: 0 } }))
      .toBe('人数：小学生4名');
    expect(web({ planId: 'stay_exp', guests: { adult: 0, elementary: 0, child: 2 } }))
      .toBe('人数：小学生未満2名');
  });

  it('宿泊：0名の区分は書かない（「小学生0名」を出さない）', () => {
    const text = web({ planId: 'stay_27', guests: { adult: 5, elementary: 0, child: 2 } });
    expect(text).toBe('人数：中学生以上5名／小学生未満2名（計7名）');
    expect(text).not.toContain('0名');
  });

  it('宿泊：全区分0（未入力）なら行ごと出さない', () => {
    expect(web({ planId: 'stay_27', guests: { adult: 0, elementary: 0, child: 0 } })).toBe('');
  });

  // ②〜⑥ 日帰り各室・研修室・厨房 … 画面に人数の入力欄が無い
  it.each(['day_6_all', 'day_27_all', 'day_27_am', 'day_exp_pm', 'day_train_eve', 'day_kitchen'])(
    '日帰り %s：入力欄が無いので初期値 adult=1 を人数として印字しない',
    planId => {
      expect(web({ planId })).toBe('');
    });

  // ⑦ キャンプ場 … guestCount は区画数であって人数ではない
  it('キャンプ：区画数だけを出す（人数は入力されていない）', () => {
    expect(web({
      planId: 'camp_stay', roomIds: ['camp_1', 'camp_2', 'camp_3'], isCamp: true, guestCount: 3,
    })).toBe('区画数：3区画');
  });

  it('キャンプ：guestCount(=区画数)を人数として二重に出さない', () => {
    const text = web({ planId: 'camp_stay', roomIds: ['camp_5'], isCamp: true, guestCount: 1 });
    expect(text).toBe('区画数：1区画');
    expect(text).not.toContain('人数');
  });

  it('キャンプ：roomIds が区画になっていない旧予約は guestCount を区画数に使う', () => {
    expect(web({ planId: 'camp_stay', roomIds: ['camp'], isCamp: true, guestCount: 2 }))
      .toBe('区画数：2区画');
  });

  it('キャンプ：区画数が復元できなければ行ごと出さない', () => {
    expect(web({ planId: 'camp_stay', roomIds: [], isCamp: true })).toBe('');
  });

  // ⑧ ロッジ … 入力欄なし
  it.each(['lodge_stay', 'lodge_day'])('ロッジ %s：人数の入力欄が無いので出さない', planId => {
    expect(web({ planId, roomIds: ['lodge_a'] })).toBe('');
  });

  // ⑨⑩ テニスコート・みどりの広場 … 「ご利用予定人数(目安)」
  it('テニス：目安人数を目安と分かる表記で出す', () => {
    expect(web({ planId: 'tennis_full', roomIds: ['court_1'], sportGuestEstimate: 10 }))
      .toBe('ご利用予定人数（目安）：10名');
  });

  it('みどりの広場：目安人数を出す（上限150名）', () => {
    expect(web({ planId: 'midori_day', roomIds: ['midori'], sportGuestEstimate: 150 }))
      .toBe('ご利用予定人数（目安）：150名');
  });

  it('テニス／みどり：目安人数0（未回答）なら行ごと出さない', () => {
    expect(web({ planId: 'tennis_half', roomIds: ['court_wall'], sportGuestEstimate: 0 })).toBe('');
    expect(web({ planId: 'midori_am', roomIds: ['midori'], sportGuestEstimate: null })).toBe('');
    expect(web({ planId: 'midori_eve', roomIds: ['midori'] })).toBe('');
  });

  // ⑪ サウナ … guestCount が人数
  it.each(['sauna_1', 'sauna_2', 'sauna_3', 'sauna_4'])(
    '通常サウナ %s：guestCount が届いていれば人数として出す', planId => {
      expect(web({ planId, roomIds: ['sauna'], guestCount: 5 })).toBe('人数：5名');
    });

  it('通常サウナ：guestCount が無ければ出さない（初期値 adult=1 を人数にしない）', () => {
    expect(web({ planId: 'sauna_2', roomIds: ['sauna'] })).toBe('');
  });

  it('ふたみの日サウナ：座席数を人数として出す', () => {
    expect(web({ planId: 'plan_sauna_futami', roomIds: ['sauna_share'], guestCount: 2 }))
      .toBe('人数：2名');
    expect(web({ planId: 'plan_sauna_futami', roomIds: ['sauna_share'], guestCount: 8 }))
      .toBe('人数：8名');
  });

  it('サウナ：定員8名を超える壊れた値は採用しない', () => {
    expect(web({ planId: 'sauna_1', roomIds: ['sauna'], guestCount: 9 })).toBe('');
    expect(web({ planId: 'plan_sauna_futami', guestCount: 150 })).toBe('');
  });
});

describe('formatPartyText — 職員画面（createdBy=staff）', () => {
  const staff = (over: Record<string, any>) =>
    formatPartyText({ createdBy: 'staff', ...over });

  it('日帰り：職員が入力した人数は guests.adult に入るので出す', () => {
    expect(staff({ planId: 'day_27_all', guests: { adult: 20, elementary: 0, child: 0 } }))
      .toBe('人数：20名');
  });

  it('宿泊：職員画面は区分別ではないので内訳表記にしない', () => {
    expect(staff({ planId: 'stay_27', guests: { adult: 5, elementary: 0, child: 0 } }))
      .toBe('人数：5名');
  });

  it('キャンプ：区画数と人数を併記する', () => {
    expect(staff({
      planId: 'camp_stay', roomIds: ['camp_1', 'camp_2'], isCamp: true, guestCount: 2,
      guests: { adult: 5, elementary: 0, child: 0 },
    })).toBe('区画数：2区画\n人数：5名');
  });

  it('通常サウナ：職員経路は guestCount を送らないが guests.adult から出せる', () => {
    expect(staff({ planId: 'sauna_3', roomIds: ['sauna'], guests: { adult: 6, elementary: 0, child: 0 } }))
      .toBe('人数：6名');
  });

  it('ふたみの日サウナ：guestCount を優先する（同値でも二重に出さない）', () => {
    expect(staff({
      planId: 'plan_sauna_futami', roomIds: ['sauna_share'], guestCount: 4,
      guests: { adult: 4, elementary: 0, child: 0 },
    })).toBe('人数：4名');
  });

  it('テニス：職員経路は pricing=null なので guests.adult を使う', () => {
    expect(staff({ planId: 'tennis_full', roomIds: ['court_1'], guests: { adult: 4, elementary: 0, child: 0 } }))
      .toBe('人数：4名');
  });

  it('ロッジ：職員入力があれば出す（web と違いデータが存在する）', () => {
    expect(staff({ planId: 'lodge_stay', guests: { adult: 3, elementary: 0, child: 0 } }))
      .toBe('人数：3名');
  });

  it('職員が0名のまま送った場合は行ごと出さない', () => {
    expect(staff({ planId: 'day_kitchen', guests: { adult: 0, elementary: 0, child: 0 } })).toBe('');
  });
});

describe('formatPartyText — 不明・壊れた入力（0名/undefined名を出さない）', () => {
  it('入力そのものが無ければ空文字', () => {
    expect(formatPartyText(null)).toBe('');
    expect(formatPartyText(undefined)).toBe('');
    expect(formatPartyText({})).toBe('');
  });

  it('guests が null/欠測でも落ちない', () => {
    expect(formatPartyText({ planId: 'stay_27', createdBy: 'web', guests: null })).toBe('');
    expect(formatPartyText({ planId: 'stay_27', createdBy: 'staff' })).toBe('');
  });

  it.each([
    ['文字列', '5'],
    ['小数', 1.5],
    ['負数', -3],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['上限超過', 151],
    ['オブジェクト', { adult: 1 }],
    ['配列', [3]],
  ])('guests.adult が%s（保存型XSS/壊れたデータ）でも人数として採用しない', (_label, adult) => {
    expect(formatPartyText({ planId: 'stay_27', createdBy: 'staff', guests: { adult } as any })).toBe('');
  });

  it.each([
    ['文字列', '3'],
    ['小数', 2.5],
    ['0', 0],
    ['負数', -1],
    ['NaN', NaN],
  ])('サウナの guestCount が%sなら人数を出さない', (_label, guestCount) => {
    expect(formatPartyText({ planId: 'sauna_1', createdBy: 'web', guestCount } as any)).toBe('');
  });

  it.each([
    ['文字列', '10'],
    ['小数', 1.5],
    ['負数', -5],
    ['上限超過', 151],
  ])('目安人数が%sなら出さない', (_label, sportGuestEstimate) => {
    expect(formatPartyText({ planId: 'tennis_full', createdBy: 'web', sportGuestEstimate } as any)).toBe('');
  });

  it('どの経路でも "0名" / "undefined" / "NaN" を出力しない', () => {
    const planIds = [
      'stay_6', 'stay_27', 'stay_exp', 'stay_all', 'day_6_all', 'day_27_all', 'day_exp_am',
      'day_train_pm', 'day_kitchen', 'camp_stay', 'lodge_stay', 'lodge_day',
      'tennis_full', 'tennis_half', 'midori_am', 'midori_eve',
      'sauna_1', 'sauna_2', 'sauna_3', 'sauna_4', 'plan_sauna_futami', '', 'unknown_plan',
    ];
    const broken = [undefined, null, 0, -1, 1.5, NaN, '2', 999];
    for (const planId of planIds) {
      for (const createdBy of ['web', 'staff', undefined]) {
        for (const v of broken) {
          const text = formatPartyText({
            planId, createdBy, isCamp: planId === 'camp_stay',
            roomIds: undefined,
            guests: { adult: v, elementary: v, child: v } as any,
            guestCount: v as any,
            sportGuestEstimate: v as any,
          });
          expect(text).not.toMatch(/undefined|NaN|0名|0区画|：$/);
        }
      }
    }
  });
});
