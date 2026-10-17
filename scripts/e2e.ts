import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startHarness } from '../tests/harness';
import { binarySTL, submission } from '../tests/fixtures';

const h = await startHarness();
const headers = { Origin: h.origin, 'Content-Type': 'application/json' };
const post = (path: string, data: unknown, cookie = '') => fetch(h.origin + path, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify(data), redirect: 'manual' });
const queue = async () => (await fetch(h.origin + '/api/queue')).json();
async function submit(title: string, file: Blob) {
  const response = await post('/api/submissions', submission({ title, file_size: file.size }));
  assert.equal(response.status, 201, await response.clone().text());
  const { id, capability } = await response.json();
  const uploaded = await fetch(`${h.origin}/api/submissions/${id}/file`, { method: 'PUT', headers: { Origin: h.origin, Authorization: `Bearer ${capability}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }, body: file.stream() });
  return { id, uploaded };
}
try {
  assert.equal((await fetch(h.origin)).status, 200);
  assert.equal((await fetch(h.origin + '/operator', { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(h.origin + '/api/submissions', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  const file = new Blob([binarySTL(180000)]); // 8.6 MiB, above small server-body defaults.
  const one = await submit('Production stream test', file);
  assert.equal(one.uploaded.status, 200, await one.uploaded.clone().text());
  assert.equal((await queue()).length, 0);
  const url = h.messages[0].match(/http[^\s]+\/confirm\?token=[^\s]+/)![0];
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /Confirm print/);
  assert.equal((await queue()).length, 0);
  const token = new URL(url).searchParams.get('token')!;
  const confirm = await fetch(h.origin + '/confirm', { method: 'POST', headers: { Origin: h.origin }, body: new URLSearchParams({ token }) });
  assert.equal(confirm.status, 200, await confirm.clone().text()); assert.match(await confirm.text(), /in the queue/);
  const publicJob = (await queue())[0]; assert.equal(publicJob.id, one.id); assert.equal(publicJob.email, undefined); assert.equal(publicJob.notes, undefined);
  assert.equal((await fetch(`${h.origin}/api/jobs/${one.id}/file`)).status, 401);
  const login = await post('/api/login', { username: 'operator', password: 'test-password-12345' }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]; assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);
  const downloaded = await fetch(`${h.origin}/api/jobs/${one.id}/file`, { headers: { Cookie: cookie } });
  assert.equal(downloaded.status, 200); assert.equal(createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex'), createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'));
  h.rejectMail(true);
  const update = await post(`/api/jobs/${one.id}/status`, { status: 'printing', version: 1 }, cookie);
  assert.equal(update.status, 200); assert.match((await update.json()).warning, /Status saved/);
  assert.equal((await queue())[0].status, 'printing');
  const failed = await submit('Rejected email', new Blob([binarySTL()])); assert.equal(failed.uploaded.status, 502);
  assert.equal(await Bun.file(join(h.dir, 'files', failed.id + '.stl')).exists(), false);
  h.rejectMail(false);
  const complete = await post(`/api/jobs/${one.id}/status`, { status: 'completed', version: 2 }, cookie); assert.equal(complete.status, 200);
  assert.equal(h.messages.length, 2); assert.match(h.messages[1], /completed/);
  const stale = await post(`/api/jobs/${one.id}/status`, { status: 'queued', version: 2 }, cookie); assert.equal(stale.status, 409);
  await h.restart();
  const records = h.logs().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const smtpFailure = records.find(record => record.event === 'email.send_failed' && record.jobId === failed.id);
  assert.equal(smtpFailure?.error.responseCode, 550);
  assert.match(smtpFailure.error.response, /Test delivery rejection/);
  assert.equal(smtpFailure.purpose, 'confirmation');
  assert.equal(smtpFailure.smtpPort > 0, true);
  assert.equal(records.some(record => record.event === 'job.notification_failed' && record.jobId === one.id && record.jobStatus === 'printing'), true);
  assert.equal(records.some(record => record.event === 'submission.failed' && record.jobId === failed.id && record.error.cause.responseCode === 550), true);
  assert.equal(records.some(record => record.event === 'http.request_failed' && record.status === 403), true);
  for (const privateValue of [token, 'test@purdue.edu', 'Private notes', 'test-password-12345', cookie.split('=')[1]]) assert.equal(h.logs().includes(privateValue), false);
  assert.equal((await fetch(`${h.origin}/api/jobs/${one.id}/file`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${h.origin}/operator/jobs/${one.id}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await queue()).length, 0);
  if (process.env.LARGE_UPLOAD_TEST === '1') {
    const count = Math.floor((500 * 1024 ** 2 - 84) / 50), path = join(h.dir, 'large-fixture.stl');
    const writer = Bun.file(path).writer(), header = new Uint8Array(84); new DataView(header.buffer).setUint32(80, count, true); writer.write(header);
    const block = binarySTL(2048).slice(84);
    for (let i = 0; i < count; i += 2048) { writer.write(block.subarray(0, Math.min(2048, count - i) * 50)); await writer.flush(); }
    await writer.end();
    const large = await submit('500 MiB boundary test', Bun.file(path)); assert.equal(large.uploaded.status, 200, await large.uploaded.text());
    assert.equal(Bun.file(join(h.dir, 'files', large.id + '.stl')).size, 84 + count * 50);
    console.log('Near-500-MiB streamed upload passed.');
  }
  console.log('Production HTTP/SMTP flow passed: streaming, explicit confirmation, privacy, auth, original download, delivery failures, stale writes, and restart persistence.');
} finally { await h.close(); }
