#!/usr/bin/env tsx
/**
 * sandforge — the scripts of this folder under one command: `sandforge seed …`
 * runs `sandforge-seed` with the words after its name, as its own file would
 * have run with them.
 *
 * It is what the `sandforge` npm package starts (`npx sandforge clone …`,
 * `npx -y sandforge mcp`), and it runs from a checkout as well:
 *   pnpm exec tsx packages/extension/cli/sandforge.ts seed --help
 *
 * The script runs in this process, not in a child of it: its guards, its
 * questions, its stop signals, its exit code and its whole output stay its
 * own, and the MCP server's stdout carries nothing but its messages. A script
 * starts itself only when the file the process was started from is its own
 * (`process.argv[1]`): the line is set to the one its file would have been
 * given before the script is loaded, and nothing of it is loaded before.
 */

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every script of this folder, by the name `sandforge` takes, with what it does. */
export const TOOLS = {
  autopilot: 'run an Autopilot copy between two orgs',
  backup: 'take and restore DataOps snapshots',
  checkpoint: "take a checkpoint of an org's data, and rewind the org to it",
  cleanup: 'Bulk delete records you created on a sandbox in a time window',
  clone: 'clone a record, or whole tables, from one org to a sandbox, or remove a run',
  compare: 'compare two orgs the way the Compare page does',
  dataops: "mask an org's records, and put them back",
  empty: 'empty objects of a sandbox, or the whole of it',
  env: 'apply a sandforge.yaml to an org, and take it back',
  frozen: 'build and replay a Frozen Dataset',
  mcp: 'the MCP server: these scripts as tools for an AI agent, on stdio',
  monitor: 'read an org the way the Monitor page does',
  seed: 'fill an org from a seed template',
  sync: 'run a Sync between two orgs',
} as const;

/** A script `sandforge` runs, by the name it takes on the line. */
export type Tool = keyof typeof TOOLS;

const isTool = (word: string): word is Tool => Object.prototype.hasOwnProperty.call(TOOLS, word);

/** What a line asks of `sandforge`. */
export type Dispatch =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; tool: Tool; args: string[] }
  | { kind: 'refused'; reason: string };

/**
 * What the words after `sandforge` ask: its help, its version, a script with
 * the words after its name, or a refusal, before anything is loaded.
 *
 * @param args - The line after the program and this file.
 */
export function dispatchOf(args: readonly string[]): Dispatch {
  const [first, ...rest] = args;
  if (first === undefined) {
    return { kind: 'refused', reason: 'Name the command to run.' };
  }
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (isTool(first)) return { kind: 'run', tool: first, args: rest };
  // `sandforge sandforge-seed …`, from a message that names the script.
  const named = first.replace(/^sandforge-/, '');
  if (named !== first && isTool(named)) {
    return { kind: 'refused', reason: `"${first}" is named ${named} here: sandforge ${named} ….` };
  }
  return {
    kind: 'refused',
    reason: first.startsWith('-')
      ? `"${first}" is not a flag sandforge reads: name a command first.`
      : `"${first}" is not a command of sandforge.`,
  };
}

/** What `sandforge --help` prints. */
export function helpText(): string {
  const width = Math.max(...Object.keys(TOOLS).map((name) => name.length));
  const lines = Object.entries(TOOLS).map(
    ([name, summary]) => `  ${name.padEnd(width)}  ${summary}`,
  );
  return `sandforge — SandForge's command lines, without the editor: Seed, Forge's clone, Sync,
Checkpoints, DataOps, Frozen Dataset, the emptying of a sandbox, sandforge.yaml environments, and
the MCP server.

Usage:
  sandforge <command> [options]
  sandforge <command> --help      what the command does, its options and its exit codes

Commands:
${lines.join('\n')}

Each org is named by its sf CLI alias: the Salesforce CLI (sf) must be installed and logged in
to it. In Claude Code:
  claude mcp add sandforge -- npx -y sandforge mcp

  --version                       the version of SandForge these scripts belong to
  --help                          this text
`;
}

/**
 * The file a script runs from: its own beside this one, with this file's
 * extension (`.ts` from a checkout, `.mjs` packaged).
 */
export function toolFile(
  tool: Tool,
  folder: string = __dirname,
  file: string = __filename,
): string {
  return join(folder, `sandforge-${tool}${extname(file)}`);
}

/** The version of the package this folder belongs to, as its `package.json` says. */
export function versionOf(folder: string = __dirname): string {
  const read = JSON.parse(readFileSync(join(folder, '..', 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return typeof read.version === 'string' ? read.version : '0.0.0';
}

/** Loads a script's file, which starts it when the line names that file. */
export type ScriptLoader = (file: string) => Promise<unknown>;

const importFile: ScriptLoader = (file) => import(pathToFileURL(file).href);

/**
 * Run what the line asks. A script is given the line its own file would
 * have been given — the runtime, its file, the words after its name — and
 * then loaded, which starts it.
 *
 * @param argv - The whole line, runtime and this file first.
 * @param load - How a script's file is loaded; the dynamic import by default.
 */
export async function main(
  argv: readonly string[] = process.argv,
  load: ScriptLoader = importFile,
): Promise<void> {
  const asked = dispatchOf(argv.slice(2));
  switch (asked.kind) {
    case 'help':
      process.stdout.write(helpText());
      return;
    case 'version':
      process.stdout.write(`${versionOf()}\n`);
      return;
    case 'refused':
      process.stderr.write(
        `${asked.reason} Nothing was run. The commands: ${Object.keys(TOOLS).join(', ')}. ` +
          'Run with --help.\n',
      );
      process.exitCode = 2;
      return;
    case 'run': {
      const file = toolFile(asked.tool);
      process.argv = [argv[0] ?? process.execPath, file, ...asked.args];
      await load(file);
      return;
    }
  }
}

// Only when run as a script: importing the module must start nothing.
if (/(?:^|[\\/])sandforge\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
