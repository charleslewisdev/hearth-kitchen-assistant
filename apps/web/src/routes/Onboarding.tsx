import { useState } from 'react';
import { authClient } from '../lib/auth';
import { slugify } from '@hearth/shared';

// Shown when a user is signed in but has no active household. Creating the org and
// setting it active is what makes protectedProcedure stop returning FORBIDDEN.
export function Onboarding() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const created = await authClient.organization.create({ name, slug: slugify(name) || 'home' });
    if (created.error) return setError(created.error.message ?? 'Could not create household');
    const activated = await authClient.organization.setActive({
      organizationId: created.data.id,
    });
    if (activated.error) setError(activated.error.message ?? 'Could not activate household');
    // useActiveOrganization() in App re-renders into the app shell on success.
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '60px auto', display: 'grid', gap: 10 }}>
      <h1>Name your household</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        Everything in Hearth — recipes, plans, lists — lives in a household.
      </p>
      <input
        placeholder="e.g. The Smith Kitchen"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={!name}>
        Create household
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
