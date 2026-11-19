/**
 * How a script's lines tell their reader to run another command of this
 * folder.
 *
 * The scripts said `sandforge-checkpoint rewind --org …`, `sandforge-env
 * state recover …`, `sandforge-dataops anonymize --restore …`: names that
 * exist only on the PATH of a global install of the `sandforge` npm package.
 * Run by `npx sandforge clone …`, as the package's own README has it, none of
 * them is there once the command ends, and the line copied as `npx
 * sandforge-checkpoint …` asks the registry for a package of that name, which
 * anybody can publish. A line to run says the command the way it runs where
 * the script runs; a sentence names it `sandforge checkpoint`, the package's
 * own word for it; the hyphenated name stays an identifier — a summary's
 * `tool`, the script a runner starts — and `invocation.test.ts` holds every
 * string of the folder to that.
 */

import type { Tool } from './sandforge.js';

/**
 * The command a reader runs `tool` by: from a checkout, the script's own file
 * under tsx, as the documentation runs it. The `sandforge` package is built
 * with this line rewritten to `npx sandforge <tool>` (`scripts/npm-package.mjs`,
 * whose build fails when the rewrite finds nothing): npx runs the command
 * installed globally or in the project when there is one, the package from the
 * registry otherwise, and either way the package named `sandforge`.
 *
 * @param tool - The command, as `sandforge` takes it: `checkpoint`, `env`…
 */
export function commandOf(tool: Tool): string {
  return `pnpm exec tsx packages/extension/cli/sandforge-${tool}.ts`;
}

/**
 * The name a sentence gives the script an identifier names: `sandforge seed`
 * for `sandforge-seed`, the name a runner starts it by and a summary's `tool`
 * keeps. Any other word is left as it is.
 */
export function nameOf(script: string): string {
  return script.replace(/^sandforge-(?=[a-z]+$)/, 'sandforge ');
}

/**
 * A word of a line, as the shell the line is typed in reads it back whole:
 * as it is when no shell acts on any of its characters; on Windows, in
 * double quotes, which cmd.exe, PowerShell and Git Bash all read — cmd.exe
 * keeps single quotes in the word, and a path printed `'C:\…'` named no file
 * there; elsewhere, in single quotes, each one inside closed, escaped and
 * opened again.
 *
 * In double quotes, a quote inside is doubled and the backslashes before a
 * quote — the closing one after a folder's last backslash too — are doubled,
 * as the C runtime that splits a Windows program's line reads them back. A
 * `%` or a `!` for cmd.exe, a `$` or a backtick for PowerShell, stays as it
 * is: no quoting keeps one from all three shells, and none is common in a
 * Windows path.
 *
 * @param platform - The system the line is printed on: the shell it is typed in runs there.
 */
export function typedWord(word: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[\w.@:+/=,-]+$/.test(word)) return word;
  if (platform !== 'win32') return `'${word.replace(/'/g, `'\\''`)}'`;
  const inside = word.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1');
  return `"${inside}"`;
}
