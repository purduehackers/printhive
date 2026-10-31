import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { db } from './db';
import { filePath } from './storage';
import { invariant } from './errors';
import { seal, unseal } from './tokens';

export const thumbnailPath = (key: string) => filePath(key).replace(/\.stl$/, '.png');
export const thumbnailURL = (id: string) => `/api/print-thumbnails/${id}?token=${seal(id, 'thumbnail', Date.now() + 24 * 3600000)}`;

export async function storeThumbnail(id: string, token: string, request: Request) {
  const capability = unseal(token, 'upload');
  invariant(capability.id === id && capability.ids.length === 1, 403, 'This upload link belongs to another print.');
  invariant(request.headers.get('content-type') === 'image/png' && request.body, 415, 'Send a PNG thumbnail.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 2000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      invariant(!timedOut && !request.signal.aborted, 408, 'Thumbnail upload timed out.');
      if (done) break;
      size += value.byteLength;
      invariant(size <= 65536, 413, 'Thumbnail is too large.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timeout); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  // No decoding or server rendering: accept only bounded 128px PNG images, served with nosniff.
  invariant(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) === 128 && bytes.readUInt32BE(20) === 128 &&
    bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND', 400, 'Use a 128 × 128 PNG thumbnail.');
  const sql = await db();
  // Serialize the small write with upload claiming/cleanup; artwork becomes immutable when STL upload begins.
  await sql.begin(async tx => {
    const [job] = await tx`SELECT storage_key FROM jobs WHERE id = ${id} AND upload_state = 'reserved'
      AND status = 'pending_confirmation' AND has_thumbnail = 0 AND upload_expires_at > ${Date.now()}`;
    invariant(job, 409, 'This thumbnail upload has already been used or has expired.');
    const path = thumbnailPath(job.storage_key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Bun.write(path, bytes);
    await tx`UPDATE jobs SET has_thumbnail = 1 WHERE id = ${id}`;
  });
}

export async function readThumbnail(id: string, request?: Request) {
  const sql = await db();
  const [job] = await sql`SELECT storage_key FROM jobs WHERE id = ${id} AND has_thumbnail = 1 AND confirmed_at IS NOT NULL`;
  invariant(job, 404, 'Thumbnail not found.');
  const path = thumbnailPath(job.storage_key);
  const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  invariant(info, 404, 'Thumbnail not found.');
  const headers = new Headers({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (request) {
    // Operator requests authenticate before reaching here. Always revalidate access,
    // but reuse the browser's image bytes when this immutable thumbnail is unchanged.
    const tag = `"${id}-${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    headers.set('ETag', `W/${tag}`);
    headers.set('Cache-Control', 'private, no-cache');
    const matches = request.headers.get('if-none-match')?.split(',').some(value => {
      const candidate = value.trim();
      return candidate === '*' || candidate.replace(/^W\//, '') === tag;
    });
    if (matches) return new Response(null, { status: 304, headers });
  }
  return new Response(Bun.file(path), { headers });
}
