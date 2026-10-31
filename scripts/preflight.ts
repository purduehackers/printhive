import { randomUUID } from 'node:crypto';
import { config, pushConfig } from '../src/lib/server/config';
import { seal } from '../src/lib/server/tokens';
import { runCommand } from '../src/lib/server/log';

await runCommand('startup.validation', async () => {
  const settings = config();
  pushConfig();
  seal(randomUUID(), 'upload', Date.now() + 1000);
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error('Set SMTP_HOST and SMTP_FROM before starting PrintHive.');
  if (settings.production && process.env.SMTP_SECURE === 'false') throw new Error('Production requires implicit SMTPS (SMTP_SECURE=true).');
  console.log('Runtime configuration validated.');
});
