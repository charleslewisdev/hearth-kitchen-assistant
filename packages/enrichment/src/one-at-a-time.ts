/**
 * A queue of depth one, with a bounded waiting room.
 *
 * Both decoders in this package are synchronous CPU on the server's only thread once their
 * bytes are in hand - tesseract is single-threaded (Task J0 measured a 12MP recognition at
 * 1201ms pinned to one core against 1176ms unpinned), and pdfjs runs in-process. So the thing
 * worth bounding is not how long one import takes but how many of them run at once, because
 * that is what takes cores away from Postgres and from the household's shopping list.
 *
 * Two bounds, and they answer different questions:
 *
 *  - **Depth one** decides how much work happens at a time.
 *  - **`maxWaiting`** decides how much work is allowed to pile up. Without it a queue of depth
 *    one still accepts an unbounded number of waiting jobs, each holding its megabytes of
 *    upload for as long as the queue is long - and nothing drops a job when the browser that
 *    asked for it has gone away. Refusing past a small depth, and saying so, is honest where
 *    growing quietly is not.
 */

/** What a queue answers when its waiting room is full. */
export class QueueFullError extends Error {
  constructor() {
    super('the import queue is full');
    this.name = 'QueueFullError';
  }
}

export interface Queue {
  /** Run `work` when the queue reaches it, or throw `QueueFullError` if too many are waiting. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** How many jobs are waiting for their turn, not counting the one running. Exposed for tests. */
  waiting(): number;
}

export function createQueue(maxWaiting: number): Queue {
  /**
   * The tail every new job chains onto, and it never carries a rejection.
   *
   * Without swallowing the outcome, one job that threw would reject the tail: every job after
   * it would be rejected without ever running, and Node would report the tail as an unhandled
   * rejection. The promise handed back to the caller keeps its rejection, which is theirs.
   */
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  return {
    waiting: () => waiting,
    run<T>(work: () => Promise<T>): Promise<T> {
      if (waiting >= maxWaiting) return Promise.reject(new QueueFullError());
      waiting += 1;
      const result = tail.then(() => {
        waiting -= 1;
        return work();
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
