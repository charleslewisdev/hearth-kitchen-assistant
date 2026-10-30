import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepFailedImport, MAX_KEPT } from './import-failures';

describe('keeping a failed import', () => {
  it('stores the pages as sent and what failed, without anything read off them', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hearth-failures-'));
    const id = await keepFailedImport(
      'hh_1',
      { kind: 'image', reason: 'no-recipe', files: [new Uint8Array([1, 2]), new Uint8Array([3])] },
      new Date('2026-09-27T20:00:00Z'),
      data,
    );
    const dir = join(data, 'import-failures', 'hh_1', id);
    expect(readdirSync(dir).sort()).toEqual(['meta.json', 'page-1.jpg', 'page-2.jpg']);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual({
      kind: 'image',
      reason: 'no-recipe',
      pages: 2,
      at: '2026-09-27T20:00:00.000Z',
    });
  });

  it('keeps what was read off the page beside it, when there was text and no recipe', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hearth-failures-'));
    const id = await keepFailedImport(
      'hh_1',
      {
        kind: 'pdf',
        reason: 'no-recipe',
        files: [new Uint8Array([1])],
        text: 'A page about weather.',
      },
      new Date('2026-09-27T20:00:00Z'),
      data,
    );
    const dir = join(data, 'import-failures', 'hh_1', id);
    expect(readdirSync(dir).sort()).toEqual(['meta.json', 'page-1.pdf', 'text.txt']);
    expect(readFileSync(join(dir, 'text.txt'), 'utf8')).toBe('A page about weather.');
    // meta.json still holds nothing read off the page.
    expect(readFileSync(join(dir, 'meta.json'), 'utf8')).not.toContain('weather');
  });

  it('writes no text.txt when nothing was read off the page', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hearth-failures-'));
    const id = await keepFailedImport(
      'hh_1',
      { kind: 'image', reason: 'no-recipe', files: [new Uint8Array([1])], text: '  \n' },
      new Date('2026-09-27T20:00:00Z'),
      data,
    );
    expect(readdirSync(join(data, 'import-failures', 'hh_1', id)).sort()).toEqual([
      'meta.json',
      'page-1.jpg',
    ]);
  });

  it('keeps only the newest failures per household', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hearth-failures-'));
    const ids: string[] = [];
    for (let i = 0; i < MAX_KEPT + 2; i++) {
      ids.push(
        await keepFailedImport(
          'hh_1',
          { kind: 'pdf', reason: 'malformed', files: [new Uint8Array([1])] },
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          data,
        ),
      );
    }
    const kept = readdirSync(join(data, 'import-failures', 'hh_1')).sort();
    expect(kept).toHaveLength(MAX_KEPT);
    expect(kept).not.toContain(ids[0]);
    expect(kept).toContain(ids[ids.length - 1]);
  });

  it('refuses a household id that could leave its folder', async () => {
    await expect(
      keepFailedImport('../x', { kind: 'image', reason: 'no-recipe', files: [] }),
    ).rejects.toThrow();
  });
});
