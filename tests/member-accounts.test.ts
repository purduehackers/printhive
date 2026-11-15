import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { APIContext } from 'astro';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentOperator } from '../src/lib/server/auth';
import { closeDb, db, migrate } from '../src/lib/server/db';
import { addHiveEmails, previewHiveEmails, removeHiveEmail } from '../src/lib/server/hive-whitelist';
import { currentMember, previewMemberLink, redeemMemberLink, sendMemberLink, signInWithId } from '../src/lib/server/member-auth';
import { assignLegacyPrint, changeMemberPrint, memberJobs } from '../src/lib/server/member-jobs';
import { reserve, updateStatus, upload } from '../src/lib/server/jobs';
import { asciiSTL, submission } from './fixtures';

let dir: string;
const origin = 'http://localhost:4321';
const noMail = async () => {};
const hiveEmail = 'hive-test@purdue.edu';
function browser() {
  const cookies = new Map<string, { value: string }>();
  return {
    request: new Request(origin + '/sign-in'),
    cookies: {
      get: (name: string) => cookies.get(name),
      set: (name: string, value: string) => cookies.set(name, { value }),
      delete: (name: string) => cookies.delete(name),
    },
  } as unknown as APIContext;
}

async function link(context: APIContext, email: string, member = null as Awaited<ReturnType<typeof currentMember>>) {
  let token = '';
  await sendMemberLink(context, email, member, async message => {
    token = /[?&]token=([a-f0-9]{64})/.exec(message.text)?.[1] ?? '';
  });
  return token;
}

