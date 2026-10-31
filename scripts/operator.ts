import { db, migrate } from '../src/lib/server/db';
import { runCommand } from '../src/lib/server/log';
await runCommand('operator.provision', async () => {
const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) throw new Error('Usage: bun run operator:add <username> (password via stdin)');
if (process.stdin.isTTY) console.log('Enter a password through stdin. Prefer a password manager pipe; terminal input is not masked.');
const password = (await Bun.stdin.text()).replace(/\r?\n$/, '');
if (password.length < 12 || password.length > 1024) throw new Error('Use a password of 12–1024 characters.');
await migrate();
const sql = await db();
const hash = await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
await sql.begin(async tx => {
  const [operator] = await tx`INSERT INTO operators (username, password_hash) VALUES (${username}, ${hash})
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, active = 1 RETURNING id`;
  await tx`DELETE FROM sessions WHERE operator_id = ${operator.id}`;
  await tx`DELETE FROM push_subscriptions WHERE operator_id = ${operator.id}`;
});
await sql.close();
console.log(`Operator ${username} provisioned; previous sessions revoked.`);
});
