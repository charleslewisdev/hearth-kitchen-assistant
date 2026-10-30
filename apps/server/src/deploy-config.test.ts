import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The image, the unRAID template and compose must agree on where DATA_DIR is.
 *
 * The template mounts the host's data directory at a container path, but a mount only makes a
 * directory appear; the server writes wherever DATA_DIR says, and its default is `./.data`
 * under the working directory. The first unRAID install shipped with the mount at /data and no
 * DATA_DIR anywhere, so the auth secret and setup token went into the container's writable
 * layer - lost on the next recreate, which signs everyone out. Compose set DATA_DIR itself,
 * which is why nothing local caught it.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

const dockerfile = read('Dockerfile');
const template = read('deploy/unraid/hearth.xml');
const compose = read('docker-compose.yml');

const imageDataDir = /^ENV DATA_DIR=(\S+)$/m.exec(dockerfile)?.[1];

describe('DATA_DIR in the deployment files', () => {
  it('is set in the image, as an absolute path', () => {
    expect(imageDataDir).toMatch(/^\//);
  });

  it('is the container path the unRAID template mounts the data directory at', () => {
    const mount = /<Config Name="Data directory" Target="([^"]+)"/.exec(template)?.[1];
    expect(mount).toBe(imageDataDir);
  });

  it('is what compose sets it to and mounts a volume at', () => {
    expect(/^\s+DATA_DIR: (\S+)$/m.exec(compose)?.[1]).toBe(imageDataDir);
    expect(compose).toMatch(new RegExp(`^\\s+- \\w+:${imageDataDir}$`, 'm'));
  });
});
