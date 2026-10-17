import { cleanup } from '../src/lib/server/cleanup';
import { db } from '../src/lib/server/db';
import { runCommand } from '../src/lib/server/log';
await runCommand('cleanup', async () => {
  console.log(await cleanup());
  await (await db()).close();
});
