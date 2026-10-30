#!/usr/bin/env tsx
/**
 * sandforge-mcp — Seed, Forge's clone of a record, the removal of a run,
 * Checkpoints and the environments of a `sandforge.yaml` as tools an AI agent
 * calls, over the Model Context Protocol on stdio.
 *
 * Each tool runs the command-line script of this folder that does the same
 * thing, with `--json`, in a process of its own, and answers with what the
 * script answered: its JSON, its exit code and the lines it said. Every guard
 * of the script holds as it holds on a terminal — a production org refused
 * before anything is read, the permissions, the API requests left today, the
 * daily emails, the data storage, the acceptances, the lock against a run
 * under way — and none of them is written a second time here. This file
 * decides which script runs, with which line, and nothing a run may do.
 *
 * The one rule it adds is `confirm`: a call that writes to an org names that
 * org's alias a second time, exactly, or it is refused before any script
 * runs, so before anything is read. A script that asks a question has no
 * terminal to answer it on: it stops at its question, exit 2, having written
 * nothing, and the question comes back in its own words as the call's error,
 * for the person using the agent to answer. Nothing here answers one.
 *
 * The extension gives the model no tool, and this server is no part of it:
 * `.vscodeignore` leaves `cli/` out of the VSIX, which
 * `scripts/mcp-server-not-shipped.test.mjs` checks against the packaged file
 * list, and nothing under `src/` imports from here (the product-claims scan
 * reads every file a shipped one imports).
 *
 * The protocol is written here, without an SDK: JSON-RPC 2.0, one message a
 * line, nothing on stdout but those messages and every other line on stderr.
 * It follows the 2026-07-28 revision, where each request names its version in
 * `_meta` and `server/discover` says which ones are served, and it answers
 * the clients of the revisions before it, which open with `initialize`.
 *
 * Usage, from the repository root of a checkout, after pnpm install and
 * pnpm build:shared; in Claude Code:
 *   claude mcp add sandforge -- pnpm exec tsx packages/extension/cli/sandforge-mcp.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';
import { refuseUnreadArguments } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT } from './exitCodes.js';
import { NO_TERMINAL_EXIT } from './prompt.js';
import { spawnCommand, type CommandRun, type CommandRunner as RunnerOf } from './scriptRunner.js';
import { STOP_SIGNALS, onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { holdOutputWhole } from './wholeOutput.js';

// ─── The protocol ────────────────────────────────────────────────────────────

/** The revision this server follows: a request of it names it in `_meta`. */
export const PROTOCOL_VERSION = '2026-07-28';

/**
 * The earlier revisions it answers, newest first: their clients open with an
 * `initialize` handshake, and the version it agrees on holds for the process.
 */
export const HANDSHAKE_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** The keys of `_meta` this server reads and writes, reserved by the protocol. */
const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

/** JSON-RPC's own error codes, and the one the protocol gives a version it does not serve. */
export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedVersion: -32022,
} as const;

/** How long a client may keep the tool list: it never changes while the process lives. */
const TOOL_LIST_TTL_MS = 60 * 60_000;

/** The server, as `serverInfo` names it. */
const SERVER_INFO = {
  name: 'sandforge',
  title: 'SandForge',
  version: String(
    (
      JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
        version?: unknown;
      }
    ).version ?? '0.0.0',
  ),
};

/** What the model is told of the server as a whole, beside each tool's own description. */
export const INSTRUCTIONS =
  "SandForge's Seed, Forge's clone of a record, the removal of a run, Checkpoints and the " +
  'environments of a sandforge.yaml, run from a checkout of its repository. Every org is named ' +
  'by its sf CLI alias, as `sf alias list` shows them. A tool that writes to an org takes ' +
  'confirm, the alias of that org exactly: give it only once the person using you has agreed ' +
  'to that write, after a dry run, a preview or a plan has said what it would do. The ' +
  'acceptances (acceptAutomation and the others) are theirs to give too. A production org is ' +
  "refused by every tool that writes to an org. Each answer carries the script's own JSON, its " +
  'exit code and its lines.';

// ─── The tools ───────────────────────────────────────────────────────────────

/** The scripts of this folder a tool runs. */
export type Script =
  | 'sandforge-seed'
  | 'sandforge-clone'
  | 'sandforge-sync'
  | 'sandforge-checkpoint'
  | 'sandforge-env';

export type { CommandRun };

/**
 * Runs a script a tool runs, in a process of its own (`scriptRunner.ts`), and
 * settles once it has ended. The signal stops it as Ctrl-C stops it on a
 * terminal.
 */
export type CommandRunner = RunnerOf<Script>;

/** A call that runs a script, or one this server answers itself. */
type Run =
  | { script: Script; args: string[] }
  | { local: () => Promise<{ text: string; structured: Record<string, unknown> }> };

/** A tool as `tools/list` describes it. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
  };
}

/** A tool as it is declared. */
interface ToolSpec<S extends z.ZodType<Record<string, unknown>>> {
  name: string;
  title: string;
  description: string;
  /** It changes nothing, in any org or on this machine. */
  readOnly: boolean;
  /** It deletes, or writes over what is there: meaningful only for a tool that is not read-only. */
  destructive?: boolean;
  args: S;
  /** The alias of the org a call writes to, which `confirm` names again; nothing for one that writes nothing. */
  writesTo?: (args: z.output<S>) => string | undefined;
  /** What a call that writes does, as its refusal for want of `confirm` says it. */
  writes?: string;
  /** Where the person using the agent reads what a write would do, before agreeing to it. */
  readFirst?: string;
  /** The flags its script's lines name that this tool takes as parameters. */
  flags?: Readonly<Record<string, string>>;
  /** What an exit code of its script means for this tool, where it is not what it means for all. */
  exits?: Readonly<Partial<Record<number, string>>>;
  /** Lines said after the script's own, from what it answered. */
  after?: (args: z.output<S>, answer: unknown) => string[];
  run: (args: z.output<S>) => Run;
}

