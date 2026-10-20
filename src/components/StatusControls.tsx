import { useState, type SubmitEvent } from 'react';
import { MAX_FEEDBACK_LENGTH, transitions, type Status } from '../lib/shared';
export default function StatusControls({ id, status: initial, version: initialVersion }: { id: string; status: Status; version: number }) {
  const [status, setStatus] = useState(initial), [version, setVersion] = useState(initialVersion), [next, setNext] = useState(transitions[initial][0]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false);
  const [feedback, setFeedback] = useState('');
  const returning = next === 'rejected';
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/jobs/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next, version, feedback: returning ? feedback : '' }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setStatus(result.job.status); setVersion(result.job.version); setNext(transitions[result.job.status as Status][0]);
      setFeedback('');
      setError(Boolean(result.warning)); setMessage(result.warning || 'Status saved and notification email accepted for delivery.');
    } catch (e) { setError(true); setMessage(e instanceof Error ? e.message : 'Could not update status.'); }
    finally { setBusy(false); }
  }
  return <section className="detail-card">
    <h2>Update status</h2>
    <p>Current status: <span className={`status ${status}`}>{status}</span></p>
    <form onSubmit={submit}>
      <label>New status<select value={next} onChange={e => setNext(e.target.value as Status)} disabled={busy}>{transitions[status].map(s => <option key={s} value={s}>{s === 'queued' ? 'Requeue at the end of the line' : s === 'rejected' ? 'Reject and return with feedback' : s[0].toUpperCase() + s.slice(1)}</option>)}</select></label>
      {returning && <>
        <label>Feedback for submitter<textarea value={feedback} onChange={e => setFeedback(e.target.value)} required maxLength={MAX_FEEDBACK_LENGTH} rows={5} disabled={busy} aria-describedby="return-feedback-help" /></label>
        <p id="return-feedback-help" className="small muted">This removes the print from the active queue and emails your feedback to the submitter so they can submit a revised print.</p>
      </>}
      <p className="small muted">Saving sends an email to the submitter.</p>
      <button className="button primary" disabled={busy || (returning && !feedback.trim())}>{busy ? 'Saving and sending…' : returning ? 'Reject and return' : 'Update status'}</button>
    </form>
    {message && <div className={`notice ${error ? 'error' : ''}`} role="status">{message} <a href={`/operator/jobs/${id}`}>Refresh details</a></div>}
  </section>;
}
