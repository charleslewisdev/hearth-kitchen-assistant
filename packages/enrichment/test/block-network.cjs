/*
 * Makes a Node process, and every worker thread inside it, incapable of talking to anything.
 *
 * Preloaded with `node --require`, which is the only way to reach a worker thread: a worker
 * gets its own module registry, so patching `net` in the parent does nothing to it, and
 * `process.execArgv` assigned at run time is not picked up either (both measured). Passed on
 * the command line it IS inherited, because a worker created with default options takes the
 * parent's `execArgv` as it stood when the process started.
 *
 * Used by `offline-ocr.cjs`, which is how `from-image.test.ts` proves that OCR reads its
 * language model off disk rather than fetching it.
 */
const net = require('node:net');
const dns = require('node:dns');

net.Socket.prototype.connect = function connectRefused() {
  throw new Error('outbound connections are disabled in this process');
};

const refuse = (...args) => {
  const callback = args.find((argument) => typeof argument === 'function');
  if (callback) callback(new Error('name resolution is disabled in this process'));
};
dns.lookup = refuse;
dns.resolve = refuse;
