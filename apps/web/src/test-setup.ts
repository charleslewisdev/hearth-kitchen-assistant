import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest globals are off, so RTL's auto-cleanup never registers — unmount manually
// between tests to avoid leaking rendered trees across cases.
afterEach(cleanup);

// jsdom does not implement matchMedia; ThemeProvider's 'system' mode needs it.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// jsdom does not implement scrolling and logs "Not implemented" on every call. Tests that care
// spy on it.
window.scrollTo = vi.fn() as typeof window.scrollTo;
