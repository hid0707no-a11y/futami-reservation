type MockTransport = {
  verify: jest.Mock;
  sendMail: jest.Mock;
};

const ORIGINAL_ENV = process.env;
const ORIGINAL_FETCH = global.fetch;

function loadMail(options: {
  smtp?: boolean;
  discord?: boolean;
  transport?: MockTransport;
  staffEmail?: string;
  saunaEmails?: string;
}) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  if (options.smtp) {
    process.env.SMTP_USER = 'monitor@example.com';
    process.env.SMTP_PASS = 'app-password';
  } else {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  }
  if (options.discord) process.env.DISCORD_WEBHOOK_URL = 'https://discord.example.invalid/webhook';
  else delete process.env.DISCORD_WEBHOOK_URL;
  if (options.staffEmail === undefined) delete process.env.STAFF_EMAIL;
  else process.env.STAFF_EMAIL = options.staffEmail;
  if (options.saunaEmails === undefined) delete process.env.SAUNA_NOTIFY_EMAILS;
  else process.env.SAUNA_NOTIFY_EMAILS = options.saunaEmails;

  const transport = options.transport || {
    verify: jest.fn(async () => true),
    sendMail: jest.fn(async () => ({ accepted: ['staff@example.com'] })),
  };
  const createTransport = jest.fn(() => transport);
  jest.doMock('nodemailer', () => ({ createTransport }));

  let mail: typeof import('../src/lib/mail');
  jest.isolateModules(() => {
    mail = require('../src/lib/mail');
  });
  return { mail: mail!, transport, createTransport };
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
  global.fetch = ORIGINAL_FETCH;
  jest.dontMock('nodemailer');
  jest.restoreAllMocks();
});

describe('mail monitor delivery', () => {
  it('SMTP transport自体へDNS/接続/挨拶/socket timeoutを設定する', () => {
    const { mail, createTransport } = loadMail({ smtp: true });
    expect(mail.isSmtpConfigured()).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      dnsTimeout: 5000,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    }));
  });

  it('verifySmtpConnectionは成功と失敗を握り潰さない', async () => {
    const transport: MockTransport = {
      verify: jest.fn(async () => true),
      sendMail: jest.fn(async () => ({})),
    };
    const { mail } = loadMail({ smtp: true, transport });
    await expect(mail.verifySmtpConnection()).resolves.toBeUndefined();
    transport.verify.mockRejectedValueOnce(new Error('auth failed'));
    await expect(mail.verifySmtpConnection()).rejects.toThrow('auth failed');
  });

  it('verifyDiscordConnectionは投稿せずGETで到達性を確認する', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any;
    const { mail } = loadMail({ discord: true });
    await expect(mail.verifyDiscordConnection()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://discord.example.invalid/webhook',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('verifyDiscordConnectionは失効webhookを失敗として返す', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as any;
    const { mail } = loadMail({ discord: true });
    await expect(mail.verifyDiscordConnection()).rejects.toThrow('discord_verify_http_404');
  });

  it('通知経路が0件ならCRITICALログを残してthrow', async () => {
    const { mail } = loadMail({});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(mail.isSmtpConfigured()).toBe(false);
    expect(mail.isDiscordConfigured()).toBe(false);
    await expect(mail.sendMonitorAlert('subject', 'body'))
      .rejects.toThrow('monitor_alert_no_configured_channel');
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('CRITICAL'))).toBe(true);
  });

  it('SMTPかDiscordの一方でも成功すれば通知成功', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 204 })) as any;
    const transport: MockTransport = {
      verify: jest.fn(async () => true),
      sendMail: jest.fn(async () => { throw new Error('smtp down'); }),
    };
    const { mail } = loadMail({ smtp: true, discord: true, transport });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(mail.sendMonitorAlert('subject', 'body')).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it('SMTP verify失敗済みならuseSmtp=falseで同じ経路を再試行しない', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 204 })) as any;
    const transport: MockTransport = {
      verify: jest.fn(async () => true),
      sendMail: jest.fn(async () => ({})),
    };
    const { mail } = loadMail({ smtp: true, discord: true, transport });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await mail.sendMonitorAlert('subject', 'body', { useSmtp: false });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('構成済み全経路が失敗したらthrowしてscheduler retryへ伝播', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 })) as any;
    const transport: MockTransport = {
      verify: jest.fn(async () => true),
      sendMail: jest.fn(async () => { throw new Error('smtp down'); }),
    };
    const { mail } = loadMail({ smtp: true, discord: true, transport });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mail.sendMonitorAlert('subject', 'body'))
      .rejects.toThrow('monitor_alert_all_channels_failed');
  });
});

