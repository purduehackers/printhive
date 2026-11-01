import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { MAX_FEEDBACK_LENGTH, transitions, type Status } from '../lib/shared';

export default function PrintStatusSelect({ title, status, count, busy, onChange }: {
  title: string;
  status: Status;
  count: number;
  busy: boolean;
  onChange: (next: Status, feedback?: string) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [returning, setReturning] = useState(false), [feedback, setFeedback] = useState(''), [error, setError] = useState('');
  useEffect(() => { if (returning) dialog.current?.showModal(); }, [returning]);

  async function returnPrints(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!feedback.trim() || busy) return;
    if (await onChange('rejected', feedback.trim())) dialog.current?.close();
    else setError('Could not return the prints. Please try again.');
  }

  return <>
    <select className={`status status-control ${status}`} value={status} disabled={busy}
      aria-label={`Change status of ${title}`}
      title={count > 1 ? `Change status for ${count} selected prints` : 'Change status'}
      onChange={event => {
        const next = event.target.value as Status;
        if (next === 'rejected') { setFeedback(''); setError(''); setReturning(true); }
        else void onChange(next);
      }}>
      <option value={status}>{status}</option>
      {transitions[status].map(next => <option key={next} value={next}>
        {next === 'rejected' ? 'Reject and return…' : next === 'queued' ? 'Requeue' : next[0].toUpperCase() + next.slice(1)}
      </option>)}
    </select>
    <dialog ref={dialog} className="print-return-dialog" aria-labelledby={headingId} onClick={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClose={() => setReturning(false)} onCancel={event => { if (busy) event.preventDefault(); }}>
      <form onSubmit={returnPrints}>
        <h2 id={headingId}>Return {count === 1 ? 'print' : `${count} prints`}</h2>
        <label>Feedback for {count === 1 ? 'submitter' : 'submitters'}
          <textarea value={feedback} onChange={event => setFeedback(event.target.value)} required
            maxLength={MAX_FEEDBACK_LENGTH} rows={4} disabled={busy} autoFocus />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="print-return-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !feedback.trim()}>{busy ? 'Returning…' : 'Reject and return'}</button>
        </div>
      </form>
    </dialog>
  </>;
}
