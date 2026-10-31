import { db, type DatabaseQueries } from './db';
import { invariant } from './errors';
import type { Operator } from './auth';

export async function listOperators(): Promise<Operator[]> {
  return (await db())`SELECT id, username FROM operators WHERE active = 1 ORDER BY username`;
}

function details(input: unknown, creating: boolean) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid operator details.');
  const { username, password } = input as Record<string, unknown>;
  invariant(typeof username === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(username), 400,
    'Use 1–64 letters, numbers, dots, underscores, or hyphens for the username.');
  const changePassword = creating || (password !== undefined && password !== '');
  invariant(!changePassword || (typeof password === 'string' && password.length >= 12 && password.length <= 1024), 400,
    'Use a password of 12–1024 characters.');
  return { username, password: changePassword ? password as string : undefined };
}

let hashing = 0;
async function hashPassword(password: string) {
  invariant(hashing < 2, 429, 'Account updates are busy. Please try again shortly.');
  hashing++;
  try { return await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 }); }
  finally { hashing--; }
}
async function checkActor(sql: DatabaseQueries, actorId: number) {
  const [actor] = await sql`SELECT id FROM operators WHERE id = ${actorId} AND active = 1`;
  invariant(actor, 401, 'Please log in as an operator.');
}

export async function addOperator(actorId: number, input: unknown): Promise<Operator> {
  const data = details(input, true), hash = await hashPassword(data.password!), sql = await db();
  return sql.begin(async tx => {
    await checkActor(tx, actorId);
    // Reuse a removed account's identity so its print history stays attached.
    const [operator] = await tx`INSERT INTO operators (username, password_hash) VALUES (${data.username}, ${hash})
      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, active = 1
      WHERE operators.active = 0 RETURNING id, username`;
    invariant(operator, 409, 'That username is already in use.');
    await tx`DELETE FROM sessions WHERE operator_id = ${operator.id}`;
    await tx`DELETE FROM push_subscriptions WHERE operator_id = ${operator.id}`;
    return operator;
  });
}

export async function editOperator(actorId: number, id: number, input: unknown): Promise<Operator> {
  const data = details(input, false), hash = data.password === undefined ? null : await hashPassword(data.password), sql = await db();
  return sql.begin(async tx => {
    await checkActor(tx, actorId);
    const [existing] = await tx`SELECT id FROM operators WHERE id = ${id} AND active = 1`;
    invariant(existing, 404, 'Operator not found. Refresh the list.');
    const [operator] = await tx`UPDATE operators SET username = ${data.username}, password_hash = COALESCE(${hash}, password_hash)
      WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM operators WHERE username = ${data.username} AND id != ${id})
      RETURNING id, username`;
    invariant(operator, 409, 'That username is already in use.');
    if (hash !== null) {
      await tx`DELETE FROM sessions WHERE operator_id = ${id}`;
      await tx`DELETE FROM push_subscriptions WHERE operator_id = ${id}`;
    }
    return operator;
  });
}

export async function removeOperator(actorId: number, id: number) {
  const sql = await db();
  await sql.begin(async tx => {
    await checkActor(tx, actorId);
    const [existing] = await tx`SELECT id FROM operators WHERE id = ${id} AND active = 1`;
    invariant(existing, 404, 'Operator not found. Refresh the list.');
    // Count and removal happen in the same write, including concurrent requests.
    const [removed] = await tx`UPDATE operators SET active = 0 WHERE id = ${id} AND active = 1
      AND (SELECT COUNT(*) FROM operators WHERE active = 1) > 1 RETURNING id`;
    invariant(removed, 409, 'The last active operator cannot be removed.');
    await tx`DELETE FROM sessions WHERE operator_id = ${id}`;
    await tx`DELETE FROM push_subscriptions WHERE operator_id = ${id}`;
  });
}
