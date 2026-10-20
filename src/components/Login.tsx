import { useState, type SubmitEvent } from 'react';
export default function Login() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: data.get('username'), password: data.get('password') }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      location.assign('/operator');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not sign in.'); setBusy(false); }
  }
  return <form onSubmit={submit} className="login-form"><label>Username<input name="username" autoComplete="username" required maxLength={64} /></label><label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={1024} /></label>{error && <p className="notice error" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form>;
}