// 2026-08-01 運営要望①：サウナ予約だけ担当者3名にも通知する。
describe('sendStaffNotification の宛先', () => {
  const SAUNA_EMAILS = 'nishida@example.com,yamamoto@example.com,aja@example.com';

  function baseMail(over: Record<string, any> = {}) {
    return {
      planName: 'A 10:00-12:00', roomName: 'サンセットサウナ',
      startDate: '2026-08-10', endDate: '2026-08-10',
      customerName: '山田', customerPhone: '090-0000-0000', customerEmail: 'y@example.com',
      note: '', reservationId: 'F-ABC123',
      ...over,
    } as any;
  }

  it('通常サウナは STAFF_EMAIL + 担当者3名へ送る', async () => {
    const { mail, transport } = loadMail({
      smtp: true, staffEmail: 'staff@example.com', saunaEmails: SAUNA_EMAILS,
    });
    await mail.sendStaffNotification(baseMail({ planId: 'sauna_1', roomIds: ['sauna'] }), 'new');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.sendMail.mock.calls[0][0].to)
      .toBe('staff@example.com, nishida@example.com, yamamoto@example.com, aja@example.com');
  });

  it('ふたみの日サウナも担当者3名へ送る', async () => {
    const { mail, transport } = loadMail({
      smtp: true, staffEmail: 'staff@example.com', saunaEmails: SAUNA_EMAILS,
    });
    await mail.sendStaffNotification(
      baseMail({ planId: 'plan_sauna_futami', roomIds: ['sauna_share'] }), 'new');
    expect(transport.sendMail.mock.calls[0][0].to).toContain('aja@example.com');
  });

  it('キャンセル通知も同じ宛先へ送る', async () => {
    const { mail, transport } = loadMail({
      smtp: true, staffEmail: 'staff@example.com', saunaEmails: SAUNA_EMAILS,
    });
    await mail.sendStaffNotification(baseMail({ planId: 'sauna_4', roomIds: ['sauna'] }), 'cancel');
    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.subject).toContain('【キャンセル】');
    expect(sent.to).toContain('nishida@example.com');
  });

  it('サウナ以外（キャンプ・テニス）は STAFF_EMAIL のみ＝担当者に流さない', async () => {
    const { mail, transport } = loadMail({
      smtp: true, staffEmail: 'staff@example.com', saunaEmails: SAUNA_EMAILS,
    });
    await mail.sendStaffNotification(
      baseMail({ planId: 'camp_stay', roomIds: ['camp_1'], roomName: '区画①' }), 'new');
    await mail.sendStaffNotification(
      baseMail({ planId: 'tennis_full', roomIds: ['court_1'], roomName: 'コートA' }), 'new');
    expect(transport.sendMail.mock.calls[0][0].to).toBe('staff@example.com');
    expect(transport.sendMail.mock.calls[1][0].to).toBe('staff@example.com');
  });

  it('planId/roomIds を持たない旧形式の MailData でも送信自体は壊れない', async () => {
    const { mail, transport } = loadMail({
      smtp: true, staffEmail: 'staff@example.com', saunaEmails: SAUNA_EMAILS,
    });
    await mail.sendStaffNotification(baseMail(), 'new');
    expect(transport.sendMail.mock.calls[0][0].to).toBe('staff@example.com');
  });
});

