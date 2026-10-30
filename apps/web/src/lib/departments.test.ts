import { describe, it, expect } from 'vitest';
import { DEPARTMENTS } from '@hearth/shared';
import { departmentKey, departmentStyle } from './departments';

describe('departmentKey', () => {
  it('gives every shared department its own key', () => {
    const keys = DEPARTMENTS.map(departmentKey);
    expect(new Set(keys).size).toBe(DEPARTMENTS.length);
    expect(keys).not.toContain('other');
  });

  it('files an unknown or missing department under other', () => {
    expect(departmentKey(null)).toBe('other');
    expect(departmentKey('Hardware')).toBe('other');
  });

  it('points the style at the department tokens', () => {
    expect(departmentStyle('Meat & Seafood')).toEqual({
      '--dept-bg': 'var(--dept-meat-bg)',
      '--dept-ink': 'var(--dept-meat-ink)',
    });
  });
});
