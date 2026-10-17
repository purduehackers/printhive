import { useState, type SubmitEvent } from 'react';
import { transitions, type Status } from '../lib/shared';
export default function StatusControls({ id, status: initial, version: initialVersion }: { id: string; status: Status; version: number }) {
  const [status, setStatus] = useState(initial), [version, setVersion] = useState(initialVersion), [next, setNext] = useState(transitions[initial][0]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/jobs/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next, version }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setStatus(result.job.status); setVersion(result.job.version); setNext(transitions[result.job.status as Status][0]);
      setError(Boolean(result.warning)); setMessage(result.warning || 'Status saved and notification email accepted for delivery.');
    } catch (e) { setError(true); setMessage(e instanceof Error ? e.message : 'Could not update status.'); }
    finally { setBusy(false); }
  }
  return <section className="detail-card"><h2>Move this print along.</h2><p>Current status: <span className={`status ${status}`}>{status}</span></p><form onSubmit={submit}><label>New status<select value={next} onChange={e => setNext(e.target.value as Status)} disabled={busy}>{transitions[status].map(s => <option key={s} value={s}>{s === 'queued' ? 'Requeue at the end of the line' : s[0].toUpperCase() + s.slice(1)}</option>)}</select></label><p className="small muted">Saving sends an email to the submitter. Several jobs can be printing at once.</p><button className="button primary" disabled={busy}>{busy ? 'Saving and sending…' : 'Update status →'}</button></form>{message && <div className={`notice ${error ? 'error' : ''}`} role="status">{message} <a href={`/operator/jobs/${id}`}>Refresh details</a></div>}</section>;
}
