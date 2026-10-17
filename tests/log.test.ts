import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { logError, logFailure, logWarning, runCommand } from '../src/lib/server/log';
import { HttpError } from '../src/lib/server/errors';
import { errorResponse } from '../src/lib/server/http';

const savedEnv = { SMTP_USERNAME: process.env.SMTP_USERNAME, SMTP_PASSWORD: process.env.SMTP_PASSWORD, CONFIRMATION_SECRET: process.env.CONFIRMATION_SECRET };
let errorSpy: ReturnType<typeof spyOn<typeof console, 'error'>> | undefined;
let warnSpy: ReturnType<typeof spyOn<typeof console, 'warn'>> | undefined;
afterEach(() => {
  errorSpy?.mockRestore(); warnSpy?.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('server error logging', () => {
  test('SMTP diagnostics retain response codes and causes but omit private data', () => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    process.env.SMTP_USERNAME = 'private-smtp-user';
    process.env.SMTP_PASSWORD = 'private-smtp-password';
    process.env.CONFIRMATION_SECRET = 'f'.repeat(64);
    const token = 'sensitive-confirmation-token';
    const failure = Object.assign(new Error(`Login failed for private-smtp-user using private-smtp-password; https://prints.test/confirm?token=${token}`), {
      code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN sensitive-auth-payload',
      response: '535 Authentication failed for student@purdue.edu',
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 465 }),
      envelope: { to: 'student@purdue.edu' }, password: 'arbitrary-password',
      query: 'INSERT INTO jobs VALUES (private-title)', parameters: ['private-notes'],
    });
    logError('email.send_failed', failure, { smtpHost: 'smtp.test', smtpPort: 465, secure: true, purpose: 'confirmation' });
    const raw = errorSpy.mock.calls[0][0] as string, line = JSON.parse(raw);
    expect(line).toMatchObject({ level: 'error', event: 'email.send_failed', smtpHost: 'smtp.test', smtpPort: 465, secure: true });
    expect(line.error).toMatchObject({ code: 'EAUTH', responseCode: 535, command: 'AUTH', cause: { code: 'ECONNREFUSED', syscall: 'connect', port: 465 } });
    expect(line.error.stack).toContain('Login failed');
    for (const secret of ['private-smtp-user', 'private-smtp-password', token, 'sensitive-auth-payload', 'student@purdue.edu', 'arbitrary-password', 'private-title', 'private-notes']) expect(raw).not.toContain(secret);
  });
  test('expected request rejections are warnings and internal failures are errors', async () => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Request('https://prints.test/confirm?token=never-log-this-token', { method: 'POST' });
    const rejected = errorResponse(new HttpError(403, 'Invalid origin'), request);
    expect(rejected.status).toBe(403);
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({ event: 'http.request_failed', status: 403, method: 'POST', path: '/confirm' });
    const failed = errorResponse(new Error('SQLITE_IOERR: disk write failed'), request);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('SQLITE_IOERR');
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).error.message).toContain('SQLITE_IOERR');
    expect(JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls])).not.toContain('never-log-this-token');
  });
  test('wrapped failures preserve root causes and circular errors cannot break logging', () => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const cause = Object.assign(new Error('SMTP rejected delivery'), { code: 'EMESSAGE', responseCode: 550 });
    cause.cause = cause;
    logFailure('submission.failed', new HttpError(502, 'Confirmation email failed', { cause }), { jobId: 'job-reference' });
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toMatchObject({ status: 502, jobId: 'job-reference', error: { cause: { responseCode: 550, cause: '[nested error omitted]' } } });
  });
  test('warnings remain single JSON records even when errors contain newlines', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    logWarning('cleanup.stat_failed', Object.assign(new Error('permission denied\nsecond line'), { code: 'EACCES' }));
    const raw = warnSpy.mock.calls[0][0] as string;
    expect(raw.split('\n')).toHaveLength(1);
    expect(JSON.parse(raw)).toMatchObject({ level: 'warn', error: { code: 'EACCES' } });
  });
  test('CLI failures print diagnostics and set a failing exit code', async () => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runCommand('cleanup', async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); });
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toMatchObject({ event: 'cleanup.failed', error: { code: 'ENOSPC' } });
    } finally { process.exitCode = previousExitCode ?? 0; }
  });
});
