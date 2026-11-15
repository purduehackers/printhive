import type { APIContext } from 'astro';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config';
import { db, type DatabaseQueries } from './db';
import { HttpError, invariant } from './errors';
import { appOrigin, rateLimit } from './http';
import { sendMail, type Mailer } from './mail';
import { purdueEmail } from './validation';
import { revokeDevice } from './push';

export const MEMBER_COOKIE = 'printhive_member';
const LINK_TTL = 15 * 60 * 1000;
type Context = Pick<APIContext, 'cookies'>;
type Provider = 'hive' | 'purduehackers';
export interface Member {
  id: string;
  provider: Provider;
  subject: string;
  email: string | null;
  display_name?: string | null;
  organizer: number;
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('hex');
const isToken = (token: unknown): token is string => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);

export async function currentMember(context: Context): Promise<Member | null> {
  const token = context.cookies.get(MEMBER_COOKIE)?.value;
  if (!isToken(token)) return null;
  const sql = await db();
  const [member] = await sql<Member[]>`SELECT m.id, s.provider, s.subject, s.organizer,
    COALESCE(CASE WHEN s.provider = 'purduehackers' THEN i.verified_email END, m.contact_email) AS email, i.display_name
    FROM member_sessions s JOIN member_identities i USING (provider, subject)
    JOIN members m ON m.id = i.member_id
    WHERE s.token_hash = ${digest(token)} AND s.expires_at > ${Date.now()}
      AND (s.provider = 'purduehackers' OR EXISTS (SELECT 1 FROM hive_whitelist w WHERE w.email = s.subject))`;
  return member ?? null;
}

export async function requireMember(context: Context) {
  const member = await currentMember(context);
  invariant(member, 401, 'Sign in to PrintHive first.');
  return member;
}

async function claimEmail(tx: DatabaseQueries, memberId: string, email: string) {
  await tx`INSERT INTO member_emails (email, member_id) VALUES (${email}, ${memberId}) ON CONFLICT(email) DO NOTHING`;
  const [owner] = await tx`SELECT member_id FROM member_emails WHERE email = ${email}`;
  if (owner.member_id !== memberId) return;
  await tx`UPDATE members SET contact_email = COALESCE(contact_email, ${email}) WHERE id = ${memberId}`;
  await tx`UPDATE jobs SET member_id = ${memberId}
    WHERE member_id IS NULL AND confirmed_at IS NOT NULL AND lower(trim(email)) = ${email}`;
}

async function identity(tx: DatabaseQueries, provider: Provider, subject: string, email: string | null): Promise<string> {
  const [existing] = await tx`SELECT member_id FROM member_identities WHERE provider = ${provider} AND subject = ${subject}`;
  let memberId = existing?.member_id as string | undefined;
  if (!memberId && email) {
    const [emailOwner] = await tx`SELECT member_id FROM member_emails WHERE email = ${email}
      AND (${provider} = 'hive' OR NOT EXISTS (SELECT 1 FROM member_identities
        WHERE member_id = member_emails.member_id AND provider = 'purduehackers'))`;
    memberId = emailOwner?.member_id;
  }
  if (!memberId) {
    memberId = randomUUID();
    await tx`INSERT INTO members (id) VALUES (${memberId})`;
  }
  if (!existing) await tx`INSERT INTO member_identities (provider, subject, member_id) VALUES (${provider}, ${subject}, ${memberId})`;
  if (email) await claimEmail(tx, memberId, email);
  return memberId;
}

async function saveSession(tx: DatabaseQueries, context: Context, provider: Provider, subject: string, organizer = false) {
  const previous = context.cookies.get(MEMBER_COOKIE)?.value;
  if (isToken(previous)) await tx`DELETE FROM member_sessions WHERE token_hash = ${digest(previous)}`;
  const token = newToken(), expires = Date.now() + config().sessionTTL;
  await tx`INSERT INTO member_sessions (token_hash, provider, subject, organizer, expires_at)
    VALUES (${digest(token)}, ${provider}, ${subject}, ${Number(organizer)}, ${expires})`;
  return { token, expires };
}

function setSession(context: Context, session: { token: string; expires: number }) {
  context.cookies.set(MEMBER_COOKIE, session.token, {
    path: '/', httpOnly: true, secure: config().production, sameSite: 'lax', expires: new Date(session.expires),
  });
}

