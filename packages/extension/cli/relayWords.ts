/**
 * What a script's advice names, when another command relays its lines: the
 * options that command's reader can give it, and those only this script's
 * own line takes. Relayed by `sandforge-env` or by the MCP server, a removal
 * said "run again with --leave-undeletable" and "With --mute-automation, the
 * removal assigns …" to a reader neither command takes them from, and an
 * apply's removals said "--sweep takes them first", which only a destroy takes.
 */

import { RELAYED_BY_VARIABLE } from './scriptRunner.js';

/** The command that relays this script's lines to whoever reads them, when one does. */
export function relayedBy(): string | undefined {
  const by = process.env[RELAYED_BY_VARIABLE]?.trim();
  return by === undefined || by === '' ? undefined : by;
}

/**
 * Whether an environment relays this script's lines — `sandforge-env`, its
 * plan, apply or destroy, relayed itself or not —: a reader who gives the
 * script no option, the environment setting each from its file.
 */
export function relayedByAnEnvironment(): boolean {
  return relayedBy()?.startsWith('sandforge env') === true;
}

/**
 * An option of this script as a line that describes the run names it: the
 * option itself, or, relayed by an environment, `words`, what stands for it
 * in the environment's file or command. Told "(--keep-contact-points)", the
 * reader of a plan had given no flag: its file had said keepContactPoints.
 */
export function envWords(option: string, words: string): string {
  return relayedByAnEnvironment() ? words : option;
}

/**
 * What the MCP server's tools that clone the whole org tell the clone script
 * relays its lines: its `clone_org_plan`, the dry run whose plan it keeps,
 * and its `clone_org`, the run of that plan and of nothing else.
 */
export const CLONE_ORG_PLAN_RELAY = 'sandforge mcp clone_org_plan';
export const CLONE_ORG_RELAY = 'sandforge mcp clone_org';

/**
 * The options of a script a command that relays its lines takes itself, and
 * hands it: `sandforge-env destroy --sweep --include-changed`; the MCP
 * server's `seed_run`, `clone_record` and `run_remove` take
 * `muteAutomation`, `run_remove` its `leaveUndeletable`, its
 * `includeChanged`, its `preview` and, for a Sync run, its `store`; `env_destroy` its
 * `includeChanged`. Its `clone_org_plan` takes what narrows, fits and
 * accepts a clone of the whole org, as parameters of the same names; its
 * `clone_org` takes a plan and nothing of what it writes. Any other relay —
 * an apply or a plan of `sandforge-env` — takes none of them: a removal an
 * apply's replace ran said "(--include-changed takes them)", which no apply
 * takes.
 */
const TAKEN_BY_THE_RELAY: ReadonlyMap<string, readonly string[]> = new Map([
  ['sandforge env', ['--sweep', '--include-changed']],
  ['sandforge env, relayed by sandforge mcp', ['--include-changed']],
  [
    'sandforge mcp',
    ['--mute-automation', '--leave-undeletable', '--store', '--include-changed', '--preview'],
  ],
  [
    CLONE_ORG_PLAN_RELAY,
    [
      '--max-total',
      '--exclude-object',
      '--exclude',
      '--filter',
      '--fit',
      '--fit-within',
      '--fit-seed',
      '--fit-draw',
      '--fit-parents',
      '--fit-children',
      '--fit-whole',
      '--fit-floor',
      '--anonymize',
      '--accept-automation',
      '--accept-emails',
      '--mute-automation',
      '--checkpoint-first',
    ],
  ],
  [CLONE_ORG_RELAY, []],
]);

/**
 * Whether the command that relays this script's lines holds its run to the
 * count of a plan its reader was shown, and gives it no option that narrows
 * it: an environment, whose apply gives each clone its dry run's count with
 * `--max-total`, and the MCP server's `clone_org`, which writes the plan
 * `clone_org_plan` kept and nothing else. A run past that count found a
 * source that grew since its plan, which only a new plan says: told "raise
 * its --max-total", the reader of an apply had nothing to raise.
 */
export function relayHoldsToItsPlan(): boolean {
  return relayedByAnEnvironment() || relayedBy() === CLONE_ORG_RELAY;
}

/** Whether the reader of this script's lines can give it `option`: unrelayed, or relayed by a command that takes it. */
export function relayTakes(option: string): boolean {
  const by = relayedBy();
  return by === undefined || TAKEN_BY_THE_RELAY.get(by)?.includes(option) === true;
}

/**
 * An option of this script as a line of advice names it: the option itself,
 * unrelayed or relayed by a command that takes it; relayed by one that does
 * not, this script's own option, which its reader gives the script's line,
 * not the command's.
 *
 * @param of - What of this script takes it: "removal", for an option of `--remove`.
 */
export function ownOptionWords(option: string, of?: string): string {
  if (relayTakes(option)) return option;
  return of === undefined
    ? `this script's own ${option}`
    : `this script's own ${of} with ${option}`;
}