async function queued(email: string, memberId?: string) {
  const account = { verifiedEmail: email, memberId };
  const print = await reserve(submission({ email }), account);
  const result = await upload(print.id, print.capability,
    new Request(origin, { method: 'PUT', body: asciiSTL }), noMail, account);
  expect(result.confirmed).toBe(true);
  return print.id;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-accounts-'));
  process.env.DATA_DIR = dir;
  process.env.APP_ORIGIN = origin;
  process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  await migrate();
});
afterAll(async () => {
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

test('HIVE import, single-use links, legacy ownership and whitelist removal', async () => {
  const text = `Email Address\r\n ${hiveEmail.toUpperCase()} \r\n${hiveEmail}\r\nwrong@example.org`;
  expect(await previewHiveEmails(text)).toEqual({ emails: [hiveEmail], duplicates: 1, invalid: ['wrong@example.org'] });
  expect(await link(browser(), hiveEmail)).toBe('');
  expect(await addHiveEmails(text)).toBe(1);
  expect(await addHiveEmails(text)).toBe(0);
  const print = await queued(hiveEmail);
  const context = browser(), token = await link(context, hiveEmail);
  expect(await previewMemberLink(token)).toMatchObject({ email: hiveEmail });
  expect(await currentMember(context)).toBeNull();
  await redeemMemberLink(context, token, null);
  const member = (await currentMember(context))!;
  expect((await memberJobs(member.id)).map(job => job.id)).toEqual([print]);
  await expect(redeemMemberLink(browser(), token, null)).rejects.toMatchObject({ status: 410 });
  const outstanding = await link(browser(), hiveEmail);
  await removeHiveEmail(hiveEmail);
  expect(await currentMember(context)).toBeNull();
  await expect(redeemMemberLink(browser(), outstanding, null)).rejects.toMatchObject({ status: 410 });
  expect(await memberJobs(member.id)).toHaveLength(1);
});

test('ID sign-in links verified emails and organizers can assign an unclaimed print', async () => {
  const context = browser(), organizerContext = browser(), wrongBrowser = browser();
  const email = 'id-test@purdue.edu', alternate = 'id-alt-test@purdue.edu';
  const original = await queued(email), second = await queued(alternate), manual = await queued('manual@purdue.edu');
  await signInWithId(context, 'ordinary-id-subject', email, false);
  const member = (await currentMember(context))!;
  expect((await memberJobs(member.id)).map(job => job.id)).toEqual([original]);
  expect(await currentOperator(context)).toBeNull();
  const token = await link(context, alternate, member);
  await expect(redeemMemberLink(wrongBrowser, token, null)).rejects.toMatchObject({ status: 403 });
  await redeemMemberLink(context, token, member);
  await signInWithId(organizerContext, 'organizer-id-subject', null, true);
  const operator = (await currentOperator(organizerContext))!;
  await assignLegacyPrint(manual, member.id, operator.id);
  await expect(assignLegacyPrint(original, member.id, operator.id)).rejects.toMatchObject({ status: 409 });
  expect(new Set((await memberJobs(member.id)).map(job => job.id))).toEqual(new Set([original, second, manual]));
  await signInWithId(browser(), 'organizer-id-subject', null, false);
  expect(await currentOperator(organizerContext)).toBeNull();
});

test('only the owner can edit or cancel, changes alert operators, and requeue retains the first-start lock', async () => {
  const context = browser(), organizerContext = browser();
  const email = 'settings-test@purdue.edu';
  await signInWithId(context, 'print-owner', email, false);
  await signInWithId(organizerContext, 'print-operator', null, true);
  const owner = (await currentMember(context))!;
  const operator = (await currentOperator(organizerContext))!;
  const id = await queued(email, owner.id);
  const [original] = await memberJobs(owner.id);
  await expect(changeMemberPrint('someone-else', id, original.version, 'cancellation')).rejects.toMatchObject({ status: 404 });
  await changeMemberPrint(owner.id, id, original.version, 'settings', { infill: 30, copies: 2 });
  const [edited] = await memberJobs(owner.id);
  expect(edited).toMatchObject({ infill: 30, copies: 2, queued_at: original.queued_at, version: original.version + 1 });
  await expect(updateStatus(id, 'printing', original.version, operator.id, { mailer: noMail })).rejects.toMatchObject({ status: 409 });
  await updateStatus(id, 'printing', edited.version, operator.id, { mailer: noMail });
  await updateStatus(id, 'failed', edited.version + 1, operator.id, { mailer: noMail });
  await updateStatus(id, 'queued', edited.version + 2, operator.id, { mailer: noMail });
  await expect(changeMemberPrint(owner.id, id, edited.version + 3, 'cancellation')).rejects.toMatchObject({ status: 409 });
  const canceled = await queued(email, owner.id);
  await changeMemberPrint(owner.id, canceled, 1, 'cancellation');
  const alerts = await (await db())`SELECT kind FROM push_events WHERE submitter_email = ${email} AND kind != 'submission' ORDER BY created_at`;
  expect(alerts).toEqual([{ kind: 'settings' }, { kind: 'cancellation' }]);
});

test('linking a HIVE email to an existing ID account consolidates prints without granting HIVE operator access', async () => {
  const hive = browser(), id = browser(), email = 'hive-link@purdue.edu';
  await addHiveEmails(email);
  await redeemMemberLink(hive, await link(hive, email), null);
  const hiveMember = (await currentMember(hive))!;
  const print = await queued(email, hiveMember.id);
  await signInWithId(id, 'linking-organizer', 'organizer-contact@purdue.edu', true);
  const idMember = (await currentMember(id))!;
  await redeemMemberLink(id, await link(id, email, idMember), idMember);
  expect((await currentMember(hive))?.id).toBe(idMember.id);
  expect((await memberJobs(idMember.id)).map(job => job.id)).toEqual([print]);
  expect(await currentOperator(hive)).toBeNull();
  expect(await currentOperator(id)).not.toBeNull();
});

test('ID submissions and status emails use the verified ID address even after linking a Purdue address', async () => {
  const context = browser(), organizerContext = browser();
  const personal = 'id-prints@example.net';
  const campus = 'id-campus-test@purdue.edu';
  await signInWithId(context, 'personal-email-member', campus, false);
  await signInWithId(context, 'personal-email-member', personal, false);
  const member = (await currentMember(context))!;
  expect(member.email).toBe(personal);
  expect(await previewHiveEmails(personal)).toMatchObject({ emails: [], invalid: [personal] });
  const id = await queued(member.email!, member.id);
  await changeMemberPrint(member.id, id, 1, 'settings', { infill: 30 });
  await signInWithId(organizerContext, 'personal-email-operator', null, true);
  const operator = (await currentOperator(organizerContext))!;
  const recipients: string[] = [];
  await updateStatus(id, 'printing', 2, operator.id, {
    mailer: async message => { recipients.push(message.to); },
  });
  expect(recipients).toEqual([personal]);
});