// 2026-08-03 運営要望④：通知メールに予約人数を載せる。
// 本文テンプレートは partyText（format.formatPartyText の出力）を1箇所差し込むだけ。
// 「どの施設で何を拾うか」は format.test.ts 側で固定している。
describe('メール本文の人数表記', () => {
  function baseMail(over: Record<string, any> = {}) {
    return {
      planName: '宿泊（27畳）', roomName: '27畳',
      startDate: '2026-09-10', endDate: '2026-09-11',
      customerName: '山田', customerPhone: '090-0000-0000', customerEmail: 'y@example.com',
      customerAddress: '〒791-3120 愛媛県伊予市双海町',
      note: '', reservationId: 'F-ABC123',
      ...over,
    } as any;
  }

  it('スタッフ通知：人数が日程の次の行に入る', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendStaffNotification(
      baseMail({ partyText: '人数：中学生以上2名／小学生1名（計3名）' }), 'new');
    const text: string = transport.sendMail.mock.calls[0][0].text;
    expect(text).toContain('\n人数：中学生以上2名／小学生1名（計3名）\n');
    expect(text).toContain('日程：2026-09-10 ～ 2026-09-11\n人数：');
  });

  it('顧客確認メール：スタッフ通知と同じ人数表記が入る', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    const data = baseMail({ partyText: '人数：中学生以上2名／小学生1名（計3名）' });
    await mail.sendConfirmationEmail(data);
    await mail.sendStaffNotification(data, 'new');
    const customerText: string = transport.sendMail.mock.calls[0][0].text;
    const staffText: string = transport.sendMail.mock.calls[1][0].text;
    expect(customerText).toContain('人数：中学生以上2名／小学生1名（計3名）');
    expect(staffText).toContain('人数：中学生以上2名／小学生1名（計3名）');
  });

  it('キャンプ：区画数と人数の2行が本文に入る', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendStaffNotification(baseMail({
      planName: 'キャンプ泊', roomName: '区画①・区画②',
      partyText: '区画数：2区画\n人数：5名',
    }), 'new');
    const text: string = transport.sendMail.mock.calls[0][0].text;
    expect(text).toContain('\n区画数：2区画\n人数：5名\n');
  });

  it('キャンセル通知（スタッフ）でも人数が出る', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendStaffNotification(
      baseMail({ planName: 'A 10:00-12:00', roomName: 'サンセットサウナ', partyText: '人数：4名' }),
      'cancel');
    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.subject).toContain('【キャンセル】');
    expect(sent.text).toContain('人数：4名');
  });

  it('キャンセル確認メール（顧客）でも人数が出る', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendCancellationEmail(baseMail({ partyText: '人数：4名' }));
    expect(transport.sendMail.mock.calls[0][0].text).toContain('人数：4名');
  });

  it('人数が不明（partyText なし）なら行ごと出さない', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    const data = baseMail();
    await mail.sendStaffNotification(data, 'new');
    await mail.sendConfirmationEmail(data);
    await mail.sendCancellationEmail(data);
    for (const call of transport.sendMail.mock.calls) {
      const text: string = call[0].text;
      expect(text).not.toContain('人数');
      expect(text).not.toContain('区画数');
      expect(text).not.toContain('undefined');
      expect(text).toContain('日程：2026-09-10 ～ 2026-09-11\n');
    }
  });

  it('partyText が空文字なら行を出さない（0名/空ラベルを印字しない）', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendStaffNotification(baseMail({ partyText: '' }), 'new');
    expect(transport.sendMail.mock.calls[0][0].text).not.toContain('人数');
  });

  it('guestCount / isCamp だけを渡しても本文には出ない（表示の正本は partyText）', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendStaffNotification(
      baseMail({ guestCount: 3, isCamp: true, planId: 'camp_stay', roomIds: ['camp_1'] }), 'new');
    const text: string = transport.sendMail.mock.calls[0][0].text;
    expect(text).not.toContain('区画数');
    expect(text).not.toContain('人数');
  });

  it('時間・オプション・備考との並び順が崩れない（人数は時間の次・オプションの前）', async () => {
    const { mail, transport } = loadMail({ smtp: true, staffEmail: 'staff@example.com' });
    await mail.sendStaffNotification(baseMail({
      startDate: '2026-09-10', endDate: '2026-09-10',
      timeText: '10:00〜12:00', partyText: '人数：4名',
      saunaOptionsText: 'タオル×2', note: '初めて利用します',
    }), 'new');
    const text: string = transport.sendMail.mock.calls[0][0].text;
    expect(text).toContain('日程：2026-09-10\n時間：10:00〜12:00\n人数：4名\nオプション：タオル×2\n備考：初めて利用します');
  });
});
