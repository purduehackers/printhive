import { useState, type SubmitEvent } from 'react';
import type { Operator } from '../lib/server/auth';

export default function OperatorManager({ initial, currentId }: { initial: Operator[]; currentId: number }) {
  const [operators, setOperators] = useState(initial);
  const [editing, setEditing] = useState<number | null>(null);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false);
  function reset() { setEditing(null); setUsername(''); setPassword(''); }
  async function request(path: string, method: string, body?: unknown) {
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 401) { location.assign('/operator/login'); throw new Error('Please sign in again.'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not update operator accounts.');
    return result;
  }
  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await request(editing === null ? '/api/operators' : `/api/operators/${editing}`, editing === null ? 'POST' : 'PATCH', { username, password });
      setPassword('');
      if (result.signInRequired) { location.assign('/operator/login'); return; }
      setOperators(current => [...current.filter(operator => operator.id !== result.operator.id), result.operator].sort((a, b) => a.username.localeCompare(b.username)));
      setError(false); setMessage(editing === null ? 'Operator added.' : 'Operator updated.'); reset();
    } catch (e) { setError(true); setMessage(e instanceof Error ? e.message : 'Could not save operator.'); }
    finally { setBusy(false); }
  }
  async function remove(operator: Operator) {
    if (!window.confirm(`Remove access for ${operator.username}?${operator.id === currentId ? ' You will be signed out.' : ''}`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await request(`/api/operators/${operator.id}`, 'DELETE');
      if (result.signInRequired) { location.assign('/operator/login'); return; }
      setOperators(current => current.filter(item => item.id !== operator.id));
      if (editing === operator.id) reset();
      setError(false); setMessage('Operator removed.');
    } catch (e) { setError(true); setMessage(e instanceof Error ? e.message : 'Could not remove operator.'); }
    finally { setBusy(false); }
  }
  return <>
    {message && <p className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p>}
    <div className="operator-management">
      <section aria-label="Operator accounts">
        <div className="table-wrap"><table><thead><tr><th>Username</th><th>Actions</th></tr></thead><tbody>
          {operators.map(operator => <tr key={operator.id}>
            <td>{operator.username}{operator.id === currentId && <span className="small muted"> (you)</span>}</td>
            <td><div className="operator-actions">
              <button type="button" className="text-button" disabled={busy} aria-label={`Edit ${operator.username}`} onClick={() => { setEditing(operator.id); setUsername(operator.username); setPassword(''); setMessage(''); }}>Edit</button>
              <button type="button" className="text-button remove-operator" disabled={busy || operators.length === 1} title={operators.length === 1 ? 'The last active operator cannot be removed.' : undefined} aria-label={`Remove ${operator.username}`} onClick={() => remove(operator)}>Remove</button>
            </div></td>
          </tr>)}
        </tbody></table></div>
        {operators.length === 1 && <p className="small muted">At least one operator must remain.</p>}
      </section>
      <section className="detail-card operator-editor">
        <h2>{editing === null ? 'Add operator' : 'Edit operator'}</h2>
        <form onSubmit={save}>
          <fieldset disabled={busy}>
            <label>Username<input name="username" value={username} onChange={e => setUsername(e.target.value)} required pattern="[a-zA-Z0-9_.\-]{1,64}" maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
            <label>{editing === null ? 'Password' : 'New password'}<input name="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required={editing === null} minLength={12} maxLength={1024} autoComplete="new-password" /></label>
            <p className="small muted">{editing === null ? '12–1024 characters. All operators can manage prints and accounts.' : 'Leave the password blank to keep it. A password reset signs this operator out of all sessions.'}</p>
            <div className="operator-actions"><button type="submit" className="button primary">{busy ? 'Saving…' : editing === null ? 'Add operator' : 'Save changes'}</button>{editing !== null && <button type="button" className="text-button" onClick={reset}>Cancel</button>}</div>
          </fieldset>
        </form>
      </section>
    </div>
  </>;
}
