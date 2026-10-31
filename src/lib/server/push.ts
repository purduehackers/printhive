import { randomUUID } from 'node:crypto';
import type { APIContext } from 'astro';
import webPush from 'web-push';
import { db, type DatabaseQueries } from './db';
import { config, pushConfig } from './config';
import { invariant } from './errors';
import { logError, logWarning } from './log';
import { thumbnailURL } from './thumbnails';

const DEVICE_COOKIE = 'printhive_push_device';
const EVENT_TTL = 60 * 60 * 1000;
type CookieContext = Pick<APIContext, 'cookies'>;
interface Subscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushMessage { eventId: string; title: string; body: string; url: string; thumbnail?: string }
type Sender = (subscription: Subscription, message: PushMessage, ttl: number) => Promise<void>;

export function validateSubscription(input: unknown): Subscription {
  invariant(input && typeof input === 'object', 400, 'Invalid push subscription.');
  const { endpoint, keys } = input as Partial<Subscription>;
  invariant(typeof endpoint === 'string' && endpoint.length <= 4096, 400, 'Invalid push endpoint.');
  let url: URL;
  try { url = new URL(endpoint); } catch { invariant(false, 400, 'Invalid push endpoint.'); }
  const host = url!.hostname;
  // Only browser-owned push services may receive server-side requests.
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(host) ||
    /^[a-z0-9.-]+\.notify\.windows\.com$/.test(host);
  invariant(allowed && url!.protocol === 'https:' && !url!.username && !url!.password &&
    (!url!.port || url!.port === '443') && !url!.hash && url!.pathname !== '/', 400, 'This browser push service is not supported.');
  invariant(keys && typeof keys.p256dh === 'string' && /^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) &&
    Buffer.from(keys.p256dh, 'base64url')[0] === 4 && typeof keys.auth === 'string' && /^[A-Za-z0-9_-]{22}$/.test(keys.auth),
    400, 'Invalid push encryption keys.');
  try { webPush.encrypt(keys.p256dh, keys.auth, 'validation', 'aes128gcm'); }
  catch { invariant(false, 400, 'Invalid push encryption keys.'); }
  return { endpoint, keys };
}

export async function pushStatus(context: CookieContext, operatorId: number) {
  const settings = pushConfig(), sql = await db();
  const [subscription] = await sql`SELECT endpoint FROM push_subscriptions
    WHERE id = ${context.cookies.get(DEVICE_COOKIE)?.value ?? ''} AND operator_id = ${operatorId}`;
  return { configured: Boolean(settings), publicKey: settings?.publicKey ?? null,
    enabled: Boolean(subscription), endpoint: subscription?.endpoint ?? null };
}

export async function subscribeDevice(context: CookieContext, operatorId: number, input: unknown) {
  invariant(pushConfig(), 503, 'Notifications need server setup. Please contact the administrator.');
  const subscription = validateSubscription(input), sql = await db(), id = randomUUID();
  const previous = context.cookies.get(DEVICE_COOKIE)?.value ?? '';
  await sql.begin(async tx => {
    invariant((await tx`SELECT id FROM operators WHERE id = ${operatorId} AND active = 1`).length, 401, 'Please log in as an operator.');
    await tx`DELETE FROM push_subscriptions WHERE id = ${previous} OR endpoint = ${subscription.endpoint}`;
    await tx`INSERT INTO push_subscriptions (id, operator_id, endpoint, p256dh, auth, created_at)
      VALUES (${id}, ${operatorId}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, ${Date.now()})`;
  });
  context.cookies.set(DEVICE_COOKIE, id, { httpOnly: true, secure: config().production, sameSite: 'strict', path: '/', maxAge: 365 * 86400 });
  return { enabled: true };
}

export async function revokeDevice(context: CookieContext, keepOperatorId?: number) {
  const id = context.cookies.get(DEVICE_COOKIE)?.value;
  if (!id) return;
  const sql = await db();
  await sql.begin(async tx => {
    if (keepOperatorId !== undefined) await tx`DELETE FROM push_subscriptions WHERE id = ${id} AND operator_id != ${keepOperatorId}`;
    else await tx`DELETE FROM push_subscriptions WHERE id = ${id}`;
  });
  if (keepOperatorId === undefined) context.cookies.delete(DEVICE_COOKIE, { path: '/' });
}

// Called within the same transaction that first confirms these jobs. Recipients are
// snapshotted now so newly enabled devices do not receive the old queue backlog.
export async function recordQueuePush(tx: DatabaseQueries, jobIds: string[], now: number) {
  if (!jobIds.length) return;
  const id = randomUUID();
  const [job] = await tx`SELECT title, batch_title, email FROM jobs WHERE id = ${jobIds[0]}`;
  invariant(job, 404, 'Print not found.');
  // Save the submitted details with the event so retries retain the same alert.
  const title = job.batch_title || job.title;
  await tx`INSERT INTO push_events (id, print_count, created_at, expires_at, submission_title, submitter_email)
    VALUES (${id}, ${jobIds.length}, ${now}, ${now + EVENT_TTL}, ${title}, ${job.email})`;
  for (const jobId of jobIds) await tx`INSERT INTO push_event_jobs (job_id, event_id) VALUES (${jobId}, ${id})`;
  await tx`INSERT INTO push_deliveries (event_id, subscription_id, next_attempt_at)
    SELECT ${id}, s.id, ${now} FROM push_subscriptions s JOIN operators o ON o.id = s.operator_id WHERE o.active = 1`;
}

export class PushDeliveryError extends Error {
  constructor(public status: number, public retryAfterMs = 0) { super(`Push service returned HTTP ${status}.`); }
}

