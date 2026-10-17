import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { invariant } from './errors';

export type Purpose = 'upload' | 'confirm';
function secret() {
  const value = process.env.CONFIRMATION_SECRET ?? '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Set CONFIRMATION_SECRET to 32 random bytes encoded as 64 hex characters');
  return Buffer.from(value, 'hex');
}
export function seal(id: string, purpose: Purpose, expires: number) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), nonce);
  cipher.setAAD(Buffer.from('printhive:v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ v: 1, id, purpose, expires })), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function unseal(token: string, purpose: Purpose, now = Date.now()): { id: string; expires: number } {
  const key = secret();
  let payload: any;
  try {
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from('printhive:v1'));
    cipher.setAuthTag(bytes.subarray(12, 28));
    payload = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    if (payload.v !== 1 || payload.purpose !== purpose || !/^[a-f0-9-]{36}$/.test(payload.id) || !Number.isSafeInteger(payload.expires)) throw new Error();
  } catch { invariant(false, 400, 'This link is invalid. Please submit your print again.'); }
  invariant(payload.expires > now, 410, 'This link has expired. Please submit your print again.');
  return payload;
}
