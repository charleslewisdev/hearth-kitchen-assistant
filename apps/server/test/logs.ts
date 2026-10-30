import { Writable } from 'node:stream';

/**
 * A sink that collects what a logger writes, plus the parsed lines. Tests that assert on log
 * output build their logger over `sink` themselves, so the construction under test stays
 * visible at the call site.
 */
export function capture(): { sink: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .flatMap((c) => c.trim().split('\n'))
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