export const sendPush: Sender = async (subscription, message, ttl) => {
  const settings = pushConfig();
  invariant(settings, 503, 'Notifications are not configured.');
  validateSubscription(subscription);
  const request = webPush.generateRequestDetails(subscription, JSON.stringify(message), {
    vapidDetails: settings, TTL: ttl, urgency: 'normal', contentEncoding: 'aes128gcm',
  });
  const response = await fetch(request.endpoint, { method: request.method, headers: request.headers,
    body: new Uint8Array(request.body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  // Do not include provider bodies or capability URLs in logs.
  await response.body?.cancel();
  if (!response.ok) {
    const retry = response.headers.get('retry-after') ?? '';
    const retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
    throw new PushDeliveryError(response.status, Math.min(retryAfterMs, EVENT_TTL));
  }
};

export async function testDevice(context: CookieContext, operatorId: number, sender: Sender = sendPush) {
  const sql = await db();
  const [row] = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions
    WHERE id = ${context.cookies.get(DEVICE_COOKIE)?.value ?? ''} AND operator_id = ${operatorId}`;
  invariant(row, 409, 'Enable notifications first.');
  const [artwork] = await sql`SELECT id FROM jobs WHERE confirmed_at IS NOT NULL AND has_thumbnail = 1 ORDER BY created_at DESC LIMIT 1`;
  try {
    await sender({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, {
      eventId: randomUUID(), title: 'PrintHive notifications enabled', body: 'This device can receive new print alerts.', url: '/operator',
      ...(artwork ? { thumbnail: thumbnailURL(artwork.id) } : {}),
    }, 60);
  } catch (error) {
    if (error instanceof PushDeliveryError && [404, 410].includes(error.status)) await revokeDevice(context);
    invariant(false, 502, 'The test could not be sent. Try enabling notifications again.');
  }
  return { accepted: true };
}

export async function dispatchPush(now = Date.now(), sender: Sender = sendPush) {
  const sql = await db();
  // Claim and expire deliveries together, after earlier queue transitions commit.
  const due: { event_id: string; subscription_id: string; attempts: number }[] = await sql.begin(async tx => {
    await tx`DELETE FROM push_events WHERE expires_at <= ${now}`;
    // Atomic leases protect against overlapping ticks and recover after a crash.
    return tx`UPDATE push_deliveries SET lease_until = ${now + 30000}, attempts = attempts + 1
    WHERE (event_id, subscription_id) IN (
      SELECT d.event_id, d.subscription_id FROM push_deliveries d JOIN push_events e ON e.id = d.event_id
      WHERE d.sent_at IS NULL AND d.failed_at IS NULL AND d.next_attempt_at <= ${now} AND d.lease_until <= ${now}
      AND e.expires_at > ${now} ORDER BY d.next_attempt_at LIMIT 4
    ) RETURNING event_id, subscription_id, attempts`;
  });
  await Promise.all(due.map(async delivery => {
    const [row] = await sql.begin(async tx => tx`SELECT s.endpoint, s.p256dh, s.auth, e.print_count, e.expires_at, e.submission_title, e.submitter_email,
      (SELECT j.id FROM push_event_jobs ej JOIN jobs j ON j.id = ej.job_id
        WHERE ej.event_id = e.id AND j.has_thumbnail = 1 ORDER BY j.created_at, j.id LIMIT 1) AS thumbnail_id
      FROM push_subscriptions s JOIN operators o ON o.id = s.operator_id
      JOIN push_events e ON e.id = ${delivery.event_id}
      WHERE s.id = ${delivery.subscription_id} AND o.active = 1 AND e.expires_at > ${Date.now()}`);
    if (!row) {
      await sql.begin(async tx => tx`UPDATE push_deliveries SET failed_at = ${now} WHERE event_id = ${delivery.event_id} AND subscription_id = ${delivery.subscription_id}`);
      return;
    }
    try {
      await sender({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, {
        eventId: delivery.event_id,
        title: row.submission_title,
        body: `${row.print_count} ${row.print_count === 1 ? 'file' : 'files'} · ${row.submitter_email}`, url: '/operator',
        ...(row.thumbnail_id ? { thumbnail: thumbnailURL(row.thumbnail_id) } : {}),
      }, Math.max(1, Math.ceil((row.expires_at - Date.now()) / 1000)));
      await sql.begin(async tx => tx`UPDATE push_deliveries SET sent_at = ${Date.now()}, lease_until = 0
        WHERE event_id = ${delivery.event_id} AND subscription_id = ${delivery.subscription_id}`);
    } catch (error) {
      const status = error instanceof PushDeliveryError ? error.status : 0;
      if ([404, 410].includes(status)) {
        await sql.begin(async tx => tx`DELETE FROM push_subscriptions WHERE id = ${delivery.subscription_id}`);
      } else {
        const permanent = status >= 400 && status < 500 && status !== 429;
        const delay = Math.max(Math.min(15000 * 2 ** Math.min(delivery.attempts - 1, 6), 900000),
          error instanceof PushDeliveryError ? error.retryAfterMs : 0);
        await sql.begin(async tx => tx`UPDATE push_deliveries SET lease_until = 0, next_attempt_at = ${now + delay}, failed_at = ${permanent ? now : null}
          WHERE event_id = ${delivery.event_id} AND subscription_id = ${delivery.subscription_id}`);
      }
      logWarning('push.delivery_failed', new Error(status ? `Push service returned HTTP ${status}.` : 'Push transport failed.'),
        { eventId: delivery.event_id, status, attempt: delivery.attempts });
    }
  }));
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
export function startPushDispatcher() {
  if (timer || !pushConfig()) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await dispatchPush(); } catch { logError('push.dispatch_failed', new Error('Push outbox processing failed.')); }
    finally { running = false; }
  };
  timer = setInterval(tick, 2000);
  timer.unref();
  void tick();
}
