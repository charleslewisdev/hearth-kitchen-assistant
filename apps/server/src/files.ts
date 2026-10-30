import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, type ReadStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env';

/**
 * Where a recipe's files live on disk: `DATA_DIR/files/<household id>/<file id>-<variant>`.
 *
 * The database row (`recipe_file`) is the authority on whether a file exists and who may see
 * it; this module only moves bytes. Every name here is built from ids the server minted (a
 * household id and a uuid), never from anything a client sent, so there is no path to traverse.
 */

export type FileVariant = 'full' | 'thumb';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Better Auth's organization ids: letters, digits, underscore and hyphen.
const HOUSEHOLD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function filesRoot(dataDir: string = env.DATA_DIR): string {
  return join(dataDir, 'files');
}

function pathFor(householdId: string, id: string, variant: FileVariant, dataDir?: string) {
  if (!HOUSEHOLD_ID.test(householdId) || !UUID.test(id)) {
    throw new Error('refusing a file path built from an unexpected id');
  }
  return join(filesRoot(dataDir), householdId, `${id}-${variant}`);
}

/**
 * Write one variant. To a temporary name first and renamed into place, so a reader never sees
 * half a file and a crash mid-write leaves only a stray `.tmp`.
 */
export async function writeFileVariant(
  householdId: string,
  id: string,
  variant: FileVariant,
  bytes: Buffer,
  dataDir?: string,
): Promise<void> {
  const target = pathFor(householdId, id, variant, dataDir);
  await mkdir(join(filesRoot(dataDir), householdId), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

/** A stream of one variant, or null when it is not on disk. */
export function readFileVariant(
  householdId: string,
  id: string,
  variant: FileVariant,
  dataDir?: string,
): ReadStream | null {
  const path = pathFor(householdId, id, variant, dataDir);
  return existsSync(path) ? createReadStream(path) : null;
}

/** Remove every variant of these files. Missing ones are fine: the goal is that they are gone. */
export async function removeFiles(
  householdId: string,
  ids: string[],
  dataDir?: string,
): Promise<void> {
  await Promise.all(
    ids.flatMap((id) =>
      (['full', 'thumb'] as const).map((variant) =>
        rm(pathFor(householdId, id, variant, dataDir), { force: true }),
      ),
    ),
  );
}
