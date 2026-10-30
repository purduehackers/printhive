import { describe, test, expect, beforeAll, beforeEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { asciiSTL, binarySTL, submission } from './fixtures';
import { metadata } from '../src/lib/server/validation';
import { MAX_FEEDBACK_LENGTH, MAX_FILE_BYTES } from '../src/lib/shared';
import { parseSTL } from '../src/lib/stl';
import { seal, unseal, sealVerifiedEmail, unsealVerifiedEmail, getVerifiedEmail, VERIFIED_EMAIL_COOKIE, VERIFIED_EMAIL_TTL } from '../src/lib/server/tokens';
import { db, migrate, closeDb } from '../src/lib/server/db';
import { reserve, upload, confirmation, publicQueue, updateStatus } from '../src/lib/server/jobs';
import { cleanup } from '../src/lib/server/cleanup';
import { filePath, storeUpload } from '../src/lib/server/storage';
import { checkOrigin, smallBody, rateLimit } from '../src/lib/server/http';
import { login, logout, currentOperator, requireOperator } from '../src/lib/server/auth';
import type { APIContext } from 'astro';
import { addOperator, editOperator, listOperators, removeOperator } from '../src/lib/server/operators';

let dir: string;
const accepted: string[] = [];
const mailer = async (mail: { text: string }) => { accepted.push(mail.text); };
const rejected = async () => { throw new Error('SMTP unavailable'); };
const body = (text: BodyInit = asciiSTL) => new Request('http://localhost:4321/file', { method: 'PUT', body: text });
const confirmationToken = () => new URL(accepted.at(-1)!.match(/http[^\s]+\/confirm\?token=[^\s]+/)![0]).searchParams.get('token')!;
function tamperToken(token: string) {
  const bytes = Buffer.from(token, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}
async function ready() { const r = await reserve(submission()); await upload(r.id, r.capability, body(), mailer); return { ...r, token: confirmationToken() }; }
async function queued() { const r = await ready(); await confirmation(r.token, true); return r; }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-test-'));
  process.env.DATA_DIR = dir; process.env.CONFIRMATION_SECRET = 'a'.repeat(64); process.env.APP_ORIGIN = 'http://localhost:4321'; process.env.NODE_ENV = 'test';
  await migrate();
  const sql = await db(); await sql`INSERT INTO operators (id, username, password_hash) VALUES (1, 'operator', 'test')`;
});
beforeEach(async () => { const sql = await db(); await sql`DELETE FROM jobs`; await sql`DELETE FROM sessions`; accepted.length = 0; });
afterAll(async () => { await closeDb(); await rm(dir, { recursive: true, force: true }); });

