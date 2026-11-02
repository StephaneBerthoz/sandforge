/**
 * How a command says its gate refused a run before its first write, for a
 * refusal that has a code: Sync's way, the one every run shares. A CI job
 * reads the code in the line and, with `--json`, in the summary on stdout: a
 * clone or a seed refused for its emails said a sentence on stderr, no code,
 * and left stdout empty.
 */

/** A refusal with its code, as a run's gate gives it. */
export interface RunRefusal {
  code: string;
  message: string;
}

/** The line a refused run ends on. */
export function refusedLine({ code, message }: RunRefusal): string {
  return `refused (${code}): ${message}`;
}

/** What the summary of a refused run names. */
export interface RefusedRun {
  tool: string;
  /** The org it reads from, for a run that has one. */
  source?: string;
  target: string;
  elapsedMs: number;
}

/**
 * The `--json` summary of a refused run, as stdout carries it.
 *
 * @param also - What else refused it, for a command that says both at once.
 */
export function refusedSummary(
  run: RefusedRun,
  refused: RunRefusal,
  also: readonly RunRefusal[] = [],
): string {
  const { tool, source, target, elapsedMs } = run;
  return `${JSON.stringify(
    {
      tool,
      ...(source !== undefined ? { source } : {}),
      target,
      dryRun: false,
      refused,
      ...(also.length > 0 ? { alsoRefused: also } : {}),
      elapsedMs,
    },
    null,
    2,
  )}\n`;
}
