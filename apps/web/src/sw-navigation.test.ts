import { describe, it, expect } from 'vitest';
import { navigateFallbackDenylist } from './lib/sw-navigation';

const skipped = (path: string) => navigateFallbackDenylist.some((pattern) => pattern.test(path));

describe('service worker navigation fallback', () => {
  it('leaves server routes opened from a link to the network', () => {
    expect(skipped('/api/auth/verify-email')).toBe(true);
    expect(skipped('/trpc/recipes.list')).toBe(true);
    expect(skipped('/health')).toBe(true);
  });

  it('still serves the app shell for app routes', () => {
    for (const path of ['/', '/recipes', '/recipes/api-cake', '/healthy-meals', '/apiary']) {
      expect(skipped(path)).toBe(false);
    }
  });
});
