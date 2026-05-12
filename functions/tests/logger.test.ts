// 構造化ロガーのユニットテスト
// 2026-05-05 新設（/gfu Phase A-2 拡張）

import { audit, logMailFailure, logIdempotencyFailure, logError, logWarn, logInfo } from '../src/lib/logger';

const reqMock = (origin: string = 'https://hid0707no-a11y.github.io') => ({
  headers: {
    'x-forwarded-for': '203.0.113.1, 198.51.100.1',
    'user-agent': 'jest-test',
    origin,
  },
  ip: '127.0.0.1',
});

function captureConsole(method: 'log' | 'warn' | 'error') {
  const original = console[method];
  const captured: string[] = [];
  console[method] = (...args: any[]) => { captured.push(args.join(' ')); };
  return {
    captured,
    restore: () => { console[method] = original; },
  };
}

describe('audit', () => {
  it('構造化 JSON を console.log に出力する', () => {
    const cap = captureConsole('log');
    audit('reservation.create', { reservationId: 'abc123', planId: 'normal_27' }, reqMock());
    cap.restore();
    expect(cap.captured).toHaveLength(1);
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.severity).toBe('INFO');
    expect(entry.audit).toBe(true);
    expect(entry.action).toBe('reservation.create');
    expect(entry.reservationId).toBe('abc123');
    expect(entry.message).toBe('AUDIT: reservation.create');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('x-forwarded-for の最初の IP を抜く', () => {
    const cap = captureConsole('log');
    audit('test', {}, reqMock());
    cap.restore();
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.ip).toBe('203.0.113.1');
  });

  it('req なしでも crash せず unknown を出す', () => {
    const cap = captureConsole('log');
    audit('test', {});
    cap.restore();
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.action).toBe('test');
  });
});

describe('logMailFailure', () => {
  it('confirmation 失敗を ERROR severity で出力する', () => {
    const cap = captureConsole('error');
    const handler = logMailFailure('confirmation', { reservationId: 'r1' }, reqMock());
    handler(new Error('SMTP timeout'));
    cap.restore();
    expect(cap.captured).toHaveLength(1);
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.severity).toBe('ERROR');
    expect(entry.action).toBe('mail.confirmation.failed');
    expect(entry.error).toBe('SMTP timeout');
    expect(entry.reservationId).toBe('r1');
  });

  it('staff / cancellation も同様に kind ごとに action が変わる', () => {
    const cap = captureConsole('error');
    logMailFailure('staff', { reservationId: 's1', kind: 'new' }, reqMock())(new Error('x'));
    logMailFailure('cancellation', { reservationId: 'c1' }, reqMock())(new Error('y'));
    cap.restore();
    const e1 = JSON.parse(cap.captured[0]);
    const e2 = JSON.parse(cap.captured[1]);
    expect(e1.action).toBe('mail.staff.failed');
    expect(e2.action).toBe('mail.cancellation.failed');
  });

  it('Error object 以外（文字列・undefined）でも crash しない', () => {
    const cap = captureConsole('error');
    logMailFailure('confirmation', {}, reqMock())('string error');
    logMailFailure('confirmation', {}, reqMock())(undefined);
    cap.restore();
    expect(JSON.parse(cap.captured[0]).error).toBe('string error');
    expect(JSON.parse(cap.captured[1]).error).toBe('undefined');
  });
});

describe('logIdempotencyFailure', () => {
  it('WARNING severity で reservationId 付きで出力する', () => {
    const cap = captureConsole('warn');
    logIdempotencyFailure('abc123', reqMock())(new Error('write conflict'));
    cap.restore();
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.severity).toBe('WARNING');
    expect(entry.action).toBe('idempotency.save_failed');
    expect(entry.reservationId).toBe('abc123');
    expect(entry.error).toBe('write conflict');
  });
});

describe('logError / logWarn / logInfo', () => {
  it('logError は ERROR severity で error/stack を含む', () => {
    const cap = captureConsole('error');
    const e = new Error('boom');
    logError('something.failed', e, { extra: 1 }, reqMock());
    cap.restore();
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.severity).toBe('ERROR');
    expect(entry.action).toBe('something.failed');
    expect(entry.error).toBe('boom');
    expect(entry.stack).toContain('Error: boom');
    expect(entry.extra).toBe(1);
  });

  it('logWarn は WARNING severity', () => {
    const cap = captureConsole('warn');
    logWarn('soft.problem', { hint: 'transient' });
    cap.restore();
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.severity).toBe('WARNING');
    expect(entry.hint).toBe('transient');
  });

  it('logInfo は INFO severity', () => {
    const cap = captureConsole('log');
    logInfo('deploy.complete', { version: '1.2.3' });
    cap.restore();
    const entry = JSON.parse(cap.captured[0]);
    expect(entry.severity).toBe('INFO');
    expect(entry.version).toBe('1.2.3');
  });
});
