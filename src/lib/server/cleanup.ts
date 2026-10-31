import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db';
import { config } from './config';
import { removeFile } from './storage';
import { logWarning } from './log';
import { cleanupSlicerExports } from './slicer-export';

export async function cleanup(now = Date.now()) {
  await cleanupSlicerExports(now);
  const sql = await db();
  // DELETE RETURNING claims expired jobs atomically, racing safely with confirmation/finalization.
  const expired = await sql`DELETE FROM jobs WHERE status = 'pending_confirmation'
    AND ((upload_state = 'ready' AND pending_expires_at <= ${now}) OR (upload_state != 'ready' AND upload_expires_at <= ${now}))
    RETURNING storage_key`;
  for (const job of expired) await removeFile(job.storage_key);
  await sql`DELETE FROM sessions WHERE expires_at <= ${now}`;
  const dir = join(config().dataDir, 'files');
  let orphans = 0;
  for (const name of await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^[a-f0-9-]{36}\.stl(?:\.part)?$/.test(name)) continue;
    const path = join(dir, name), key = name.replace(/\.part$/, '');
    const info = await stat(path).catch(error => {
      if (error.code !== 'ENOENT') logWarning('cleanup.stat_failed', error, { storageKey: key });
      return null;
    });
    if (!info || info.mtimeMs > now - 2 * 3600000) continue;
    if ((await sql`SELECT id FROM jobs WHERE storage_key = ${key}`).length) continue;
    await unlink(path).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    orphans++;
  }
  return { expired: expired.length, orphans };
}
