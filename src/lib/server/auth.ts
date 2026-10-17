import type { APIContext } from 'astro';
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { invariant } from './errors';

export const SESSION_COOKIE = 'printhive_session';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Operator { id: number; username: string }
export async function currentOperator(context: Pick<APIContext, 'cookies'>): Promise<Operator | null> {
  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sql = await db();
  const [operator] = await sql`SELECT o.id, o.username FROM operators o JOIN sessions s ON s.operator_id = o.id
    WHERE s.token_hash = ${digest(token)} AND s.expires_at > ${Date.now()} AND o.active = 1`;
  return operator ?? null;
}
export async function requireOperator(context: Pick<APIContext, 'cookies'>) {
  const operator = await currentOperator(context);
  invariant(operator, 401, 'Please log in as an operator.');
  return operator;
}
let dummyHash: Promise<string> | undefined;
let verifying = 0;
export async function login(context: APIContext, username: unknown, password: unknown) {
  invariant(typeof username === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(username) && typeof password === 'string' && password.length <= 1024, 400, 'Enter a valid username and password.');
  invariant(verifying < 2, 429, 'Login is busy. Please try again shortly.');
  verifying++;
  try {
    const sql = await db();
    const [operator] = await sql`SELECT * FROM operators WHERE username = ${username}`;
    dummyHash ??= Bun.password.hash(randomBytes(32).toString('hex'), { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
    const valid = await Bun.password.verify(password, operator?.password_hash ?? await dummyHash);
    invariant(valid && operator?.active === 1, 401, 'Incorrect username or password.');
    const token = randomBytes(32).toString('hex'), expires = Date.now() + config().sessionTTL;
    await sql`DELETE FROM sessions WHERE expires_at <= ${Date.now()}`;
    // A reset/removal during password verification must not create a fresh session
    // using credentials that have just been revoked.
    const [session] = await sql`INSERT INTO sessions (token_hash, operator_id, expires_at)
      SELECT ${digest(token)}, id, ${expires} FROM operators
      WHERE id = ${operator.id} AND active = 1 AND password_hash = ${operator.password_hash}
      RETURNING token_hash`;
    invariant(session, 401, 'Credentials changed. Please sign in again.');
    context.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: config().production,
      sameSite: 'strict', path: '/', expires: new Date(expires) });
  } finally { verifying--; }
}
export async function logout(context: APIContext) {
  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (token) { const sql = await db(); await sql`DELETE FROM sessions WHERE token_hash = ${digest(token)}`; }
  context.cookies.delete(SESSION_COOKIE, { path: '/' });
}