describe('validation and bounded STL parsing', () => {
  test('production React rendering works on the supported Bun runtime', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'import { createElement } from "react"; import { renderToString } from "react-dom/server"; console.log(renderToString(createElement("p", null, "ready")));'], {
      env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(error).toBe(''); expect(exitCode).toBe(0); expect(output).toContain('<p>ready</p>');
  });
  test('defaults match requested print settings and email normalizes', () => {
    expect(metadata(submission({ email: 'Test@PURDUE.EDU' }))).toMatchObject({ email: 'test@purdue.edu', infill: 15, layer_height: 0.2, supports: 'operator', color: 'black', copies: 1, mirror: 0 });
  });
  test('single submissions preserve explicit zero angles and omitted legacy defaults', async () => {
    const explicit = await reserve(submission({ support_angle: 0 }));
    const legacy = await reserve(submission());
    const sql = await db();
    expect((await sql`SELECT support_angle FROM jobs WHERE id=${explicit.id}`)[0].support_angle).toBe(0);
    expect((await sql`SELECT support_angle FROM jobs WHERE id=${legacy.id}`)[0].support_angle).toBeNull();
  });
  test('rejects wrong domains, bounds, and unsupported settings', () => {
    for (const overrides of [{ email: 'test@cs.purdue.edu' }, { email: 'test@purdue.edu.evil.com' }, { title: 'x'.repeat(201) }, { notes: 'x'.repeat(5001) }, { infill: 40 }, { mirror: true }, { copies: 6 }, { color: 'blue' }, { file_size: MAX_FILE_BYTES + 1 }, { original_filename: '../bad.stl' }]) expect(() => metadata(submission(overrides))).toThrow();
    expect(metadata(submission({ file_size: MAX_FILE_BYTES })).file_size).toBe(MAX_FILE_BYTES);
  });
  test('ASCII and binary validation agrees on triangles and dimensions', async () => {
    for (const blob of [new Blob([asciiSTL]), new Blob([binarySTL()])]) expect(await parseSTL(blob)).toEqual({ triangles: 1, min: [0, 0, 0], max: [10, 10, 0] });
  });
  test('binary STL trailer metadata and regular support settings are accepted', async () => {
    const info=await parseSTL(new Blob([binarySTL(),new Uint8Array([0,1,2,3])]));
    expect(info.triangles).toBe(1);
    expect(metadata(submission({supports:'normal'})).supports).toBe('normal');
  });
  test('advisory STL normals and Unicode solid names do not reject finite geometry', async () => {
    const binary=binarySTL();new DataView(binary.buffer).setFloat32(84,NaN,true);
    expect((await parseSTL(new Blob([binary]))).triangles).toBe(1);
    expect((await parseSTL(new Blob([asciiSTL.replaceAll('solid test','solid pièce').replace('normal 0 0 1','normal nan bad 0')]))).triangles).toBe(1);
  });
  test('binary solid headers are accepted, and parser spans multiple blocks', async () => {
    const bytes = binarySTL(2100); bytes.set(new TextEncoder().encode('solid binary STL'));
    const vertices: number[] = [];
    expect((await parseSTL(new Blob([bytes]), (_, i) => vertices.push(i))).triangles).toBe(2100);
    expect(vertices.length).toBe(2100);
  });
  test('rejects malformed, empty, truncated, nonfinite and excessive line input', async () => {
    const nan = binarySTL(); new DataView(nan.buffer).setFloat32(96, NaN, true);
    for (const source of ['', 'not an STL', asciiSTL.replace('endloop', 'oops'), asciiSTL.replace('vertex 10', 'vertex Infinity'), asciiSTL.replace('endsolid test', ''), 'solid ' + 'x'.repeat(70000), binarySTL().slice(0, 120), nan]) await expect(parseSTL(new Blob([source]))).rejects.toThrow();
  });
});
describe('authenticated links and confirmation', () => {
  test('purpose, expiry, tampering, and secret rotation are enforced', () => {
    const id = randomUUID(), token = seal(id, 'confirm', 2000);
    expect(unseal(token, 'confirm', 1000).id).toBe(id);
    expect(() => unseal(token, 'upload', 1000)).toThrow();
    expect(() => unseal(token, 'confirm', 2000)).toThrow('expired');
    const tampered = tamperToken(token);
    expect(tampered).not.toBe(token);
    expect(() => unseal(tampered, 'confirm', 1000)).toThrow('invalid');
    process.env.CONFIRMATION_SECRET = 'b'.repeat(64);
    expect(() => unseal(token, 'confirm', 1000)).toThrow('invalid');
    process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  });
  test('verified email tokens enforce 30-day TTL, domain validation, tampering, and purpose isolation', () => {
    expect(VERIFIED_EMAIL_TTL).toBe(30 * 24 * 60 * 60 * 1000);
    const now = 1_000_000;
    const token = sealVerifiedEmail('  Student@Purdue.EDU ', now + VERIFIED_EMAIL_TTL);
    expect(unsealVerifiedEmail(token, now)).toEqual({ email: 'student@purdue.edu', expires: now + VERIFIED_EMAIL_TTL });
    expect(unsealVerifiedEmail(token, now + VERIFIED_EMAIL_TTL - 1)?.email).toBe('student@purdue.edu');
    expect(unsealVerifiedEmail(token, now + VERIFIED_EMAIL_TTL)).toBeNull();
    const tampered = tamperToken(token);
    expect(tampered).not.toBe(token);
    expect(unsealVerifiedEmail(tampered, now)).toBeNull();
    expect(() => unseal(token, 'confirm', now)).toThrow();
    const confirmTok = seal(randomUUID(), 'confirm', now + 10000);
    expect(unsealVerifiedEmail(confirmTok, now)).toBeNull();
    expect(unsealVerifiedEmail(sealVerifiedEmail('user@example.com', now + 10000), now)).toBeNull();
    process.env.CONFIRMATION_SECRET = 'b'.repeat(64);
    expect(unsealVerifiedEmail(token, now)).toBeNull();
    process.env.CONFIRMATION_SECRET = 'a'.repeat(64);

    const reqWithHeader = new Request('http://localhost:4321/api/submissions', { headers: { 'x-verified-email-token': token } });
    expect(getVerifiedEmail({ request: reqWithHeader }, now)).toBe('student@purdue.edu');
    expect(getVerifiedEmail({ cookies: { get: (k: string) => k === VERIFIED_EMAIL_COOKIE ? { value: token } : undefined } }, now)).toBe('student@purdue.edu');
  });
  test('submissions with a matching verified email skip confirmation email and queue immediately', async () => {
    const r = await reserve(submission({ email: 'verified@purdue.edu' }), { verifiedEmail: 'verified@purdue.edu' });
    expect(r.verified).toBe(true);
    const up = await upload(r.id, r.capability, body(), rejected, { verifiedEmail: 'verified@purdue.edu' });
    expect(up.confirmed).toBe(true);
    expect(accepted).toHaveLength(0);
    const queue = await publicQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(r.id);
    expect(queue[0].status).toBe('queued');

    // Mismatched verified email falls back to normal confirmation email flow
    const other = await reserve(submission({ email: 'different@purdue.edu' }), { verifiedEmail: 'verified@purdue.edu' });
    expect(other.verified).toBe(false);
    const otherUp = await upload(other.id, other.capability, body(), mailer, { verifiedEmail: 'verified@purdue.edu' });
    expect(otherUp.confirmed).toBe(false);
    expect(accepted).toHaveLength(1);
    expect(await publicQueue()).toHaveLength(1);
  });
  test('GET does not enqueue; racing POSTs enqueue once and keep the position', async () => {
    const r = await ready(); await confirmation(r.token);
    expect(await publicQueue()).toHaveLength(0);
    const results = await Promise.all([confirmation(r.token, true), confirmation(r.token, true)]);
    expect(results.filter(r => !r.already)).toHaveLength(1);
    const [job] = await publicQueue();
    await confirmation(r.token, true);
    expect((await publicQueue())[0].queued_at).toBe(job.queued_at);
    expect((await publicQueue())[0].version).toBe(1);
  });
  test('database expiry is authoritative and incomplete jobs cannot confirm', async () => {
    const r = await reserve(submission());
    await expect(confirmation(seal(r.id, 'confirm', Date.now() + 86400000), true)).rejects.toThrow('not ready');
    await upload(r.id, r.capability, body(), mailer);
    const sql = await db(); await sql`UPDATE jobs SET pending_expires_at = 1 WHERE id = ${r.id}`;
    await expect(confirmation(confirmationToken(), true)).rejects.toThrow('expired');
  });
  test('public queue contains no email, notes, filenames or storage references', async () => {
    await queued(); const [job] = await publicQueue();
    expect(job.support_angle).toBeNull();
    expect(job.batch_id).toBeNull();
    expect(job.batch_title).toBeNull();
    expect(job.group_name).toBeNull();
    expect(Object.keys(job).sort()).toEqual(['id', 'title', 'status', 'infill', 'material', 'color', 'layer_height', 'supports', 'support_angle', 'copies', 'mirror', 'queued_at', 'confirmed_at', 'version', 'batch_id', 'batch_title', 'group_name'].sort());
  });
});
describe('upload and delivery failure semantics', () => {
  test('successful upload stores original bytes and rejects capability reuse', async () => {
    const r = await ready(); expect(await Bun.file(filePath(r.id + '.stl')).text()).toBe(asciiSTL);
    await expect(upload(r.id, r.capability, body(), mailer)).rejects.toThrow('already');
    expect(await Bun.file(filePath(r.id + '.stl')).exists()).toBe(true);
  });
  test('confirmation SMTP failure removes the job and files', async () => {
    const r = await reserve(submission());
    await expect(upload(r.id, r.capability, body(), rejected)).rejects.toThrow('could not send');
    expect(await (await db())`SELECT * FROM jobs`).toHaveLength(0);
    expect(await Bun.file(filePath(r.id + '.stl')).exists()).toBe(false);
    await expect(confirmation(seal(r.id, 'confirm', Date.now() + 1000), true)).rejects.toThrow('no longer');
  });
  test('malformed and partial uploads remove all reserved state', async () => {
    for (const value of ['bad', asciiSTL.slice(0, -1)]) {
      const r = await reserve(submission());
      await expect(upload(r.id, r.capability, body(value), mailer)).rejects.toThrow();
      expect(await Bun.file(filePath(r.id + '.stl', true)).exists()).toBe(false);
    }
    expect(await (await db())`SELECT * FROM jobs`).toHaveLength(0); expect(accepted.length).toBe(0);
  });
  test('byte counting rejects oversized streams independent of Content-Length', async () => {
    const key = randomUUID() + '.stl';
    await expect(storeUpload(body(asciiSTL), key, 4, Date.now() + 1000)).rejects.toThrow('exceeds');
    expect(await Bun.file(filePath(key, true)).exists()).toBe(false);
  });
  test('disconnects release the file and reservation', async () => {
    const r = await reserve(submission());
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('solid')); c.error(new Error('disconnected')); } });
    await expect(upload(r.id, r.capability, body(stream), mailer)).rejects.toThrow();
    expect(await (await db())`SELECT * FROM jobs`).toHaveLength(0);
  });
});
describe('operator transitions', () => {
  test('queued and printing jobs can be returned with private feedback and a status email', async () => {
    for (const status of ['queued', 'printing']) {
      const r = await queued();
      if (status === 'printing') await updateStatus(r.id, 'printing', 1, 1, { mailer });
      const feedback = 'Please thicken the walls.\nThen submit a revised STL.';
      accepted.length = 0;
      const version = status === 'printing' ? 2 : 1;
      const result = await updateStatus(r.id, 'rejected', version, 1, { feedback: `  ${feedback}  `, mailer });
      expect(result.job.status).toBe('rejected'); expect(result.job.version).toBe(version + 1);
      expect(result.warning).toBeUndefined(); expect(result.changed).toBe(true);
      expect((await publicQueue()).some(job => job.id === r.id)).toBe(false);
      const [event] = await (await db())`SELECT * FROM job_events WHERE job_id = ${r.id} ORDER BY id DESC`;
      expect(event).toMatchObject({ previous_status: status, next_status: 'rejected', operator_id: 1, feedback });
      expect(accepted).toHaveLength(1); expect(accepted[0]).toContain(feedback);
      expect(accepted[0]).toContain('http://localhost:4321/submit');
      expect(await Bun.file(filePath(r.id + '.stl')).exists()).toBe(true);
      // A repeated request cannot send again, replace feedback, or reopen through confirmation.
      await expect(updateStatus(r.id, 'rejected', version, 1, { feedback, mailer })).rejects.toMatchObject({ status: 409 });
      expect((await updateStatus(r.id, 'rejected', version + 1, 1, { feedback, mailer })).changed).toBe(false);
      await confirmation(r.token, true);
      expect(accepted).toHaveLength(1); expect(await publicQueue()).toHaveLength(0);
      const requeued = await updateStatus(r.id, 'queued', version + 1, 1, { mailer });
      expect(requeued.job.status).toBe('queued'); expect(accepted.at(-1)).not.toContain(feedback);
      const [history] = await (await db())`SELECT feedback FROM job_events WHERE id = ${event.id}`;
      expect(history.feedback).toBe(feedback);
      await updateStatus(r.id, 'canceled', version + 2, 1, { mailer });
    }
  });
  test('invalid return feedback leaves the job, history and emails unchanged', async () => {
    const r = await queued(); accepted.length = 0;
    for (const feedback of [undefined, null, '', ' \n\t ', 123, {}, 'x'.repeat(MAX_FEEDBACK_LENGTH + 1), 'bad\u0000text']) {
      await expect(updateStatus(r.id, 'rejected', 1, 1, { feedback, mailer })).rejects.toMatchObject({ status: 400 });
    }
    await expect(updateStatus(r.id, 'printing', 1, 1, { feedback: 'Unsent feedback', mailer })).rejects.toMatchObject({ status: 400 });
    expect((await publicQueue())[0].version).toBe(1);
    expect(await (await db())`SELECT * FROM job_events`).toHaveLength(0); expect(accepted).toHaveLength(0);
  });
  test('a return email failure preserves feedback and reports the delivery warning', async () => {
    const r = await queued(), feedback = 'x'.repeat(MAX_FEEDBACK_LENGTH);
    const result = await updateStatus(r.id, 'rejected', 1, 1, { feedback, mailer: rejected });
    expect(result.warning).toContain('Status saved'); expect(result.job.status).toBe('rejected');
    const [event] = await (await db())`SELECT * FROM job_events WHERE job_id = ${r.id}`;
    expect(event.feedback).toBe(feedback); expect(await publicQueue()).toHaveLength(0);
  });
  test('racing return and print updates save only one event and send one email', async () => {
    const r = await queued(); accepted.length = 0;
    const results = await Promise.allSettled([
      updateStatus(r.id, 'rejected', 1, 1, { feedback: 'Please repair the mesh.', mailer }),
      updateStatus(r.id, 'printing', 1, 1, { mailer }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await (await db())`SELECT * FROM job_events`).toHaveLength(1); expect(accepted).toHaveLength(1);
  });
  test('multiple prints can print simultaneously, failures preserve actual status', async () => {
    const one = await queued(), two = await queued();
    const result = await updateStatus(one.id, 'printing', 1, 1, { mailer: rejected });
    expect(result.warning).toContain('Status saved');
    await updateStatus(two.id, 'printing', 1, 1, { mailer });
    expect((await publicQueue()).filter(j => j.status === 'printing')).toHaveLength(2);
    expect(await (await db())`SELECT * FROM job_events`).toHaveLength(2);
  });
  test('invalid transitions and stale versions are rejected', async () => {
    const r = await queued();
    await expect(updateStatus(r.id, 'completed', 1, 1, { mailer })).rejects.toThrow('not allowed');
    const results = await Promise.allSettled([updateStatus(r.id, 'printing', 1, 1, { mailer }), updateStatus(r.id, 'canceled', 1, 1, { mailer })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await (await db())`SELECT * FROM job_events`).toHaveLength(1);
  });
  test('no-op does not email; requeue goes to the end and link cannot reset state', async () => {
    const r = await queued(); accepted.length = 0;
    expect((await updateStatus(r.id, 'queued', 1, 1, { mailer })).changed).toBe(false); expect(accepted).toHaveLength(0);
    await updateStatus(r.id, 'canceled', 1, 1, { mailer }); const two = await queued();
    await Bun.sleep(2); await updateStatus(r.id, 'queued', 2, 1, { mailer });
    expect((await publicQueue()).map(j => j.id)).toEqual([two.id, r.id]);
    await updateStatus(r.id, 'printing', 3, 1, { mailer }); await confirmation(r.token, true);
    expect((await publicQueue()).find(j => j.id === r.id)?.status).toBe('printing');
  });
});
describe('cleanup and request security', () => {
  test('cleanup expires pending jobs, retains confirmed files and removes old orphans', async () => {
    const expired = await ready(), keep = await queued(), unfinished = await reserve(submission());
    const sql = await db(); await sql`UPDATE jobs SET pending_expires_at = 1 WHERE id = ${expired.id}`;
    await sql`UPDATE jobs SET upload_expires_at = 1 WHERE id = ${unfinished.id}`;
    const orphan = randomUUID() + '.stl'; await Bun.write(filePath(orphan), asciiSTL); await utimes(filePath(orphan), new Date(0), new Date(0));
    expect(await cleanup()).toMatchObject({ expired: 2 });
    expect(await Bun.file(filePath(expired.id + '.stl')).exists()).toBe(false);
    expect(await Bun.file(filePath(keep.id + '.stl')).exists()).toBe(true);
    expect(await Bun.file(filePath(orphan)).exists()).toBe(false);
    expect((await stat(filePath(keep.id + '.stl'))).size).toBe(submission().file_size);
  });
  test('cross-origin requests and oversized metadata are rejected', async () => {
    expect(() => checkOrigin(new Request('http://localhost:4321', { headers: { origin: 'https://evil.com' } }))).toThrow();
    checkOrigin(new Request('http://localhost:4321', { headers: { origin: 'http://localhost:4321' } }));
    await expect(smallBody(body('x'.repeat(32769)))).rejects.toThrow('too large');
    rateLimit('test', 1, 10000); expect(() => rateLimit('test', 1, 10000)).toThrow('Too many');
  });
  test('operator credentials, hashed sessions, revocation, expiry and logout', async () => {
    const sql = await db(), password = 'this-is-a-test-password';
    await sql`UPDATE operators SET password_hash = ${await Bun.password.hash(password, { algorithm: 'argon2id' })} WHERE id = 1`;
    const jar = new Map<string, string>(); let cookieOptions: any;
    const context = { cookies: { get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined,
      set: (key: string, value: string, options: any) => { jar.set(key, value); cookieOptions = options; }, delete: (key: string) => jar.delete(key) } } as unknown as APIContext;
    await expect(requireOperator(context)).rejects.toThrow('log in');
    await expect(login(context, 'operator', 'wrong')).rejects.toThrow('Incorrect');
    await login(context, 'operator', password);
    expect(cookieOptions).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/' });
    expect((await currentOperator(context))?.username).toBe('operator');
    const [session] = await sql`SELECT * FROM sessions`; expect([...jar.values()]).not.toContain(session.token_hash);
    await sql`UPDATE sessions SET expires_at = 1`; expect(await currentOperator(context)).toBeNull();
    await login(context, 'operator', password); await sql`UPDATE operators SET active = 0 WHERE id = 1`;
    expect(await currentOperator(context)).toBeNull(); await sql`UPDATE operators SET active = 1 WHERE id = 1`;
    await logout(context); expect(await currentOperator(context)).toBeNull(); expect(await sql`SELECT * FROM sessions`).toHaveLength(0);
  });
});

describe('operator account management', () => {
  beforeEach(async () => {
    const sql = await db();
    await sql`DELETE FROM operators WHERE id != 1`;
    await sql`UPDATE operators SET username = 'operator', active = 1 WHERE id = 1`;
  });
  test('creates hashed credentials and exposes only account IDs and usernames', async () => {
    const added = await addOperator(1, { username: 'new.operator', password: 'new-operator-password' });
    expect(Object.keys(added).sort()).toEqual(['id', 'username']);
    const [stored] = await (await db())`SELECT * FROM operators WHERE id = ${added.id}`;
    expect(stored.password_hash).not.toBe('new-operator-password');
    expect(await Bun.password.verify('new-operator-password', stored.password_hash)).toBe(true);
    expect(await listOperators()).toHaveLength(2);
    expect((await listOperators()).every(item => Object.keys(item).length === 2)).toBe(true);
  });
  test('rejects invalid input and duplicate usernames without changing the existing account', async () => {
    for (const input of [null, [], { username: 'bad name', password: 'long-enough-password' }, { username: 'valid', password: 'short' }, { username: 'valid', password: null }]) {
      await expect(addOperator(1, input)).rejects.toMatchObject({ status: 400 });
    }
    await expect(addOperator(1, { username: 'operator', password: 'replacement-password' })).rejects.toMatchObject({ status: 409 });
    const other = await addOperator(1, { username: 'other', password: 'other-password-123' });
    await expect(editOperator(1, other.id, { username: 'operator' })).rejects.toMatchObject({ status: 409 });
    await expect(editOperator(1, other.id, { username: 'other', password: 123 })).rejects.toMatchObject({ status: 400 });
    await expect(editOperator(1, 999999, { username: 'missing' })).rejects.toMatchObject({ status: 404 });
    expect(await listOperators()).toContainEqual(other);
  });
  test('renaming preserves the password and sessions; password reset revokes sessions', async () => {
    const other = await addOperator(1, { username: 'other', password: 'other-password-123' }), sql = await db();
    await sql`INSERT INTO sessions VALUES (${'c'.repeat(64)}, ${other.id}, ${Date.now() + 60000})`;
    const renamed = await editOperator(1, other.id, { username: 'renamed', password: '' });
    expect(renamed).toEqual({ id: other.id, username: 'renamed' });
    expect(await sql`SELECT * FROM sessions WHERE operator_id = ${other.id}`).toHaveLength(1);
    await editOperator(1, other.id, { username: 'renamed', password: 'replacement-password' });
    expect(await sql`SELECT * FROM sessions WHERE operator_id = ${other.id}`).toHaveLength(0);
    const [stored] = await sql`SELECT password_hash FROM operators WHERE id = ${other.id}`;
    expect(await Bun.password.verify('replacement-password', stored.password_hash)).toBe(true);
    expect(await Bun.password.verify('other-password-123', stored.password_hash)).toBe(false);
  });
  test('removal preserves print history and re-adding an account restores its identity', async () => {
    const other = await addOperator(1, { username: 'other', password: 'other-password-123' }), sql = await db();
    const job = await queued();
    await updateStatus(job.id, 'printing', 1, other.id, { mailer });
    await sql`INSERT INTO sessions VALUES (${'d'.repeat(64)}, ${other.id}, ${Date.now() + 60000})`;
    await removeOperator(1, other.id);
    expect(await listOperators()).toHaveLength(1);
    expect(await sql`SELECT * FROM sessions WHERE operator_id = ${other.id}`).toHaveLength(0);
    expect(await sql`SELECT * FROM job_events WHERE operator_id = ${other.id}`).toHaveLength(1);
    const restored = await addOperator(1, { username: 'other', password: 'restored-password' });
    expect(restored.id).toBe(other.id);
    expect(await sql`SELECT * FROM sessions WHERE operator_id = ${other.id}`).toHaveLength(0);
  });
  test('the last operator survives even when two operators remove each other concurrently', async () => {
    await expect(removeOperator(1, 1)).rejects.toMatchObject({ status: 409 });
    const other = await addOperator(1, { username: 'other', password: 'other-password-123' });
    const outcomes = await Promise.allSettled([removeOperator(1, other.id), removeOperator(other.id, 1)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await listOperators()).toHaveLength(1);
  });
  test('an operator removed during another request cannot change accounts', async () => {
    const other = await addOperator(1, { username: 'other', password: 'other-password-123' });
    await removeOperator(other.id, 1);
    await expect(editOperator(1, other.id, { username: 'stolen' })).rejects.toMatchObject({ status: 401 });
    await expect(removeOperator(1, other.id)).rejects.toMatchObject({ status: 401 });
    await expect(addOperator(1, { username: 'revoked', password: 'revoked-password' })).rejects.toMatchObject({ status: 401 });
  });
  test('a password reset during login cannot create a session with the old credentials', async () => {
    const other = await addOperator(1, { username: 'other', password: 'other-password-123' });
    let started!: () => void, release!: (valid: boolean) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const verify = spyOn(Bun.password, 'verify').mockImplementation(() => { started(); return gate; });
    const setCookie = mock();
    const context = { cookies: { set: setCookie } } as unknown as APIContext;
    try {
      const pending = login(context, 'other', 'other-password-123');
      await entered;
      await editOperator(1, other.id, { username: 'other', password: 'replacement-password' });
      release(true);
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(await (await db())`SELECT * FROM sessions WHERE operator_id = ${other.id}`).toHaveLength(0);
      expect(setCookie).not.toHaveBeenCalled();
    } finally { release(false); verify.mockRestore(); }
  });
});
