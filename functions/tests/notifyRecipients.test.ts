// スタッフ通知メールの宛先解決（2026-08-01 運営要望①）
//
// env を読むモジュールなので、pricing 系と違い jest.isolateModules で読み直す。

const ORIGINAL_ENV = process.env;

function loadModule(env: { staffEmail?: string; saunaEmails?: string } = {}) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  if (env.staffEmail === undefined) delete process.env.STAFF_EMAIL;
  else process.env.STAFF_EMAIL = env.staffEmail;
  if (env.saunaEmails === undefined) delete process.env.SAUNA_NOTIFY_EMAILS;
  else process.env.SAUNA_NOTIFY_EMAILS = env.saunaEmails;

  let mod!: typeof import('../src/lib/notifyRecipients');
  jest.isolateModules(() => {
    mod = require('../src/lib/notifyRecipients');
  });
  return mod;
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

describe('isSaunaReservation', () => {
  const mod = () => loadModule();

  it.each(['sauna_1', 'sauna_2', 'sauna_3', 'sauna_4'])('通常サウナ %s を planId で判定する', planId => {
    expect(mod().isSaunaReservation({ planId, roomIds: ['sauna'] })).toBe(true);
  });

  it('ふたみの日サウナ（plan_sauna_futami / sauna_share）を判定する', () => {
    expect(mod().isSaunaReservation({ planId: 'plan_sauna_futami', roomIds: ['sauna_share'] })).toBe(true);
  });

  it('planId が未知でも roomIds が sauna ならサウナ扱いにする（職員入力経路の保険）', () => {
    expect(mod().isSaunaReservation({ planId: 'unknown_plan', roomIds: ['sauna'] })).toBe(true);
    expect(mod().isSaunaReservation({ roomIds: ['sauna_share'] })).toBe(true);
  });

  it.each([
    ['テニス全面', { planId: 'tennis_full', roomIds: ['court_1'] }],
    ['テニス半面', { planId: 'tennis_half', roomIds: ['court_wall'] }],
    ['キャンプ', { planId: 'camp_stay', roomIds: ['camp_1', 'camp_2'] }],
    ['宿泊27畳', { planId: 'stay_27', roomIds: ['room_27'] }],
    ['みどりの広場', { planId: 'midori_am', roomIds: ['midori'] }],
    ['空ペイロード', {}],
  ])('%s はサウナではない', (_name, input) => {
    expect(mod().isSaunaReservation(input as any)).toBe(false);
  });

  it('sauna_5 のような境界値はサウナ扱いしない（枠は4つ）', () => {
    expect(mod().isSaunaReservation({ planId: 'sauna_5' })).toBe(false);
    expect(mod().isSaunaReservation({ planId: 'sauna_0' })).toBe(false);
  });

  it('roomIds が配列でない壊れた値でも例外を出さない', () => {
    expect(mod().isSaunaReservation({ roomIds: 'sauna' as any })).toBe(false);
    expect(mod().isSaunaReservation({ planId: 123 as any })).toBe(false);
  });
});

describe('resolveStaffRecipients', () => {
  it('サウナ以外は STAFF_EMAIL のみ（従来動作を変えない）', () => {
    const mod = loadModule({ staffEmail: 'staff@example.com', saunaEmails: 'a@example.com,b@example.com' });
    expect(mod.resolveStaffRecipients({ planId: 'camp_stay', roomIds: ['camp_1'] }))
      .toEqual(['staff@example.com']);
  });

  it('サウナは STAFF_EMAIL + 担当者を返す', () => {
    const mod = loadModule({ staffEmail: 'staff@example.com', saunaEmails: 'a@example.com,b@example.com,c@example.com' });
    expect(mod.resolveStaffRecipients({ planId: 'sauna_2', roomIds: ['sauna'] }))
      .toEqual(['staff@example.com', 'a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('カンマ周りの空白と空要素を落とす', () => {
    const mod = loadModule({ staffEmail: 'staff@example.com', saunaEmails: ' a@example.com , , b@example.com ,' });
    expect(mod.resolveStaffRecipients({ planId: 'sauna_1' }))
      .toEqual(['staff@example.com', 'a@example.com', 'b@example.com']);
  });

  it('STAFF_EMAIL と同じアドレスが混ざっても大文字小文字を無視して二重送信しない', () => {
    const mod = loadModule({ staffEmail: 'Staff@Example.com', saunaEmails: 'staff@example.com,a@example.com' });
    expect(mod.resolveStaffRecipients({ planId: 'sauna_1' }))
      .toEqual(['Staff@Example.com', 'a@example.com']);
  });

  it('SAUNA_NOTIFY_EMAILS 未設定なら STAFF_EMAIL のみに縮退し、ERROR ログで気づけるようにする', () => {
    const mod = loadModule({ staffEmail: 'staff@example.com' });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(mod.resolveStaffRecipients({ planId: 'sauna_1', roomIds: ['sauna'] }))
      .toEqual(['staff@example.com']);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.severity).toBe('ERROR');
    expect(logged.action).toBe('mail.sauna_recipients_not_configured');
  });

  it('サウナ以外では未設定でも ERROR ログを出さない（無関係な予約でノイズを出さない）', () => {
    const mod = loadModule({ staffEmail: 'staff@example.com' });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mod.resolveStaffRecipients({ planId: 'stay_27', roomIds: ['room_27'] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('STAFF_EMAIL 未設定時は既定の info@fureai-iyosasaeru.com を使う', () => {
    const mod = loadModule({ saunaEmails: 'a@example.com' });
    expect(mod.resolveStaffRecipients({ planId: 'sauna_3' }))
      .toEqual(['info@fureai-iyosasaeru.com', 'a@example.com']);
  });
});
