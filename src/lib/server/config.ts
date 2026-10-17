import { resolve } from 'node:path';

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
