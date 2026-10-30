import { describe, it, expect } from 'vitest';
import { sourceSite, sourceUrlInput } from './source-url';

describe('sourceUrlInput', () => {
  it('treats an empty box as no link', () => {
    expect(sourceUrlInput('   ')).toEqual({ url: null });
  });

  it('keeps an http or https link as typed', () => {
    expect(sourceUrlInput(' https://www.delish.com/osso-buco ')).toEqual({
      url: 'https://www.delish.com/osso-buco',
    });
    expect(sourceUrlInput('http://example.com/a')).toEqual({ url: 'http://example.com/a' });
  });

  it('reads a bare address as https', () => {
    expect(sourceUrlInput('kingarthurbaking.com/recipes/pizza')).toEqual({
      url: 'https://kingarthurbaking.com/recipes/pizza',
    });
  });

  it('refuses other schemes and things that are not addresses', () => {
    expect(sourceUrlInput('javascript:alert(1)')).toBe('invalid');
    expect(sourceUrlInput('ftp://example.com/x')).toBe('invalid');
    expect(sourceUrlInput('Joy of Cooking p. 212')).toBe('invalid');
    expect(sourceUrlInput('grandma')).toBe('invalid');
  });
});

describe('sourceSite', () => {
  it('names the site without www', () => {
    expect(sourceSite('https://www.budgetbytes.com/oven-fajitas/')).toEqual({
      href: 'https://www.budgetbytes.com/oven-fajitas/',
      site: 'budgetbytes.com',
    });
  });

  it('renders nothing for a scheme that could run script', () => {
    expect(sourceSite('javascript:alert(1)')).toBeNull();
    expect(sourceSite(null)).toBeNull();
  });
});
