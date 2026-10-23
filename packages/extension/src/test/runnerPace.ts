/**
 * How much longer a test may take on this runner than on the one it was
 * timed on. A Windows runner reads and writes files several times slower than
 * Linux and macOS ones: the memory-org tests of Checkpoint & Rewind, which
 * spool every read to disk, went past their time there and nowhere else.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */
export const RUNNER_PACE = process.platform === 'win32' ? 3 : 1;

/** `ms`, a test's time on the runner it was timed on, stretched to this one's pace. */
export function paced(ms: number): number {
  return ms * RUNNER_PACE;
}
