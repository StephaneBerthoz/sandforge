/**
 * Where the commands of this folder keep what they write on this machine —
 * the journals of the runs that write, their run files, checkpoints, the
 * plans of samples — in a module of its own: the MCP server reads the same
 * folder without loading the clone script, which only kept it because it was
 * the first to write there.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The variable that names the folder, as each script's `--help` says it. */
export const JOURNAL_DIR_VARIABLE = 'SANDFORGE_JOURNAL_DIR';

/**
 * Where the commands keep the journals of the runs that write:
 * `SANDFORGE_JOURNAL_DIR`, or `.sandforge` in the home directory.
 */
export function journalDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[JOURNAL_DIR_VARIABLE];
  return dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
}
