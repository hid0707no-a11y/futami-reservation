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
