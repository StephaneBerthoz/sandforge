/**
 * The flags a command line reads, and the refusal of every other word on it.
 *
 * Each command read its switches with `args.includes('--dry-run')` and its
 * values with the word after the flag, and dropped the rest without a word.
 * `--dry-run=true` — how a pipeline writes `--dry-run=$DRY_RUN` — and a
 * misspelt `--dryrun` were not a dry run: the clone, the seed, Sync and the
 * cleanup then wrote, or deleted, for real. The removals already refused a
 * flag they do not read, for that reason; every command line does now,
 * before any org is reached.
 */

/** What a command reads of its line. */
export interface CommandFlags {
  /** Flags that stand alone, as `--dry-run`. */
  readonly switches: readonly string[];
  /** Flags followed by their value, as `--target <alias>`. */
  readonly values: readonly string[];
  /** Words the command takes before its flags: Frozen's step, DataOps' command. */
  readonly words?: number;
}

/** What every command reads beside its own flags. */
const HELP_FLAGS: readonly string[] = ['--help', '-h'];

/**
 * Why a word of the line is not one the command reads, or nothing when every
 * word is. A value is the word after its flag, unless that word is a flag
 * itself: the command's own check then says the flag wants a value. Exported
 * so it can be tested.
 *
 * @param args - The line after the program and the script.
 */
export function unreadArgument(args: readonly string[], flags: CommandFlags): string | undefined {
  const switches = new Set([...flags.switches, ...HELP_FLAGS]);
  const values = new Set(flags.values);
  for (let i = flags.words ?? 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    if (switches.has(arg)) continue;
    const at = arg.indexOf('=');
    const flag = at > 0 ? arg.slice(0, at) : arg;
    if (arg.startsWith('-') && at > 0 && switches.has(flag)) {
      return (
        `"${arg}" is not read: ${flag} takes no value, it is on when given and off when left ` +
        'out. Nothing was run.'
      );
    }
    if (arg.startsWith('-') && at > 0 && values.has(flag)) {
      return (
        `"${arg}" is not read: give its value after a space, as ${flag} ${arg.slice(at + 1)}. ` +
        'Nothing was run.'
      );
    }
    if (arg.startsWith('-')) return `"${arg}" is not a flag this command reads. Nothing was run.`;
    return `"${arg}" is not read: a value goes after the flag it is for. Nothing was run.`;
  }
  return undefined;
}

/**
 * Stop the command, exit 2, on a word of the line it does not read, said on
 * stderr; go on when it reads them all.
 */
export function refuseUnreadArguments(args: readonly string[], flags: CommandFlags): void {
  const refusal = unreadArgument(args, flags);
  if (refusal === undefined) return;
  process.stderr.write(`${refusal} Run with --help.\n`);
  process.exit(2);
}