export async function signInWithId(context: Context, subject: string, verifiedEmail: string | null, organizer: boolean, displayName?: string) {
  const sql = await db();
  const session = await sql.begin(async tx => {
    await identity(tx, 'purduehackers', subject, verifiedEmail);
    await tx`UPDATE member_identities SET verified_email = ${verifiedEmail}
      WHERE provider = 'purduehackers' AND subject = ${subject}`;
    if (displayName) await tx`UPDATE member_identities SET display_name = ${displayName}
      WHERE provider = 'purduehackers' AND subject = ${subject}`;
    if (organizer) {
      // Keep operator IDs as the audit and push subscription identities.
      const username = 'id-' + digest(subject).slice(0, 32);
      await tx`INSERT INTO operators (username, password_hash, id_subject) VALUES (${username}, '', ${subject})
        ON CONFLICT(id_subject) DO UPDATE SET active = 1`;
    } else {
      await tx`UPDATE operators SET active = 0 WHERE id_subject = ${subject}`;
      await tx`UPDATE member_sessions SET organizer = 0 WHERE provider = 'purduehackers' AND subject = ${subject}`;
      await tx`DELETE FROM push_subscriptions WHERE operator_id IN (SELECT id FROM operators WHERE id_subject = ${subject})`;
    }
    return saveSession(tx, context, 'purduehackers', subject, organizer);
  });
  const [operator] = organizer ? await sql`SELECT id FROM operators WHERE id_subject = ${subject}` : [];
  await revokeDevice(context, operator?.id);
  setSession(context, session);
}

export async function signOutMember(context: Context) {
  const token = context.cookies.get(MEMBER_COOKIE)?.value;
  if (isToken(token)) await (await db())`DELETE FROM member_sessions WHERE token_hash = ${digest(token)}`;
  context.cookies.delete(MEMBER_COOKIE, { path: '/' });
}

export function hiveSignInDestination(next: unknown) {
  return next === '/submit' || next === '/' ? next : '/manage-prints';
}

export async function sendMemberLink(context: APIContext, rawEmail: unknown, member: Member | null, mailer: Mailer = sendMail, next?: string) {
  const email = purdueEmail(rawEmail);
  invariant(email, 400, 'Enter a valid @purdue.edu email address.');
  rateLimit('member-link-email:' + email, 4, LINK_TTL);
  const sql = await db();
  if (!member && !(await sql`SELECT email FROM hive_whitelist WHERE email = ${email}`).length) return;
  const token = newToken();
  await sql`INSERT INTO member_links (token_hash, email, member_id, expires_at)
    VALUES (${digest(token)}, ${email}, ${member?.id ?? null}, ${Date.now() + LINK_TTL})`;
  const link = new URL('/sign-in/email', appOrigin(context.request));
  link.searchParams.set('token', token);
  if (!member && next) link.searchParams.set('next', hiveSignInDestination(next));
  try {
    await mailer({
      to: email,
      subject: member ? 'Link your email to PrintHive' : 'Sign in to PrintHive',
      text: `Open this link to ${member ? 'link your email' : 'sign in'} within 15 minutes:\n${link.href}\n\nIf you did not request this, ignore this email.`,
    });
  } catch (cause) {
    await sql`DELETE FROM member_links WHERE token_hash = ${digest(token)}`;
    throw new HttpError(502, 'PrintHive could not send the email. Try again shortly.', { cause });
  }
}

export async function redeemMemberLink(context: Context, token: unknown, member: Member | null) {
  invariant(isToken(token), 400, 'This link is invalid.');
  const sql = await db();
  const session = await sql.begin(async tx => {
    const [link] = await tx`DELETE FROM member_links WHERE token_hash = ${digest(token)}
      AND expires_at > ${Date.now()} RETURNING email, member_id`;
    invariant(link, 410, 'This link has expired or was already used.');
    if (!link.member_id) {
      invariant((await tx`SELECT email FROM hive_whitelist WHERE email = ${link.email}`).length, 403,
        'This email no longer has HIVE sign-in access.');
      await identity(tx, 'hive', link.email, link.email);
      return saveSession(tx, context, 'hive', link.email);
    }
    invariant(member && member.id === link.member_id, 403, 'Open this link while signed in to the account that requested it.');
    const [owner] = await tx`SELECT member_id FROM member_emails WHERE email = ${link.email}`;
    if (owner && owner.member_id !== member.id) {
      invariant(member.provider === 'purduehackers' &&
        !(await tx`SELECT 1 FROM member_identities WHERE member_id = ${owner.member_id} AND provider = 'purduehackers'`).length,
        409, 'That email belongs to another Purdue Hackers ID account. Ask an organizer to link a specific print.');
      await tx`UPDATE member_identities SET member_id = ${member.id} WHERE member_id = ${owner.member_id}`;
      await tx`UPDATE member_emails SET member_id = ${member.id} WHERE member_id = ${owner.member_id}`;
      await tx`UPDATE jobs SET member_id = ${member.id} WHERE member_id = ${owner.member_id}`;
      await tx`DELETE FROM member_links WHERE member_id = ${owner.member_id}`;
      await tx`DELETE FROM members WHERE id = ${owner.member_id}`;
    }
    await claimEmail(tx, member.id, link.email);
    return null;
  });
  if (session) {
    await revokeDevice(context);
    setSession(context, session);
  }
  return session ? 'signed-in' : 'linked';
}

export async function previewMemberLink(token: unknown): Promise<{ email: string; member_id: string | null } | null> {
  if (!isToken(token)) return null;
  const [link] = await (await db())`SELECT email, member_id FROM member_links
    WHERE token_hash = ${digest(token)} AND expires_at > ${Date.now()}`;
  return link ?? null;
}