/** A tool, its arguments read: what a call of it runs, and what it must be confirmed with. */
interface Call {
  writesTo?: string;
  confirm?: string;
  run: Run;
  after: (answer: unknown) => string[];
}

/** A tool as this server serves it. */
interface ServedTool {
  definition: ToolDefinition;
  writes?: string;
  readFirst?: string;
  flags: Readonly<Record<string, string>>;
  exits: Readonly<Partial<Record<number, string>>>;
  read: (raw: Record<string, unknown>) => { call: Call } | { refusal: string };
}

/**
 * The input schema `tools/list` gives a tool, from the arguments it reads.
 * Without `$schema`: the protocol reads such a schema as JSON Schema 2020-12,
 * and a client of an earlier revision as its own default draft, which agree on
 * every keyword these use.
 */
function inputSchemaOf(args: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(args) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** A tool, served. */
function tool<S extends z.ZodType<Record<string, unknown>>>(spec: ToolSpec<S>): ServedTool {
  return {
    definition: {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: inputSchemaOf(spec.args),
      annotations: {
        title: spec.title,
        readOnlyHint: spec.readOnly,
        ...(spec.readOnly ? {} : { destructiveHint: spec.destructive === true }),
      },
    },
    ...(spec.writes !== undefined ? { writes: spec.writes } : {}),
    ...(spec.readFirst !== undefined ? { readFirst: spec.readFirst } : {}),
    flags: spec.flags ?? {},
    exits: spec.exits ?? {},
    read: (raw) => {
      const parsed = spec.args.safeParse(raw);
      if (!parsed.success) {
        return {
          refusal: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
            .join('; '),
        };
      }
      const args = parsed.data;
      const writesTo = spec.writesTo?.(args);
      const confirm = (args as { confirm?: unknown }).confirm;
      return {
        call: {
          ...(writesTo !== undefined ? { writesTo } : {}),
          ...(typeof confirm === 'string' ? { confirm } : {}),
          run: spec.run(args),
          after: (answer) => spec.after?.(args, answer) ?? [],
        },
      };
    },
  };
}

/**
 * A value set on a script's line after its flag. One that starts with `-`
 * would be read by the script as a flag, so it is refused here first.
 */
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,254}$/;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ON_A_LINE = /^[^-\r\n][^\r\n]*$/;
/** A resource of a `sandforge.yaml`, as the file names it (`envNameSchema`). */
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

const alias = (of: string) =>
  z
    .string()
    .regex(ALIAS, 'an sf CLI alias, or the username it stands for, not starting with "-"')
    .describe(of);
const confirmOf = (of: string) =>
  z
    .string()
    .max(255)
    .describe(
      `The alias of ${of} again, exactly as given: the person using you agrees to this write. ` +
        'Without it, the call is refused before anything is read.',
    );
const checkpointRef = (of: string) =>
  z.string().min(1).max(200).regex(ON_A_LINE, 'one line, not starting with "-"').describe(of);
const acceptance = (of: string) => z.boolean().optional().describe(of);
/** The objects of a checkpoint a rewind, or its preview, is limited to. */
const rewindObjects = () =>
  z
    .array(z.string().regex(API_NAME, 'an object API name'))
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Limit the rewind to these objects of the checkpoint, by API name (default: every ' +
        'object). What they depend on is never added: the answer names it.',
    );
const envFile = () =>
  z
    .string()
    .min(1)
    .max(4096)
    .regex(ON_A_LINE, 'one line, not starting with "-"')
    .describe(
      'The sandforge.yaml, by its path; a relative path is read from where the server was ' +
        'started.',
    );

/** The alias `confirm` must name for a call of `tool` to `org`, and why, as its refusal says it. */
export function confirmRefusal(
  served: Pick<ServedTool, 'definition' | 'writes' | 'readFirst'>,
  org: string,
  given: string | undefined,
): string {
  const asked =
    given === undefined
      ? 'gives no confirm'
      : `gives confirm "${given}", which is not "${org}", the alias of the org it writes to`;
  return (
    `${served.definition.name} writes to ${org}: it ${served.writes ?? 'writes to the org'}. ` +
    `This call ${asked}. ` +
    (served.readFirst !== undefined ? `Before it, ${served.readFirst}. ` : '') +
    `Give confirm: "${org}" once the person using you has agreed to this write. Refused: ` +
    'nothing was read or written.'
  );
}

/** The run a summary or a journal names, which `run_remove` takes back from. */
function removalHint(module: 'seed' | 'forge', answer: unknown): string[] {
  if (typeof answer !== 'object' || answer === null) return [];
  const { runFile, journal } = answer as { runFile?: unknown; journal?: unknown };
  const run = module === 'seed' ? runFile : journal;
  return typeof run === 'string'
    ? [`run_remove with module "${module}" and run "${run}" takes this run back.`]
    : [];
}

/** The scripts whose removal `run_remove` runs, by module. */
const REMOVAL_SCRIPT: Readonly<Record<'seed' | 'forge' | 'sync', Script>> = {
  seed: 'sandforge-seed',
  forge: 'sandforge-clone',
  sync: 'sandforge-sync',
};

