import { useState } from 'react';

type RetryState = 'idle' | 'sent' | 'failed';

export default function NotificationRetry({
  jobId,
  eventId,
  label = 'Retry email',
  onDone,
}: {
  jobId: string;
  eventId?: number;
  label?: string;
  onDone?: (sent: boolean) => void;
}) {
  const [busy, setBusy] = useState(false), [state, setState] = useState<RetryState>('idle');

  async function retry() {
    setBusy(true); setState('idle');
    try {
      const response = await fetch(`/api/jobs/${jobId}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventId === undefined ? {} : { eventId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not resend the notification email.');
      setState(result.sent ? 'sent' : 'failed');
      onDone?.(Boolean(result.sent));
    } catch {
      setState('failed');
      onDone?.(false);
    } finally { setBusy(false); }
  }

  return (
    <span className="notification-retry">
      <button type="button" className="text-button" onClick={retry} disabled={busy || state === 'sent'}>
        {busy ? 'Sending…' : state === 'sent' ? 'Email sent' : label}
      </button>
      {state === 'failed' && <span className="small muted"> — still failing; contact the submitter directly.</span>}
    </span>
  );
}

export function BatchNotificationRetry({
  ids,
  label = 'Retry failed emails',
  onDone,
}: {
  ids: string[];
  label?: string;
  onDone?: (allSent: boolean) => void;
}) {
  const [busy, setBusy] = useState(false), [state, setState] = useState<RetryState>('idle');

  async function retry() {
    setBusy(true); setState('idle');
    try {
      const response = await fetch('/api/jobs/batch-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not resend the notification emails.');
      const allSent = Array.isArray(result.notified) && result.notified.length > 0 && result.notified.every((n: { sent: boolean }) => n.sent);
      setState(allSent ? 'sent' : 'failed');
      onDone?.(allSent);
    } catch {
      setState('failed');
      onDone?.(false);
    } finally { setBusy(false); }
  }

  if (!ids.length) return null;
  return (
    <span className="notification-retry">
      {' '}<button type="button" className="text-button" onClick={retry} disabled={busy || state === 'sent'}>
        {busy ? 'Sending…' : state === 'sent' ? 'Emails sent' : label}
      </button>
      {state === 'failed' && <span className="small muted"> — some emails still failing; contact those submitters directly.</span>}
    </span>
  );
}
