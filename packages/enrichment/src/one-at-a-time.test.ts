import { describe, it, expect } from 'vitest';
import { createQueue, QueueFullError } from './one-at-a-time';

/** Work that reports when it is running, so overlap is observable rather than assumed. */
function tracker() {
  const state = { running: 0, mostAtOnce: 0, finished: 0 };
  const work = async () => {
    state.running += 1;
    state.mostAtOnce = Math.max(state.mostAtOnce, state.running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.running -= 1;
    state.finished += 1;
  };
  return { state, work };
}

describe('a queue of depth one', () => {
  it('runs one job at a time, however many arrive at once', async () => {
    const queue = createQueue(10);
    const { state, work } = tracker();
    await Promise.all(Array.from({ length: 5 }, () => queue.run(work)));
    expect(state.mostAtOnce).toBe(1);
    expect(state.finished).toBe(5);
  });

  it('lets the next job through after one of them throws', async () => {
    // A queue that only advanced on success would be blocked for good by the first job that
    // went wrong, and the household could never import anything again.
    const queue = createQueue(10);
    await expect(
      queue.run(async () => {
        throw new Error('fell over');
      }),
    ).rejects.toThrow('fell over');
    expect(await queue.run(async () => 'through')).toBe('through');
  });

  it("hands the caller back the job's own result and its own rejection", async () => {
    const queue = createQueue(10);
    expect(await queue.run(async () => 42)).toBe(42);
    await expect(queue.run(async () => Promise.reject(new Error('mine')))).rejects.toThrow('mine');
  });
});

describe('the waiting room', () => {
  it('refuses a job once too many are already waiting', async () => {
    const queue = createQueue(2);
    const { work } = tracker();
    const accepted = [queue.run(work), queue.run(work)];
    // Two waiting is the cap; the third is refused rather than queued behind them.
    await expect(queue.run(work)).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all(accepted);
  });

  it('accepts again once the queue has drained', async () => {
    const queue = createQueue(1);
    const { work } = tracker();
    const first = queue.run(work);
    await expect(queue.run(work)).rejects.toBeInstanceOf(QueueFullError);
    await first;
    await expect(queue.run(work)).resolves.toBeUndefined();
  });

  it('counts down as jobs start, not only as they finish', async () => {
    const queue = createQueue(3);
    const { work } = tracker();
    const jobs = [queue.run(work), queue.run(work), queue.run(work)];
    expect(queue.waiting()).toBe(3);
    await Promise.all(jobs);
    expect(queue.waiting()).toBe(0);
  });
});
