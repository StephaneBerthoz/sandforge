/**
 * How long a command has run, as its `--json` answer gives it: never less
 * than none.
 *
 * A command reads its duration off the machine's clock, and a machine sets
 * that clock back: under WSL it went back by 1.25 s every 31 s or so. A clone
 * across one wrote `elapsedMs: -1250` in its summary, which its own
 * `--remove` then refused, and a removal across one answered the same, which
 * an environment refused once the records were deleted.
 *
 * @param startedAt - When the command started, `Date.now()` then.
 * @param now - When the answer is given; the clock now unless said.
 */
export function elapsedSince(startedAt: number, now: number = Date.now()): number {
  return Math.max(0, now - startedAt);
}
