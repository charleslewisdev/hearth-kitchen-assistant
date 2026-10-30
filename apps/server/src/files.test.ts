import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileVariant, removeFiles, writeFileVariant } from './files';

const dir = () => mkdtempSync(join(tmpdir(), 'hearth-files-'));

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('recipe files on disk', () => {
  it('writes, reads back and removes every variant', async () => {
    const data = dir();
    const id = randomUUID();
    await writeFileVariant('hh_1', id, 'full', Buffer.from('big'), data);
    await writeFileVariant('hh_1', id, 'thumb', Buffer.from('small'), data);
    expect(await readAll(readFileVariant('hh_1', id, 'full', data)!)).toBe('big');
    // No temporary file is left beside it.
    expect(readdirSync(join(data, 'files', 'hh_1')).sort()).toEqual([`${id}-full`, `${id}-thumb`]);

    await removeFiles('hh_1', [id], data);
    expect(readFileVariant('hh_1', id, 'full', data)).toBeNull();
    // Removing again is not an error.
    await removeFiles('hh_1', [id], data);
  });

  it('refuses a path built from anything but a household id and a uuid', async () => {
    const data = dir();
    await expect(
      writeFileVariant('../etc', randomUUID(), 'full', Buffer.from('x'), data),
    ).rejects.toThrow();
    expect(() => readFileVariant('hh_1', '../../secret', 'full', data)).toThrow();
  });
});
