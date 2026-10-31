import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { invariant } from './errors';

export type Purpose = 'upload' | 'confirm' | 'slicer-export' | 'thumbnail';
export const VERIFIED_EMAIL_COOKIE = 'printhive_verified_email';
export const VERIFIED_EMAIL_TTL = 30 * 24 * 60 * 60 * 1000;

function secret() {
  const value = process.env.CONFIRMATION_SECRET ?? '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Set CONFIRMATION_SECRET to 32 random bytes encoded as 64 hex characters');
  return Buffer.from(value, 'hex');
}
export function seal(id: string | string[], purpose: Purpose, expires: number) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), nonce);
  cipher.setAAD(Buffer.from('printhive:v1'));
  const payload = Array.isArray(id) ? { v: 1, id: id[0], ids: id, purpose, expires } : { v: 1, id, purpose, expires };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function unseal(token: string, purpose: Purpose, now = Date.now()): { id: string; ids: string[]; expires: number } {
  const key = secret();
  let payload: any;
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from('printhive:v1'));
    cipher.setAuthTag(bytes.subarray(12, 28));
    payload = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    const ids: string[] = Array.isArray(payload.ids) ? payload.ids : typeof payload.id === 'string' ? [payload.id] : [];
    if (payload.v !== 1 || payload.purpose !== purpose || ids.length === 0 || ids.length > 10 || !ids.every(i => typeof i === 'string' && /^[a-f0-9-]{36}$/.test(i)) || !Number.isSafeInteger(payload.expires)) throw new Error();
    payload.id = ids[0];
    payload.ids = ids;
  } catch { invariant(false, 400, 'This link is invalid. Please submit your print again.'); }
  invariant(payload.expires > now, 410, 'This link has expired. Please submit your print again.');
  return payload;
}

export function sealVerifiedEmail(email: string, expires = Date.now() + VERIFIED_EMAIL_TTL): string {
  const normalized = email.trim().toLowerCase();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), nonce);
  cipher.setAAD(Buffer.from('printhive:v1'));
  const payload = { v: 1, email: normalized, purpose: 'verified_email', expires };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function unsealVerifiedEmail(token: string | undefined | null, now = Date.now()): { email: string; expires: number } | null {
  if (!token || typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const key = secret();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length < 29) return null;
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from('printhive:v1'));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    if (
      payload?.v !== 1 ||
      payload?.purpose !== 'verified_email' ||
      typeof payload?.email !== 'string' ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@purdue\.edu$/.test(payload.email) ||
      payload.email.startsWith('.') ||
      payload.email.includes('..') ||
      payload.email.includes('.@') ||
      !Number.isSafeInteger(payload.expires) ||
      payload.expires <= now
    ) {
      return null;
    }
    return { email: payload.email, expires: payload.expires };
  } catch {
    return null;
  }
}

export function getVerifiedEmail(
  context: { cookies?: { get(name: string): { value: string } | undefined }; request?: Request },
  now = Date.now(),
): string | null {
  const headerToken = context.request?.headers.get('x-verified-email-token');
  if (headerToken) {
    const verified = unsealVerifiedEmail(headerToken, now);
    if (verified) return verified.email;
  }
  const cookieToken = context.cookies?.get(VERIFIED_EMAIL_COOKIE)?.value;
  if (cookieToken) {
    const verified = unsealVerifiedEmail(cookieToken, now);
    if (verified) return verified.email;
  }
  return null;
}
