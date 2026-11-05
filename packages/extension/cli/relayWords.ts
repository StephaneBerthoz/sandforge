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
 * The options of a script a command that relays its lines takes itself, and
 * hands it: `sandforge-env destroy --sweep`; the MCP server's `seed_run`,
 * `clone_record` and `run_remove` take `muteAutomation`, `run_remove` its
 * `leaveUndeletable` and, for a Sync run, its `store`. Any other relay — an
 * apply or a plan of `sandforge-env`, an environment the MCP server runs —
 * takes none of them.
 */
const TAKEN_BY_THE_RELAY: ReadonlyMap<string, readonly string[]> = new Map([
  ['sandforge-env', ['--sweep']],
  ['sandforge-mcp', ['--mute-automation', '--leave-undeletable', '--store']],
]);

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
