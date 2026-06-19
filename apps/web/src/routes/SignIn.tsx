import { useState } from 'react';
import { authClient } from '../lib/auth';

// Minimal combined sign-in / create-account. A fresh self-host install has no users,
// so create-account must be reachable from the first screen (non-technical-first).
export function SignIn() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res =
      mode === 'signin'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: email });
    if (res.error) setError(res.error.message ?? 'Failed');
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '60px auto', display: 'grid', gap: 10 }}>
      <h1>{mode === 'signin' ? 'Sign in to Hearth' : 'Create your Hearth account'}</h1>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit">{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      <button
        type="button"
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        style={{ background: 'none', border: 'none', color: 'var(--color-accent-soft-text)' }}
      >
        {mode === 'signin' ? 'Create an account' : 'Have an account? Sign in'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
