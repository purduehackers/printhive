import { migrate, db } from '../src/lib/server/db';
import { runCommand } from '../src/lib/server/log';
await runCommand('migration', async () => {
  await migrate();
  await (await db()).close();
  console.log('Database migrations applied.');
});
