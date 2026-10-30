/*
 * Recognise one image with tesseract, using options handed in from outside.
 *
 * Run by `from-image.test.ts` as a child process under `--require ./block-network.cjs`, so that
 * nothing in it - including the worker thread tesseract starts, which has its own module
 * registry and cannot be reached from the test's process - can open a socket or resolve a name.
 *
 *   node --require test/block-network.cjs test/offline-ocr.cjs '<options json>' <image path>
 *
 * The options are `ocrWorkerOptions()` from `from-image.ts`, serialised by the test, so this
 * script cannot pass while the module under test is configured differently: it is exercising
 * that module's own answer to "where does the model come from", not a copy of it.
 *
 * Prints the recognised text and exits 0, or prints a reason and exits non-zero.
 */
const { createWorker, OEM } = require('tesseract.js');

const options = JSON.parse(process.argv[2]);
const imagePath = process.argv[3];

// createWorker neither resolves nor rejects when the model fails to load (see the comment on
// `languageUnavailable` in from-image.ts), so a failure here would otherwise hang the test.
const giveUp = setTimeout(() => {
  process.stderr.write('timed out waiting for the worker\n');
  process.exit(4);
}, 60_000);

(async () => {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    ...options,
    logger: () => undefined,
    errorHandler: (error) => {
      process.stderr.write(`worker error: ${String(error)}\n`);
      process.exit(3);
    },
  });
  const { data } = await worker.recognize(imagePath);
  await worker.terminate();
  clearTimeout(giveUp);
  process.stdout.write(data.text);
})().catch((error) => {
  process.stderr.write(`${String(error && error.message)}\n`);
  process.exit(5);
});
