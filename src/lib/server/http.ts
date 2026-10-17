import type { APIContext } from 'astro';
import { config } from './config';
import { HttpError, invariant } from './errors';
import { logFailure } from './log';

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
export function errorResponse(error: unknown, request?: Request) {
  logFailure('http.request_failed', error, request ? { method: request.method, path: new URL(request.url).pathname } : {});
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  return json({ error: 'Something went wrong. Please try again later.' }, 500);
}
export async function smallBody(request: Request, jsonBody = true): Promise<any> {
  invariant(request.body, 400, 'Missing request body.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      invariant(size <= 32768, 413, 'Request is too large.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!jsonBody) return new URLSearchParams(text);
  invariant(request.headers.get('content-type')?.split(';')[0] === 'application/json', 415, 'Send JSON metadata.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export function checkOrigin(request: Request) {
  invariant(request.headers.get('origin') === config().origin, 403, 'This request must come from PrintHive. Reload the page and try again.');
}
const buckets = new Map<string, { count: number; expires: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.expires <= now) buckets.delete(k);
  let bucket = buckets.get(key);
  if (!bucket) {
    invariant(buckets.size < 10000, 429, 'Too many requests. Please try again later.');
    buckets.set(key, bucket = { count: 0, expires: now + windowMs });
  }
  invariant(++bucket.count <= max, 429, 'Too many attempts. Please try again later.');
}
export function clientIP(context: APIContext) {
  if (config().trustProxy) {
    const forwarded = context.request.headers.get('x-real-ip');
    if (forwarded && /^[a-fA-F0-9:.]{3,64}$/.test(forwarded)) return forwarded;
  }
  try { return context.clientAddress; } catch { return 'unknown'; }
}
