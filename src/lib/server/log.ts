import { HttpError } from './errors';

type Details = Record<string, string | number | boolean | undefined>;

// Log diagnostics, never entire requests, mail messages, SQL parameters, or jobs.
// SMTP servers can echo credentials/addresses in error messages, so scrub those too.
function redact(value: string): string {
  const username = process.env.SMTP_USERNAME ?? '';
  const password = process.env.SMTP_PASSWORD ?? '';
  const secrets = [password, username, process.env.CONFIRMATION_SECRET ?? ''];
  if (password) secrets.push(Buffer.from(password).toString('base64'));
  if (username) secrets.push(Buffer.from(username).toString('base64'));
  if (password && username) secrets.push(Buffer.from(`\0${username}\0${password}`).toString('base64'));
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '[redacted]');
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        url.username = ''; url.password = '';
        return url.origin + url.pathname + (url.search ? '?[redacted]' : '');
      } catch { return '[redacted URL]'; }
    })
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, '[redacted email]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted authorization]')
    .replace(/\b[A-Za-z0-9_-]{64,}\b/g, '[redacted token]')
    .slice(0, 12000);
}

function errorDetails(error: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (depth > 4 || seen.has(error)) return '[nested error omitted]';
  if (typeof error === 'string') return { message: redact(error) };
  if (!error || typeof error !== 'object') return { type: typeof error };
  seen.add(error);
  const source = error as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  // Do not enumerate arbitrary error properties: Nodemailer may attach envelopes,
  // and database errors may attach SQL bindings containing private submission data.
  for (const field of ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'address', 'port', 'responseCode', 'response']) {
    const value = source[field];
    if (typeof value === 'string') result[field] = redact(value);
    else if (typeof value === 'number') result[field] = value;
  }
  if (typeof source.command === 'string') {
    // Include the SMTP stage, but never an AUTH payload or MAIL/RCPT address.
    result.command = source.command.split(/\s+/)[0].slice(0, 32);
  }
  if (source.cause !== undefined) result.cause = errorDetails(source.cause, seen, depth + 1);
  if (error instanceof AggregateError) result.errors = error.errors.slice(0, 5).map(e => errorDetails(e, seen, depth + 1));
  return result;
}

function write(level: 'warn' | 'error', event: string, error: unknown, details: Details) {
  try {
    const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]));
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeDetails, error: errorDetails(error) });
    if (level === 'error') console.error(line); else console.warn(line);
  } catch {
    // A malformed error object must never interrupt error handling itself.
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'logging.failed', operation: event }));
  }
}

export function logError(event: string, error: unknown, details: Details = {}) { write('error', event, error, details); }
export function logWarning(event: string, error: unknown, details: Details = {}) { write('warn', event, error, details); }
export function logFailure(event: string, error: unknown, details: Details = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  write(status < 500 ? 'warn' : 'error', event, error, { ...details, status });
}

// Operational CLIs need the same diagnostics instead of Bun's raw error rendering,
// which can print unsanitized messages and source snippets on uncaught exceptions.
export async function runCommand(operation: string, action: () => Promise<void>) {
  try { await action(); }
  catch (error) { logError(`${operation}.failed`, error); process.exitCode = 1; }
}