/** The tools, in the order `tools/list` gives them. */
export const TOOLS: readonly ServedTool[] = [
  tool({
    name: 'seed_templates',
    title: 'Seed templates',
    description:
      "The built-in Seed templates, as the Seed page's gallery lists them: id, name, what it " +
      'is for, and the records each object gets at most. The first is the one a new Developer ' +
      'Edition holds whole. seed_run takes the id. Reads this checkout alone.',
    readOnly: true,
    args: z.strictObject({}),
    run: () => ({ local: seedTemplates }),
  }),
  tool({
    name: 'seed_run',
    title: 'Seed an org',
    description:
      'Fill an org with records, from a Seed template (template, an id seed_templates gives) or ' +
      'with generated rows (objects), as sandforge-seed --json does. Run it with dryRun: true ' +
      'first: it reads the org and writes nothing, and says what a real run would meet — the data ' +
      "storage it takes, the emails the org's automation would send, what runs as the records are " +
      'created. dryRun: false writes, a production org refused, and needs confirm. The answer ' +
      'names the run file, which run_remove with module "seed" takes the run back from.',
    readOnly: false,
    destructive: false,
    args: z.strictObject({
      org: alias('The org to fill: its sf CLI alias.'),
      template: z
        .string()
        .regex(TEMPLATE_ID, 'a template id, as seed_templates gives them')
        .optional()
        .describe('A built-in template, by the id seed_templates gives; or give objects.'),
      objects: z
        .array(
          z.strictObject({
            objectApiName: z.string().regex(API_NAME, 'an object API name'),
            count: z.number().int().min(1).max(100_000),
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Objects and how many records each gets, in insert order, their fields drawn by the ' +
            'faker; or give template.',
        ),
      dryRun: z
        .boolean()
        .describe('true: read the org and say what a run would do, writing nothing.'),
      confirm: confirmOf('org').optional(),
    }),
    writesTo: (args) => (args.dryRun ? undefined : args.org),
    writes: 'creates the records of the seed in it',
    readFirst: 'a dry run of the same seed says what it would write and meet',
    after: (args, answer) => (args.dryRun ? [] : removalHint('seed', answer)),
    run: (args) => ({
      script: 'sandforge-seed',
      args: [
        '--target',
        args.org,
        ...(args.template !== undefined ? ['--template', args.template] : []),
        ...(args.objects ?? []).flatMap((o) => ['--object', `${o.objectApiName}:${o.count}`]),
        ...(args.dryRun ? ['--dry-run'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'clone_record',
    title: 'Clone a record (Forge)',
    description:
      'Clone one record from source into target with the records it needs and the ones that ' +
      "hang from it, as Forge's record clone and sandforge-clone --record --json do. Run it with " +
      'dryRun: true first: it reads both orgs, counts what it would write and says what would ' +
      "stop a real run — the target's automation, its data storage, the emails its flows send — " +
      'and writes nothing. dryRun: false writes into target, a sandbox or a Developer Edition ' +
      'only, and needs confirm, the alias of target. acceptAutomation lets it write although the ' +
      'target runs automation as the records go in. The answer names the run journal, which ' +
      'run_remove with module "forge" takes the run back from.',
    readOnly: false,
    destructive: false,
    args: z.strictObject({
      source: alias('The org to read from: its sf CLI alias.'),
      target: alias('The org to write into: its sf CLI alias.'),
      recordId: z
        .string()
        .regex(RECORD_ID, 'a 15- or 18-character Salesforce record id')
        .describe('The record to clone, in source.'),
      depth: z
        .union([z.enum(['direct', 'full']), z.number().int().min(1).max(10)])
        .optional()
        .describe(
          'How far from the record discovery goes: "direct", "full", or a number of hops ' +
            '(default 5).',
        ),
      maxNodes: z
        .number()
        .int()
        .min(10)
        .max(500)
        .optional()
        .describe('How many objects discovery may reach (default 50).'),
      dryRun: z
        .boolean()
        .describe('true: read both orgs and say what a clone would do, writing nothing.'),
      confirm: confirmOf('target').optional(),
      acceptAutomation: acceptance(
        'Write although the target runs flows, Apex triggers, processes or workflow rules as the ' +
          'records go in, or would not say what it runs: only once the person using you has ' +
          'accepted what the dry run named.',
      ),
    }),
    writesTo: (args) => (args.dryRun ? undefined : args.target),
    writes: 'creates the records of the clone in it',
    readFirst: 'a dry run of the same clone says what it would write and meet',
    flags: { '--accept-automation': 'acceptAutomation' },
    after: (args, answer) => (args.dryRun ? [] : removalHint('forge', answer)),
    run: (args) => ({
      script: 'sandforge-clone',
      args: [
        '--record',
        args.recordId,
        '--source',
        args.source,
        '--target',
        args.target,
        ...(args.depth === undefined
          ? []
          : typeof args.depth === 'number'
            ? ['--depth', 'custom', '--custom-depth', String(args.depth)]
            : ['--depth', args.depth]),
        ...(args.maxNodes !== undefined ? ['--max-nodes', String(args.maxNodes)] : []),
        ...(args.dryRun ? ['--dry-run'] : []),
        ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'run_remove',
    title: "Remove a run's records",
    description:
      'Delete from org, into its recycle bin, what one run of Seed (module "seed"), Forge ' +
      '(module "forge") or Sync (module "sync") created, as that script\'s --remove --json does; ' +
      'a Sync run also gives the records it wrote over their values back. run is the summary ' +
      "file the run's --json was saved to, its run file or journal, or, for Seed and Sync, its " +
      'run id. Records changed since the run are kept. A production org is refused. Needs ' +
      'confirm, the alias of org. acceptAutomation lets it delete although the org runs ' +
      'automation as the records go.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      module: z.enum(['seed', 'forge', 'sync']).describe('Which module made the run.'),
      org: alias('The org the run wrote to: its sf CLI alias.'),
      run: z
        .string()
        .min(1)
        .max(4096)
        .regex(ON_A_LINE, 'one line, not starting with "-"')
        .describe(
          "The run's summary file, its run file or journal, or (Seed, Sync) its run id; a " +
            'relative path is read from where the server was started.',
        ),
      confirm: confirmOf('org').optional(),
      acceptAutomation: acceptance(
        'Delete although the org runs flows, Apex triggers, processes or workflow rules as the ' +
          'records go, or would not say what it runs: only once the person using you has ' +
          'accepted it.',
      ),
    }),
    writesTo: (args) => args.org,
    writes: 'deletes the records the run created, into the recycle bin',
    flags: { '--accept-automation': 'acceptAutomation' },
    run: (args) => ({
      script: REMOVAL_SCRIPT[args.module],
      args: [
        '--remove',
        args.run,
        '--target',
        args.org,
        ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'checkpoint_list',
    title: 'List checkpoints',
    description:
      'The checkpoints of org kept on this machine, newest first, with what a rewind and an ' +
      'undo can still reach. Reads this machine alone, and never contacts an org. Named org ' +
      "only: the other orgs' names and aliases never reach the agent.",
    readOnly: true,
    args: z.strictObject({
      org: alias('The org, by its sf CLI alias: its checkpoints alone.'),
    }),
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: ['list', '--org', args.org, '--json'],
    }),
  }),
  tool({
    name: 'checkpoint_preview',
    title: 'Preview a rewind',
    description:
      'What a rewind of org to a checkpoint would do: the records it would delete, give back ' +
      'and bring back, who last changed them, what the org runs as the rewind writes, the ' +
      'emails and API requests it takes, what neither a rewind nor its undo can take back, and ' +
      'the refusal a rewind would meet now. Given objects, those of a rewind limited to them, ' +
      'with what it would leave of them and the objects it needs added. Reads the org, writes ' +
      'nothing.',
    readOnly: true,
    args: z.strictObject({
      org: alias('The org: its sf CLI alias.'),
      checkpoint: checkpointRef(
        'A checkpoint of it: its id, its name, or latest (the default).',
      ).optional(),
      objects: rewindObjects(),
    }),
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: [
        'preview',
        '--org',
        args.org,
        '--checkpoint',
        args.checkpoint ?? 'latest',
        ...(args.objects ?? []).flatMap((object) => ['--object', object]),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'checkpoint_take',
    title: 'Take a checkpoint',
    description:
      "Read org's records and keep them on this machine as a checkpoint, to rewind the org to " +
      'later: every object people work in, or the objects named. estimate: true says the ' +
      'records, API requests, time and disk it would take, and keeps nothing. It writes nothing ' +
      "to the org; the checkpoint holds the records' values unencrypted, readable by this " +
      "machine's user alone. A production org is refused.",
    readOnly: false,
    destructive: false,
    args: z.strictObject({
      org: alias('The org: its sf CLI alias.'),
      name: z
        .string()
        .min(1)
        .max(200)
        .regex(ON_A_LINE, 'one line, not starting with "-"')
        .optional()
        .describe('What it is called (default: the date and time).'),
      objects: z
        .array(z.string().regex(API_NAME, 'an object API name'))
        .min(1)
        .max(500)
        .optional()
        .describe('The objects to keep, by API name (default: every object people work in).'),
      estimate: z
        .boolean()
        .optional()
        .describe('true: say what it would take, then stop, keeping nothing.'),
    }),
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: [
        'take',
        '--org',
        args.org,
        ...(args.name !== undefined ? ['--name', args.name] : []),
        ...(args.objects ?? []).flatMap((object) => ['--object', object]),
        ...(args.estimate === true ? ['--estimate'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'checkpoint_rewind',
    title: 'Rewind an org',
    description:
      'Return org to a checkpoint: delete the records created since, give the records changed ' +
      'since their values back and bring back from the recycle bin the records deleted since — ' +
      'whoever made those changes — then read the org again. It rewinds from its own preview, ' +
      'said first in its answer with who last changed what; the answer says what Undo could not ' +
      'bring back, and checkpoint_undo takes the rewind back. Needs confirm, the alias of org: ' +
      'checkpoint_preview first. Refused without acceptAutomation when the org runs automation ' +
      'as the rewind writes, without acceptNoUndo when Undo could not bring back records it ' +
      'deletes, without acceptRecreate when records no longer in the recycle bin would be made ' +
      'again with new Ids, without acceptUnseen when, for a user without View All Data and ' +
      'Modify All Data, what it deletes takes along records the user is not proven to see. ' +
      'Given objects, it rewinds those alone, never adding what they depend on: its answer names ' +
      'what it left of them, the objects to add, and what still differs in the others. A ' +
      'production org is refused.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      org: alias('The org: its sf CLI alias.'),
      checkpoint: checkpointRef(
        'The checkpoint: its id or its name. latest is refused: one taken since would be the ' +
          'one the rewind returns to.',
      ),
      confirm: confirmOf('org').optional(),
      acceptAutomation: acceptance(
        'Rewind although the org runs flows, Apex triggers, processes or workflow rules as ' +
          'records are updated, deleted or brought back, or would not say what it runs.',
      ),
      acceptNoUndo: acceptance(
        'Rewind although Undo could not bring back some records it deletes (objects Salesforce ' +
          'undeletes only with their parent).',
      ),
      acceptRecreate: acceptance(
        'Make again, with new Ids, the records deleted since that the recycle bin no longer ' +
          'gives back: what outside Salesforce names their old Ids no longer finds them.',
      ),
      acceptOutside: acceptance(
        'For a checkpoint of picked objects: also delete the records outside it created under ' +
          'records it deletes.',
      ),
      acceptUnseen: acceptance(
        'For a user without View All Data and Modify All Data: delete records whose delete ' +
          'takes along records of objects the user is not proven to see, tasks and events among ' +
          'them, which no count holds.',
      ),
      objects: rewindObjects(),
    }),
    writesTo: (args) => args.org,
    writes:
      'deletes the records created since the checkpoint, gives the records changed since ' +
      'their values back and brings back the records deleted since, whoever made those changes',
    readFirst: 'checkpoint_preview says what it would do, writing nothing',
    flags: {
      '--accept-automation': 'acceptAutomation',
      '--accept-no-undo': 'acceptNoUndo',
      '--accept-recreate': 'acceptRecreate',
      '--accept-outside': 'acceptOutside',
      '--accept-unseen': 'acceptUnseen',
    },
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: [
        'rewind',
        '--org',
        args.org,
        '--checkpoint',
        args.checkpoint,
        '--yes',
        ...(args.objects ?? []).flatMap((object) => ['--object', object]),
        ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
        ...(args.acceptNoUndo === true ? ['--accept-no-undo'] : []),
        ...(args.acceptRecreate === true ? ['--accept-recreate'] : []),
        ...(args.acceptOutside === true ? ['--accept-outside'] : []),
        ...(args.acceptUnseen === true ? ['--accept-unseen'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'checkpoint_undo',
    title: 'Undo a rewind',
    description:
      "Take back org's last rewind to a checkpoint: bring back what it deleted, give back what " +
      'it wrote over, send back to the recycle bin what it brought back; what anyone changed ' +
      'since the rewind stays, and is said. Needs confirm, the alias of org. acceptAutomation as ' +
      'for checkpoint_rewind.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      org: alias('The org: its sf CLI alias.'),
      checkpoint: checkpointRef('The checkpoint the rewind went back to: its id or its name.'),
      confirm: confirmOf('org').optional(),
      acceptAutomation: acceptance(
        'Undo although the org runs flows, Apex triggers, processes or workflow rules as ' +
          'records are updated, deleted or brought back, or would not say what it runs.',
      ),
    }),
    writesTo: (args) => args.org,
    writes:
      'brings back what its last rewind deleted, gives back what it wrote over and sends back ' +
      'to the recycle bin what it brought back',
    readFirst: 'checkpoint_list says which rewind it would take back, and until when',
    flags: { '--accept-automation': 'acceptAutomation' },
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: [
        'undo',
        '--org',
        args.org,
        '--checkpoint',
        args.checkpoint,
        '--yes',
        ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'checkpoint_delete',
    title: 'Delete a checkpoint',
    description:
      'Delete a checkpoint of org from this machine: the org is not touched, and can no longer ' +
      'be rewound to it, nor its last rewind to it undone. Needs confirm, the alias of org.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      org: alias('The org: its sf CLI alias.'),
      checkpoint: checkpointRef('The checkpoint: its id or its name.'),
      confirm: confirmOf('org').optional(),
    }),
    writesTo: (args) => args.org,
    writes: 'deletes the checkpoint from this machine, and the org can no longer be rewound to it',
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: ['delete', '--org', args.org, '--checkpoint', args.checkpoint, '--yes', '--json'],
    }),
  }),
  tool({
    name: 'env_plan',
    title: 'Plan an environment',
    description:
      'What env_apply would do to org from a sandforge.yaml (file), as sandforge-env plan --json ' +
      'says it: per resource, create, keep, replace, delete, or why it is blocked; what an ' +
      'earlier apply left there and what changed since; per object the records it would write; ' +
      'the API requests, storage and emails it takes. Each resource is dry-run by its own ' +
      'script. Reads the org and the sources its resources clone from, writes nothing to an ' +
      'org. failOnDrift: true ends it exit 3 when the org no longer holds the environment as ' +
      'applied — records deleted or changed since.',
    readOnly: true,
    args: z.strictObject({
      file: envFile(),
      org: alias('The org to fill: its sf CLI alias.'),
      failOnDrift: z
        .boolean()
        .optional()
        .describe('true: exit 3 when records the environment holds were deleted or changed since.'),
    }),
    exits: {
      [PARTIAL_EXIT]:
        'drift: the org no longer holds the environment as applied, records deleted or changed ' +
        'since, each said above',
    },
    run: (args) => ({
      script: 'sandforge-env',
      args: [
        'plan',
        '--file',
        args.file,
        '--org',
        args.org,
        ...(args.failOnDrift === true ? ['--fail-on-drift'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'env_apply',
    title: 'Apply an environment',
    description:
      'Do to org what env_plan says, as sandforge-env apply --yes --json does: plans again, then ' +
      'creates what the file declares, replaces what it is told to (replace: the resources, by ' +
      'name) and deletes the resources the file no longer holds, each by its own script, into ' +
      'the state kept on this machine; applied again, it writes nothing. A production org is ' +
      'refused, and a sandbox the file does not list. Needs confirm, the alias of org: env_plan ' +
      'first. acceptNoState lets it apply to an org this machine has no state of, where records ' +
      "an earlier apply left would be created twice. A resource's accept: { automation: true } " +
      'in the file is what lets its runs be taken back although the org runs automation. The ' +
      'answer ends with the env_destroy call that takes the environment back.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      file: envFile(),
      org: alias('The org to fill: its sf CLI alias.'),
      confirm: confirmOf('org').optional(),
      replace: z
        .array(z.string().regex(RESOURCE_NAME, 'a resource of the file, by its name'))
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Resources to replace although kept or drifted, by their names in the file: their ' +
            'earlier runs are taken back, then run again.',
        ),
      acceptNoState: acceptance(
        'Apply to a Developer Edition or a sandbox this machine has no state of: records an ' +
          'earlier apply left there would be created twice. Only once the person using you has ' +
          'accepted it.',
      ),
    }),
    writesTo: (args) => args.org,
    writes:
      'creates, replaces and deletes the resources of the file there as its plan says, taking ' +
      'back the earlier runs a replace or a delete takes back',
    readFirst: 'env_plan of the same file says what it would do, writing nothing',
    flags: { '--accept-no-state': 'acceptNoState' },
    after: (args) => [
      `env_destroy with file "${args.file}" and org "${args.org}" takes this environment back.`,
    ],
    run: (args) => ({
      script: 'sandforge-env',
      args: [
        'apply',
        '--file',
        args.file,
        '--org',
        args.org,
        ...(args.replace ?? []).flatMap((name) => ['--replace', name]),
        ...(args.acceptNoState === true ? ['--accept-no-state'] : []),
        '--yes',
        '--json',
      ],
    }),
  }),
  tool({
    name: 'env_destroy',
    title: 'Destroy an environment',
    description:
      'Take back from org what env_apply created there from file, the last resource first, ' +
      'into its recycle bin, as sandforge-env destroy --yes --json does; what it cannot take ' +
      'back is named, with why. Records changed since the apply are kept unless ' +
      'includeChanged: on a shared sandbox, a colleague’s work. A production org is refused. ' +
      'Needs confirm, the alias of org. It takes back by removal alone: no rewind to a ' +
      'checkpoint.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      file: envFile(),
      org: alias('The org the environment was applied to: its sf CLI alias.'),
      confirm: confirmOf('org').optional(),
      includeChanged: acceptance(
        'Take also the records changed since the apply, and what was created under them since: ' +
          "on a shared sandbox, others' work. Only once the person using you has accepted it.",
      ),
    }),
    writesTo: (args) => args.org,
    writes:
      'deletes the records its applies created, into the recycle bin, the last resource first',
    readFirst:
      'env_plan of the same file says what the org holds of the environment and what changed since',
    flags: { '--include-changed': 'includeChanged' },
    run: (args) => ({
      script: 'sandforge-env',
      args: [
        'destroy',
        '--file',
        args.file,
        '--org',
        args.org,
        ...(args.includeChanged === true ? ['--include-changed'] : []),
        '--yes',
        '--json',
      ],
    }),
  }),
];

const TOOLS_BY_NAME: ReadonlyMap<string, ServedTool> = new Map(
  TOOLS.map((served) => [served.definition.name, served]),
);

/**
 * The built-in templates, as the gallery lists them. The names and the
 * descriptions are keys of the webview's catalogue, which the seed script
 * reads them in English from: the lookup is that script's own.
 */
async function seedTemplates(): Promise<{ text: string; structured: Record<string, unknown> }> {
  const { templateDisplayName } = await import('./sandforge-seed.js');
  const templates = PREBUILT_SEED_TEMPLATES.map((template) => {
    const objects = template.objects.map((object) => ({
      objectApiName: object.objectApiName,
      records: object.recordCount,
    }));
    return {
      id: template.id,
      name: templateDisplayName(template),
      description: templateDisplayName({ name: template.description }),
      objects,
      records: objects.reduce((total, object) => total + object.records, 0),
    };
  });
  return {
    text: templates
      .map(
        (t) =>
          `${t.id} — ${t.name}: ${t.records} records at most in ${t.objects.length} objects ` +
          `(${t.objects.map((o) => `${o.objectApiName} ${o.records}`).join(', ')})`,
      )
      .join('\n'),
    structured: { templates },
  };
}

// ─── What a call answers ─────────────────────────────────────────────────────

/** A `tools/call` result, before the revision's fields are put on it. */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** A call refused before anything ran, as the scripts' own refusals are shaped. */
function refused(code: string, message: string): ToolResult {
  const structured = { refusal: { code, message } };
  return {
    content: [
      { type: 'text', text: message },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    isError: true,
  };
}

/** What each exit code of the scripts means (`exitCodes.ts`), in a few words. */
export function exitWords(code: number): string {
  switch (code) {
    case DONE_EXIT:
      return 'done';
    case FAILED_EXIT:
      return 'refused before it wrote, could not start, or did nothing but fail';
    case NO_TERMINAL_EXIT:
      return (
        'a request the script could not take, or a question for the person using you: nothing ' +
        'was written'
      );
    case PARTIAL_EXIT:
      return 'partial: records were left, refused or not checked, each said with why';
    case UNSTABLE_EXIT:
      return 'unstable: someone else wrote to the records meanwhile';
    default: {
      const signal = STOP_SIGNALS.find((each) => stopExitCode(each) === code);
      return signal !== undefined
        ? `stopped by ${signal} before it was through`
        : 'ended on an error';
    }
  }
}

/** A run that is not a failure: done, partial or unstable, each said in its answer. */
const ANSWERED: ReadonlySet<number> = new Set([DONE_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT]);

/** What the prompt says when no terminal can answer its question (`prompt.ts`). */
const NO_TERMINAL = 'no terminal to answer';

/** Whether a text names a flag (`--accept-automation`: letters and hyphens), as a word of its own. */
const names = (text: string, flag: string): boolean =>
  new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);

/** A script's line as a person would type it. */
export function commandText(script: Script, args: readonly string[]): string {
  const quoted = args.map((arg) =>
    /^[\w.@:+/=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`,
  );
  return ['pnpm exec tsx', `packages/extension/cli/${script}.ts`, ...quoted].join(' ');
}

/** The JSON a script answered on stdout, or nothing when it printed none. */
function answerOf(stdout: string): unknown {
  const text = stdout.trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A script's run as the call's result: its JSON as `answer`, beside its exit
 * code; its lines, then what the server adds to them — that a question it
 * asked is the person's to answer, which of its flags are this tool's
 * parameters, how to take the run back.
 */
export function resultOf(
  served: Pick<ServedTool, 'flags'> & Partial<Pick<ServedTool, 'exits'>>,
  run: { script: Script; args: readonly string[] },
  ran: CommandRun,
  after: (answer: unknown) => string[] = () => [],
): ToolResult {
  const answer = answerOf(ran.stdout);
  const lines = [
    `ran: ${commandText(run.script, run.args)}`,
    `exit ${ran.code}: ${served.exits?.[ran.code] ?? exitWords(ran.code)}`,
  ];
  const said = ran.stderr.trimEnd();
  if (said !== '') lines.push('', said);
  if (answer === undefined && ran.stdout.trim() !== '') lines.push('', ran.stdout.trimEnd());
  const added: string[] = [];
  if (ran.code === NO_TERMINAL_EXIT && ran.stderr.includes(NO_TERMINAL)) {
    added.push(
      'The script asked the question above and had no terminal to answer it on, so it stopped ' +
        'having written nothing. It is a question for the person using you: no parameter of this ' +
        'tool answers it.',
    );
  }
  const text = `${ran.stderr}\n${ran.stdout}`;
  for (const [flag, param] of Object.entries(served.flags)) {
    if (!names(text, flag)) continue;
    added.push(
      `${flag}, named above, is this tool's ${param}: true. Give it only once the person using ` +
        'you has accepted what it lets through.',
    );
  }
  if (ANSWERED.has(ran.code)) added.push(...after(answer));
  if (added.length > 0) lines.push('', ...added);
  const structured: Record<string, unknown> = {
    exitCode: ran.code,
    ...(answer !== undefined ? { answer } : {}),
  };
  return {
    content: [
      { type: 'text', text: lines.join('\n') },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    isError: !ANSWERED.has(ran.code),
  };
}

// ─── Serving ─────────────────────────────────────────────────────────────────

type RequestId = string | number;

/** What a request is answered with, before its id is put on it; nothing for one cancelled. */
type Outcome =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } }
  | undefined;

/** How a request was sent: with its version in `_meta`, or after the handshake. */
type Era = 'perRequest' | 'handshake';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));

export interface ServeOptions {
  /** Where the client's messages come from, one a line. */
  input: Readable;
  /** Writes one line for the client: a protocol message, and nothing else ever. */
  send: (line: string) => void;
  /** Runs a script; the product's own unless a test gives another. */
  runCommand?: CommandRunner;
  /** A line for whoever reads stderr. */
  log?: (line: string) => void;
}

export interface Serving {
  /** Settles once the input has ended and every call under way with it. */
  done: Promise<void>;
  /** Stops every call under way, as Ctrl-C stops a script, and settles once they have ended. */
  stop: () => Promise<void>;
}

/**
 * Serve the tools to the client whose messages `input` carries. Each request
 * is answered as it ends, calls running side by side; a call the client
 * cancels is stopped as Ctrl-C stops its script, and gets no answer. Once the
 * input ends, the calls still running are stopped the same way.
 */
export function serve(options: ServeOptions): Serving {
  const runCommand = options.runCommand ?? spawnCommand;
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  /** The revision `initialize` agreed on, for the requests that do not name one. */
  let handshake: string | undefined;
  const running = new Map<RequestId, AbortController>();
  const cancelled = new Set<RequestId>();
  const pending = new Set<Promise<void>>();

  const send = (message: Record<string, unknown>): void => {
    options.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
  };

  /** A result as the revision of its request lays it out. */
  const completed = (era: Era, result: Record<string, unknown>): Record<string, unknown> =>
    era === 'perRequest'
      ? { resultType: 'complete', ...result, _meta: { [META.serverInfo]: SERVER_INFO } }
      : result;

  const initialize = (params: unknown): Outcome => {
    const asked = isObject(params) ? params.protocolVersion : undefined;
    if (typeof asked !== 'string') {
      return {
        error: {
          code: ERROR.invalidParams,
          message: 'initialize names the protocol version it asks for in protocolVersion.',
        },
      };
    }
    // The version asked for when it is served, else the newest served.
    const agreed = HANDSHAKE_VERSIONS.includes(asked) ? asked : HANDSHAKE_VERSIONS[0];
    handshake = agreed;
    log(
      `sandforge-mcp: ${asked === agreed ? 'agreed on' : `asked for ${asked}, offered`} ${agreed}`,
    );
    return {
      result: {
        protocolVersion: agreed,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    };
  };

  const callTool = async (id: RequestId, params: unknown, era: Era): Promise<Outcome> => {
    if (!isObject(params) || typeof params.name !== 'string') {
      return {
        error: { code: ERROR.invalidParams, message: 'tools/call names its tool in name.' },
      };
    }
    const served = TOOLS_BY_NAME.get(params.name);
    if (!served) {
      return { error: { code: ERROR.invalidParams, message: `Unknown tool: ${params.name}` } };
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      return {
        error: {
          code: ERROR.invalidParams,
          message: 'tools/call takes its arguments as an object.',
        },
      };
    }
    const read = served.read(params.arguments ?? {});
    if ('refusal' in read) {
      return {
        result: completed(era, {
          ...refused('ARGUMENTS', `${served.definition.name}: ${read.refusal}. Nothing was run.`),
        }),
      };
    }
    const { call } = read;
    if (call.writesTo !== undefined && call.confirm !== call.writesTo) {
      return {
        result: completed(era, {
          ...refused('CONFIRM', confirmRefusal(served, call.writesTo, call.confirm)),
        }),
      };
    }
    if ('local' in call.run) {
      const answered = await call.run.local();
      return {
        result: completed(era, {
          content: [
            { type: 'text', text: answered.text },
            { type: 'text', text: JSON.stringify(answered.structured) },
          ],
          structuredContent: answered.structured,
          isError: false,
        }),
      };
    }
    const { script, args } = call.run;
    const controller = new AbortController();
    running.set(id, controller);
    try {
      log(`sandforge-mcp: ${served.definition.name} runs ${commandText(script, args)}`);
      let ran: CommandRun;
      try {
        ran = await runCommand(script, args, controller.signal);
      } catch (err: unknown) {
        ran = {
          code: FAILED_EXIT,
          stdout: '',
          stderr: `${script} could not be started: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (cancelled.has(id)) return undefined;
      return { result: completed(era, { ...resultOf(served, call.run, ran, call.after) }) };
    } finally {
      running.delete(id);
      cancelled.delete(id);
    }
  };

  const handle = async (id: RequestId, method: string, params: unknown): Promise<Outcome> => {
    if (method === 'initialize') return initialize(params);
    const meta = isObject(params) && isObject(params._meta) ? params._meta : undefined;
    const asked = meta?.[META.version];
    let era: Era;
    if (asked !== undefined) {
      // Only the revision a request can name is said to be served: the
      // earlier ones are reached by initialize, and a client told of one
      // here would name it in its next request's _meta, refused again.
      if (asked !== PROTOCOL_VERSION) {
        return {
          error: {
            code: ERROR.unsupportedVersion,
            message: 'Unsupported protocol version',
            data: { supported: [PROTOCOL_VERSION], requested: String(asked) },
          },
        };
      }
      if (!isObject(meta?.[META.capabilities])) {
        return {
          error: {
            code: ERROR.invalidParams,
            message: `A request of ${PROTOCOL_VERSION} names its client's capabilities in _meta["${META.capabilities}"].`,
          },
        };
      }
      era = 'perRequest';
    } else if (method === 'ping') {
      // Answered before the handshake too, as the earlier revisions allow.
      return { result: {} };
    } else if (handshake !== undefined) {
      era = 'handshake';
    } else {
      return {
        error: {
          code: ERROR.invalidParams,
          message:
            `Name the protocol version in _meta["${META.version}"] (${PROTOCOL_VERSION}), or ` +
            `open with initialize (${HANDSHAKE_VERSIONS.join(', ')}).`,
        },
      };
    }
    switch (method) {
      case 'server/discover':
        if (era !== 'perRequest') break;
        return {
          result: completed(era, {
            supportedVersions: [PROTOCOL_VERSION],
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
            ttlMs: TOOL_LIST_TTL_MS,
            cacheScope: 'public',
          }),
        };
      case 'ping':
        return { result: completed(era, {}) };
      case 'tools/list':
        return {
          result: completed(era, {
            tools: TOOLS.map((served) => served.definition),
            ...(era === 'perRequest' ? { ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'public' } : {}),
          }),
        };
      case 'tools/call':
        return callTool(id, params, era);
    }
    return {
      error: {
        code: ERROR.methodNotFound,
        message: `${method} is not a method of this server: it serves tools/list and tools/call.`,
      },
    };
  };

  const notified = (method: string, params: unknown): void => {
    if (method !== 'notifications/cancelled' || !isObject(params)) return;
    const { requestId } = params;
    if (!isRequestId(requestId)) return;
    const controller = running.get(requestId);
    if (!controller) return;
    cancelled.add(requestId);
    log(
      `sandforge-mcp: request ${String(requestId)} cancelled: its script is stopped as Ctrl-C stops it`,
    );
    controller.abort();
  };

  const receive = (line: string): void => {
    const text = line.trim();
    if (text === '') return;
    let message: unknown;
    try {
      message = JSON.parse(text) as unknown;
    } catch {
      send({ error: { code: ERROR.parse, message: 'Parse error: a line that is not JSON.' } });
      return;
    }
    if (Array.isArray(message)) {
      send({
        error: {
          code: ERROR.invalidRequest,
          message: 'A batch is not a message of this protocol: send one message a line.',
        },
      });
      return;
    }
    if (!isObject(message)) {
      send({ error: { code: ERROR.invalidRequest, message: 'A message is a JSON-RPC object.' } });
      return;
    }
    const { id, method, params } = message;
    // A response: this server sends no request, so none is waited for.
    if (method === undefined && ('result' in message || 'error' in message)) return;
    if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
      send({
        ...(isRequestId(id) ? { id } : {}),
        error: { code: ERROR.invalidRequest, message: 'A message has jsonrpc "2.0" and a method.' },
      });
      return;
    }
    if (id === undefined) {
      notified(method, params);
      return;
    }
    if (!isRequestId(id) || running.has(id)) {
      send({
        error: {
          code: ERROR.invalidRequest,
          message: isRequestId(id)
            ? `A request with the id ${String(id)} is still under way: give each its own.`
            : 'A request id is a string or a whole number.',
        },
      });
      return;
    }
    const answering = handle(id, method, params)
      .then((outcome) => {
        if (outcome !== undefined) send({ id, ...outcome });
      })
      .catch((err: unknown) => {
        send({
          id,
          error: {
            code: ERROR.internal,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      })
      .finally(() => {
        pending.delete(answering);
      });
    pending.add(answering);
  };

  const stop = async (): Promise<void> => {
    for (const controller of running.values()) controller.abort();
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  lines.on('line', receive);
  const done = new Promise<void>((resolve) => {
    lines.once('close', () => {
      void stop().then(resolve);
    });
  });
  return { done, stop };
}

/**
 * Keep `stdout` for the protocol: what anything else writes there — a
 * library's stray line, a `console.log` — goes to `stderr` instead, where it
 * breaks no message.
 *
 * @returns What writes one line on the real stdout.
 */
export function claimStdout(stdout: Writable, stderr: Writable): (line: string) => void {
  const write = stdout.write.bind(stdout);
  stdout.write = stderr.write.bind(stderr) as typeof stdout.write;
  return (line) => {
    write(`${line}\n`);
  };
}

const HELP = `sandforge-mcp — Seed, Forge's clone of a record, the removal of a run, Checkpoints and the
environments of a sandforge.yaml, as tools for an AI agent, over the Model Context Protocol on stdio.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-mcp.ts

  An MCP client starts it: it reads JSON-RPC messages on stdin, one a line, and answers on
  stdout; every other line goes to stderr. Run from the repository root of a checkout, after
  pnpm install and pnpm build:shared. In Claude Code, from there:
    claude mcp add sandforge -- pnpm exec tsx packages/extension/cli/sandforge-mcp.ts

Protocol: MCP ${PROTOCOL_VERSION}, each request naming it in _meta; and the initialize handshake of
${HANDSHAKE_VERSIONS.join(', ')}.

Tools: ${TOOLS.map((served) => served.definition.name).join(', ')}.
Each one but seed_templates runs the script of this folder that does the same, with --json, in a
process of its own, and answers with its JSON, its exit code and its lines: every guard of the
script holds. A tool that writes to an org needs confirm, the alias of that org exactly, or it is
refused before anything is read. A script that asks a question stops at it, having written
nothing, and the question comes back as the call's error.

Environment:
  SANDFORGE_JOURNAL_DIR=<dir>   where the scripts keep their run files, journals and
                                checkpoints (default: ~/.sandforge), as each script's --help says

  --help                        this text
`;

/** Serve on this process's own stdin and stdout until the client closes stdin. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  refuseUnreadArguments(args, { switches: [], values: [] });
  const send = claimStdout(process.stdout, process.stderr);
  const serving = serve({ input: process.stdin, send });
  // A client that went away reads no answer: the scripts still running are
  // stopped as Ctrl-C stops them, and the server ends.
  process.stdout.on('error', () => {
    void serving.stop().then(() => process.exit(0));
  });
  const release = onStopSignal((signal: StopSignal) => {
    void serving.stop().then(() => process.exit(stopExitCode(signal)));
  });
  process.stderr.write(
    `sandforge-mcp: ${TOOLS.length} tools on stdio, MCP ${PROTOCOL_VERSION} (and ` +
      `${HANDSHAKE_VERSIONS.join(', ')} by initialize)\n`,
  );
  await serving.done;
  release();
}

// Only when run as a script: importing the module must not start a server.
// It ends once its input has and nothing is left to run, its last answers
// written: an exit called on its heels could cut them short on a pipe.
if (/sandforge-mcp\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  holdOutputWhole();
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
