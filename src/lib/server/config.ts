import { resolve } from 'node:path';
import { createECDH } from 'node:crypto';

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? '';
  const subject = process.env.VAPID_SUBJECT ?? '';
  if (!publicKey && !privateKey && !subject) return null;
  try {
    if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error();
    const key = createECDH('prime256v1');
    key.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (key.getPublicKey().toString('base64url') !== publicKey) throw new Error();
    const contact = new URL(subject);
    if (!(contact.protocol === 'mailto:' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.pathname)) &&
        !(contact.protocol === 'https:' && contact.hostname.includes('.') && !contact.username && !contact.password)) throw new Error();
  } catch { throw new Error('Set matching VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY plus a valid VAPID_SUBJECT contact URI, or leave all three unset.'); }
  return { publicKey, privateKey, subject };
}

function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
export function config() {
  const production = process.env.NODE_ENV === 'production';
  const origin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:4321').origin;
  if (production && !origin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production');
  return {
    production, origin, dataDir: resolve(process.env.DATA_DIR ?? './data'),
    maxUploads: positive('MAX_CONCURRENT_UPLOADS', 2),
    uploadTTL: positive('UPLOAD_TTL_SECONDS', 1800) * 1000,
    trustProxy: process.env.TRUST_PROXY === 'true',
    sessionTTL: 12 * 60 * 60 * 1000,
  };
}
