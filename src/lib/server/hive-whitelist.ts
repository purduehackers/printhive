import { db } from './db';
import { invariant } from './errors';
import { purdueEmail } from './validation';

export async function listHiveEmails() {
  const rows = await (await db())<{ email: string }[]>`SELECT email FROM hive_whitelist ORDER BY email`;
  return rows.map(row => row.email);
}

export async function previewHiveEmails(raw: string) {
  const existing = new Set(await listHiveEmails());
  const emails: string[] = [], invalid: string[] = [];
  let duplicates = 0;
  for (const value of raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    if (/^(?:purdue\s+)?e-?mail(?:\s+address(?:es)?)?$/i.test(value)) continue;
    const email = purdueEmail(value);
    if (!email) invalid.push(value);
    else if (existing.has(email)) duplicates++;
    else {
      existing.add(email);
      emails.push(email);
    }
  }
  return { emails, invalid, duplicates };
}

export async function addHiveEmails(raw: string) {
  const { emails } = await previewHiveEmails(raw);
  return (await db()).begin(async tx => {
    let added = 0;
    for (const email of emails) {
      const rows = await tx`INSERT INTO hive_whitelist (email) VALUES (${email}) ON CONFLICT DO NOTHING RETURNING email`;
      added += rows.length;
    }
    return added;
  });
}

export async function removeHiveEmail(raw: string) {
  const email = purdueEmail(raw);
  invariant(email, 400, 'Enter a valid @purdue.edu email address.');
  await (await db()).begin(async tx => {
    await tx`DELETE FROM hive_whitelist WHERE email = ${email}`;
    await tx`DELETE FROM member_sessions WHERE provider = 'hive' AND subject = ${email}`;
    await tx`DELETE FROM member_links WHERE email = ${email} AND member_id IS NULL`;
  });
}
