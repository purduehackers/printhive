import { useState, type SubmitEvent } from 'react';
import { MAX_FEEDBACK_LENGTH, transitions, type Status } from '../lib/shared';

interface GroupMember {
  id: string;
  title: string;
  status: Status;
  version: number;
}

export default function StatusControls({
  id,
  status: initial,
  version: initialVersion,
  groupName,
  groupJobs: initialGroupJobs,
}: {
  id: string;
  status: Status;
  version: number;
  groupName?: string | null;
  groupJobs?: GroupMember[];
}) {
  const [status, setStatus] = useState(initial), [version, setVersion] = useState(initialVersion), [next, setNext] = useState(transitions[initial][0]);
  const [groupJobs, setGroupJobs] = useState<GroupMember[]>(initialGroupJobs ?? []);
  const [applyToGroup, setApplyToGroup] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false);
  const [feedback, setFeedback] = useState('');
  const returning = next === 'rejected';

  const eligibleGroupJobs = groupJobs.filter(j => transitions[j.status]?.includes(next) || j.status === next);
  const canApplyToGroup = groupJobs.length > 1 && eligibleGroupJobs.length > 1;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (applyToGroup && canApplyToGroup) {
        const response = await fetch('/api/jobs/batch-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: eligibleGroupJobs.map(j => ({ id: j.id, version: j.id === id ? version : j.version })),
            status: next,
            feedback: returning ? feedback : '',
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        const updatedList: GroupMember[] = Array.isArray(result.updated) ? result.updated : [];
        const updatedMap = new Map(updatedList.map(j => [j.id, j]));
        const selfUpdated = updatedMap.get(id);
        if (selfUpdated) {
          setStatus(selfUpdated.status);
          setVersion(selfUpdated.version);
          setNext(transitions[selfUpdated.status as Status][0]);
        }
        setGroupJobs(prev => prev.map(j => updatedMap.get(j.id) ?? j));
        setFeedback('');
        const hasWarnings = Array.isArray(result.warnings) && result.warnings.length > 0;
        const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;
        setError(hasWarnings || hasErrors);
        setMessage(
          hasWarnings
            ? result.warnings.join('; ')
            : `Updated ${updatedList.length} print(s) in group and sent consolidated notification email.`
        );
      } else {
        const response = await fetch(`/api/jobs/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next, version, feedback: returning ? feedback : '' }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setStatus(result.job.status); setVersion(result.job.version); setNext(transitions[result.job.status as Status][0]);
        setGroupJobs(prev => prev.map(j => j.id === id ? { ...j, status: result.job.status, version: result.job.version } : j));
        setFeedback('');
        setError(Boolean(result.warning)); setMessage(result.warning || 'Status saved and notification email accepted for delivery.');
      }
    } catch (e) { setError(true); setMessage(e instanceof Error ? e.message : 'Could not update status.'); }
    finally { setBusy(false); }
  }
  return <section className="detail-card">
    <h2>Update status</h2>
    <p>Current status: <span className={`status ${status}`}>{status}</span></p>
    <form onSubmit={submit}>
      <label>New status<select value={next} onChange={e => setNext(e.target.value as Status)} disabled={busy}>{transitions[status].map(s => <option key={s} value={s}>{s === 'queued' ? 'Requeue at the end of the line' : s === 'rejected' ? 'Reject and return with feedback' : s[0].toUpperCase() + s.slice(1)}</option>)}</select></label>
      {canApplyToGroup && (
        <label className="checkbox-label batch-apply-checkbox">
          <input
            type="checkbox"
            checked={applyToGroup}
            onChange={e => setApplyToGroup(e.target.checked)}
            disabled={busy}
          />
          <span>
            Apply to all {eligibleGroupJobs.length} prints in <strong>{groupName || 'this batch'}</strong> (sends 1 combined email)
          </span>
        </label>
      )}
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
