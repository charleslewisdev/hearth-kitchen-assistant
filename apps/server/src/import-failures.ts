import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env';

/**
 * Keep what an import could not read, so it can be studied later.
 *
 * A photo or PDF that produced no recipe is exactly the material the parser needs improving
 * against, and until now it was gone the moment the request ended. Each failure becomes a
 * folder under `DATA_DIR/import-failures/<household>/`, named by time and a fresh id, holding
 * the uploaded bytes as they arrived and a `meta.json` saying which procedure failed and why
 * (the reason code, never any text read off the page). When text was read off the page but held
 * no recipe, `text.txt` beside them is that text, OCR's or the text layer's, so the parser can be
 * run over it again without OCR. The log line carries the same ids only (D38).
 *
 * Bounded: the newest `MAX_KEPT` failures per household are kept and older ones removed, so a
 * household that keeps retrying one bad page cannot fill the disk.
 */

export const MAX_KEPT = 200;
const HOUSEHOLD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface FailedImport {
  kind: 'image' | 'pdf';
  reason: string;
  files: Uint8Array[];
  /** What was read off the page, when it was read and held no recipe. */
  text?: string;
}

export function importFailuresRoot(dataDir: string = env.DATA_DIR): string {
  return join(dataDir, 'import-failures');
}

/** Store one failed import; returns its folder name, or throws if the disk refuses. */
export async function keepFailedImport(
  householdId: string,
  failure: FailedImport,
  now: Date = new Date(),
  dataDir?: string,
): Promise<string> {
  if (!HOUSEHOLD_ID.test(householdId)) throw new Error('unexpected household id');
  const base = join(importFailuresRoot(dataDir), householdId);
  const id = `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = join(base, id);
  await mkdir(dir, { recursive: true });
  const ext = failure.kind === 'pdf' ? 'pdf' : 'jpg';
  // The text only when some was read: no text.txt means OCR found nothing on the page.
  const text = failure.text?.trim() ? failure.text : undefined;
  await Promise.all([
    ...failure.files.map((bytes, i) => writeFile(join(dir, `page-${i + 1}.${ext}`), bytes)),
    ...(text === undefined ? [] : [writeFile(join(dir, 'text.txt'), text)]),
  ]);
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        kind: failure.kind,
        reason: failure.reason,
        pages: failure.files.length,
        at: now.toISOString(),
      },
      null,
      2,
    ),
  );

  // Folder names start with the time, so name order is age order.
  const kept = (await readdir(base)).sort();
  await Promise.all(
    kept
      .slice(0, Math.max(0, kept.length - MAX_KEPT))
      .map((old) => rm(join(base, old), { recursive: true, force: true })),
  );
  return id;
}
