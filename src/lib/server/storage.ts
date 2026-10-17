import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { invariant, HttpError } from './errors';
import { MAX_FILE_BYTES } from '../shared';
import { parseSTL } from '../stl';

export function filePath(key: string, temporary = false) {
  invariant(/^[a-f0-9-]{36}\.stl$/.test(key), 400, 'Invalid file reference.');
  return join(config().dataDir, 'files', key + (temporary ? '.part' : ''));
}
export async function removeFile(key: string) {
  for (const temp of [false, true]) await unlink(filePath(key, temp)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
}
export async function storeUpload(request: Request, key: string, expected: number, deadline: number) {
  invariant(request.body, 400, 'The STL upload is empty.');
  const length = request.headers.get('content-length');
  invariant(length === null || Number(length) === expected, 400, 'File size does not match the reservation.');
  await mkdir(join(config().dataDir, 'files'), { recursive: true, mode: 0o700 });
  const writer = Bun.file(filePath(key, true)).writer({ highWaterMark: 64 * 1024 });
  const reader = request.body.getReader();
  let bytes = 0, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, Math.max(1, deadline - Date.now()));
  try {
    while (true) {
      const { value, done } = await reader.read();
      invariant(!timedOut && !request.signal.aborted && Date.now() < deadline, 408, 'Upload timed out or was canceled. Please try again.');
      if (done) break;
      bytes += value.byteLength;
      invariant(bytes <= MAX_FILE_BYTES && bytes <= expected, 413, 'The STL exceeds the allowed file size.');
      writer.write(value);
      await writer.flush();
    }
    invariant(bytes === expected, 400, 'The upload was incomplete. Please try again.');
    await writer.end();
    try { await parseSTL(Bun.file(filePath(key, true))); }
    catch { throw new HttpError(400, 'Invalid STL. Upload a complete ASCII or binary STL with finite coordinates.'); }
    invariant(Date.now() < deadline, 408, 'Upload expired during validation. Please try again.');
    await rename(filePath(key, true), filePath(key));
  } catch (e) {
    await reader.cancel().catch(() => {});
    try { await writer.end(); } catch { /* Already closed. */ }
    await removeFile(key);
    throw e;
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
