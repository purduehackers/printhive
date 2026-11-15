import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import webPush from 'web-push';
import { migrate, closeDb } from '../src/lib/server/db';
import { addHiveEmails } from '../src/lib/server/hive-whitelist';
import { reserve, upload } from '../src/lib/server/jobs';
import { asciiSTL, submission } from '../tests/fixtures';
import { localClientId, startLocalId } from './local-test-id';

const root = resolve('data/local-test');
const origin = 'http://127.0.0.1:4323';
const inbox = 'http://127.0.0.1:8026';
const mailpit = resolve(process.env.PRINTHIVE_MAILPIT ?? 'data/dev-mail/mailpit.exe');
if (!await Bun.file(mailpit).exists()) throw new Error('Set PRINTHIVE_MAILPIT to the path of the Mailpit executable.');
if (!await Bun.file('dist/server/entry.mjs').exists()) throw new Error('Run bun run build before starting the local test environment.');

await mkdir(root, { recursive: true });
const settingsPath = resolve(root, 'keys.json');
if (!await Bun.file(settingsPath).exists()) {
  const file = await open(settingsPath, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ uploads: randomBytes(32).toString('hex'), push: webPush.generateVAPIDKeys() }));
  } finally {
    await file.close();
  }
}
const { uploads, push } = await Bun.file(settingsPath).json();
Object.assign(process.env, {
  NODE_ENV: 'test', PRINTHIVE_TEST_LEGACY_AUTH: 'false', PRINTHIVE_LOCAL_ID: 'true',
  PURDUE_HACKERS_CLIENT_ID: localClientId, PURDUE_HACKERS_CLIENT_SECRET: '',
  APP_ORIGIN: origin, HOST: '127.0.0.1', PORT: '4323', DATA_DIR: root,
  SERVER_CERT_PATH: '', SERVER_KEY_PATH: '', TRUST_PROXY: 'false',
  CONFIRMATION_SECRET: uploads,
  SMTP_HOST: '127.0.0.1', SMTP_PORT: '1026', SMTP_SECURE: 'false',
  SMTP_USERNAME: '', SMTP_PASSWORD: '', SMTP_FROM: 'PrintHive Local <printhive@example.test>',
  VAPID_PUBLIC_KEY: push.publicKey, VAPID_PRIVATE_KEY: push.privateKey,
  VAPID_SUBJECT: 'mailto:printhive@example.test',
});
const seed = resolve(root, 'seeded');
await migrate();
if (!await Bun.file(seed).exists()) {
  await addHiveEmails('hive-member@purdue.edu');
  const fixtures = [
    ['HIVE legacy print', 'hive-member@purdue.edu'],
    ['ID legacy print', 'id-member@purdue.edu'],
    ['Alternate email legacy print', 'alternate@purdue.edu'],
    ['Manual linking legacy print', 'manual-link@purdue.edu'],
  ];
  for (const [title, email] of fixtures) {
    const reserved = await reserve(submission({ title, email }), { verifiedEmail: email });
    await upload(reserved.id, reserved.capability, new Request(origin, { method: 'PUT', body: asciiSTL }),
      undefined, { verifiedEmail: email });
  }
  await Bun.write(seed, 'Seeded test whitelist and legacy prints.\n');
}
await closeDb();

const provider = startLocalId();
const children: Bun.Subprocess[] = [];
function stop() {
  provider.stop(true);
  for (const child of children) child.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const mail = Bun.spawn([mailpit, '--listen', '127.0.0.1:8026', '--smtp', '127.0.0.1:1026',
    '--database', resolve(root, 'mailpit.sqlite')], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdout: 'inherit', stderr: 'inherit',
  });
  children.push(mail);
  const app = Bun.spawn([process.execPath, '--no-env-file', 'dist/server/entry.mjs'], {
    env: process.env, stdout: 'inherit', stderr: 'inherit',
  });
  children.push(app);
  console.log(`PrintHive: ${origin}\nMailpit: ${inbox}\nHIVE email: hive-member@purdue.edu`);
  process.exitCode = await Promise.race([mail.exited, app.exited]);
} finally {
  stop();
  await Promise.allSettled(children.map(child => child.exited));
}
