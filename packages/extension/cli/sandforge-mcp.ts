#!/usr/bin/env tsx
/**
 * sandforge-mcp — Seed, Forge's clone of a record, of the records a query
 * chooses or of the whole org, the removal of a run, the emptying of objects
 * or of a whole org, Checkpoints and their replay into another org, the
 * environments of a `sandforge.yaml` and the plan of an Automation pipeline
 * as tools an AI agent calls, over the Model Context Protocol on stdio.
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
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import {
  CHECKPOINT_BEFORE_RUN_KEEP_DAYS,
  FORGE_ROOTS_MAX,
  FORGE_SAMPLE_MAX_LAST_DAYS,
  FORGE_SAMPLE_MAX_ROOT_WHERE,
  FORGE_SAMPLE_MAX_STRATA,
  FORGE_SAMPLE_STRATUM_PATTERN,
  PREBUILT_SEED_TEMPLATES,
  REPLAY_MAX_RECORDS,
  SOQL_ROOT_ORDER_BY_MAX,
  checkpointIdSchema,
  forgeSampleStrataSchema,
  forgeSampleWindowBound,
  soqlOrderBySchema,
  soqlRootIssueWords,
  soqlRootQueryIssue,
  soqlWhereFragmentSchema,
} from '@sandforge/shared';
import { SF_ALIAS_RE, refuseUnreadArguments } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, UNSTABLE_EXIT } from './exitCodes.js';
import { NO_TERMINAL_EXIT } from './prompt.js';
import {
  spawnRunner,
  type CommandRun,
  type CommandRunner as RunnerOf,
  type RunOptions,
  type SpawnOptions,
} from './scriptRunner.js';
import { STOP_SIGNALS, onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { holdOutputWhole } from './wholeOutput.js';
import { commandOf, nameOf } from './invocation.js';
import { journalDirOf } from './journalDir.js';
import { CLONE_ORG_PLAN_RELAY, CLONE_ORG_RELAY } from './relayWords.js';
import {
  HOLD_SECONDS_VARIABLE,
  McpRuns,
  RUN_HANDLE,
  WAIT_SECONDS_MOST,
  holdMsOf,
  readRunSummary,
  runsDirOf,
  type McpRun,
  type RunOnDisk,
  type RunSummaryRead,
} from './mcpRuns.js';
import {
  PLAN_ID,
  addClonePlanRun,
  clonePlanRunLine,
  dryRunPlanOf,
  endClonePlanRun,
  keepClonePlan,
  markClonePlanDead,
  openClonePlan,
  readClonePlan,
  sweepClonePlans,
  type ClonePlanReceipt,
} from './mcpClonePlans.js';
import { makePrivateDir } from '../src/modules/checkpoint/OrgCheckpointStore.js';
import { parseArchiveKey } from '../src/modules/checkpoint/checkpointArchive.js';

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
  "SandForge's Seed, Forge's clone of a record, of the records a query chooses or of the whole " +
  'org, the removal of a run, the emptying of objects or of a whole org, Checkpoints and their ' +
  'replay into another org, the environments of a sandforge.yaml and the plan of an Automation ' +
  'pipeline, run from a ' +
  'checkout of its repository. Every org is named ' +
  'by its sf CLI alias, as `sf alias list` shows them. A tool that writes to an org takes ' +
  'confirm, the alias of that org exactly: give it only once the person using you has agreed ' +
  'to that write, after a dry run, a preview or a plan has said what it would do. The ' +
  'acceptances (acceptAutomation and the others) are theirs to give too. A production org is ' +
  "refused by every tool that writes to an org. Each answer carries the script's own JSON, its " +
  'exit code and its lines. A clone of the whole org, or of a sample of it that fits the ' +
  'target: clone_org_plan, show the person the question its plan comes back with, then ' +
  'clone_org with that plan and confirm; its personal fields are always anonymized. A call ' +
  `still running after ${Math.round(holdMsOf() / 1000)} seconds hands back a run: run_status ` +
  'follows it, run_stop stops it. pipeline_plan says what a run of a pipeline exported from the ' +
  'Automation page would do and refuse, writing nothing; no tool runs one: its run is the ' +
  `person's, on a terminal (${commandOf('pipeline')} run --file <file>). No tool clones whole ` +
  `tables (${commandOf('clone')} --object <ApiName> --where <condition>), nor compares two orgs ` +
  `(${commandOf('compare')}) or takes a DataOps snapshot (${commandOf('backup')}): give the ` +
  'person the command to run in a terminal, or a sandforge.yaml resource that env_plan and ' +
  'env_apply run.';

// ─── The tools ───────────────────────────────────────────────────────────────

/**
 * The most records `checkpoint_take` may be asked to hold: what a checkpoint
 * holds of one object, the bound the Checkpoints page holds its field to.
 */
const CHECKPOINT_MAX_TOTAL_MOST = 1_000_000;

/** The scripts of this folder a tool runs. */
export type Script =
  | 'sandforge-seed'
  | 'sandforge-clone'
  | 'sandforge-sync'
  | 'sandforge-checkpoint'
  | 'sandforge-empty'
  | 'sandforge-env'
  | 'sandforge-pipeline';

export type { CommandRun };

/**
 * Runs a script a tool runs, in a process of its own (`scriptRunner.ts`), and
 * settles once it has ended. The signal stops it as Ctrl-C stops it on a
 * terminal.
 */
export type CommandRunner = RunnerOf<Script>;

/**
 * How the server runs a tool's script: in a process of its own, told that
 * its lines are relayed by this server, whose reader cannot give the options
 * a script's own advice names — `run_remove` runs no sweep. Relayed as they
 * were, "--sweep takes them first" named a flag of no tool. Exported so it
 * can be tested.
 */
export function toolRunner(options: Omit<SpawnOptions, 'relayedBy'> = {}): CommandRunner {
  return spawnRunner({ ...options, relayedBy: 'sandforge mcp' });
}

const TOOL_RUNNER = toolRunner();

/**
 * What the server gives a tool beyond its arguments: where the scripts keep
 * what they write on this machine, the runs it handed back, its clock, and
 * how it runs a script of its own — the verification of a clone it ran.
 */
interface ToolContext {
  /** The folder the scripts keep their journals in (`journalDir.ts`). */
  journalDir: string;
  /** The runs of this server, those running and those handed back. */
  runs: McpRuns<ToolResult>;
  now: () => Date;
  log: (line: string) => void;
  /** Runs a script for the server itself, as a tool runs one. */
  runCommand: CommandRunner;
  /** Stops what the server runs for itself, once it ends. */
  stopping: AbortSignal;
  /** The answer a run of this server gives once it has ended, made once. */
  finalOf: (handle: string) => Promise<ToolResult> | undefined;
}

/** What a run of a script is told as it starts: its handle, and the summary file it may write. */
interface Launch {
  handle: string;
  /** Under the runs folder, named by its handle: a clone's `--summary`. */
  summary: string;
}

/** A call that runs a script, or one this server answers itself. */
type Run =
  | {
      script: Script;
      args: string[];
      /** The command its lines are relayed by, in place of `sandforge mcp`. */
      relayedBy?: string;
      /** What `run_status` follows it by, once it is handed back. */
      follow?: { plan?: string; summary?: string; expectedSeconds?: number };
    }
  | { local: (context: ToolContext) => Promise<ToolResult> };

/** A call refused by the server before any script runs, its code and its words. */
interface Refusal {
  code: string;
  message: string;
}

/** What the server reads before a call is confirmed: on disk, among its runs. */
type Prepared<P> = { prepared: P } | { refusal: Refusal };

/** What a run came to, as a tool settles its answer from it. */
interface Settling {
  ran: CommandRun;
  run: { script: Script; args: readonly string[] };
  launch: Launch;
  /** The answer as any tool gives it, which the tool settles from. */
  parts: ResultParts;
  context: ToolContext;
}

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
interface ToolSpec<S extends z.ZodType<Record<string, unknown>>, P = undefined> {
  name: string;
  title: string;
  description: string;
  /** It changes nothing, in any org or on this machine. */
  readOnly: boolean;
  /** It deletes, or writes over what is there: meaningful only for a tool that is not read-only. */
  destructive?: boolean;
  args: S;
  /**
   * A refusal of the arguments in this tool's own words, before they are
   * read: an argument the agent may well give that is no parameter, and why.
   */
  refuseFirst?: (raw: Record<string, unknown>) => string | undefined;
  /**
   * What a call reads before it is confirmed — a plan on disk, the runs under
   * way —, or the server's refusal of it, before any script runs.
   */
  prepare?: (args: z.output<S>, context: ToolContext) => Promise<Prepared<P>>;
  /** The alias of the org a call writes to, which `confirm` names again; nothing for one that writes nothing. */
  writesTo?: (args: z.output<S>, prepared: P) => string | undefined;
  /** What a call that writes does, as its refusal for want of `confirm` says it. */
  writes?: string;
  /** Where the person using the agent reads what a write would do, before agreeing to it. */
  readFirst?: string;
  /** The flags its script's lines name that this tool takes as parameters. */
  flags?: Readonly<Record<string, string>>;
  /**
   * The flags its script's lines name that this tool takes otherwise than as
   * a switch, or not at all, with what stands for each: the line the server
   * adds after "<flag>, named above,". A refusal of an environment's removal
   * said "Add --accept-automation", which no parameter of env_destroy takes:
   * the file's accept does. Given the script's lines, the words may read what
   * they gave the flag.
   */
  named?: Readonly<Record<string, NamedWords>>;
  /** What an exit code of its script means for this tool, where it is not what it means for all. */
  exits?: Readonly<Partial<Record<number, string>>>;
  /**
   * Lines said after the script's own, from what it answered: of a run that
   * went through, and of one stopped part way, whose answer names what it
   * wrote as much.
   */
  after?: (args: z.output<S>, answer: unknown) => string[];
  /** What a confirmed call keeps before its script starts. */
  beforeStart?: (
    args: z.output<S>,
    prepared: P,
    launch: Launch,
    context: ToolContext,
  ) => Promise<void>;
  run: (args: z.output<S>, prepared: P, launch: Launch) => Run;
  /** What the tool does once its script has ended, whatever its code, before it answers. */
  settle?: (args: z.output<S>, prepared: P, settling: Settling) => Promise<ResultParts>;
}

/**
 * What stands for a flag a script's lines name: the same words whatever they
 * gave it, or words read from those lines (the script's stderr and stdout).
 */
type NamedWords = string | ((said: string) => string);

/** A tool, its arguments read: what a call of it runs, and what it must be confirmed with. */
interface Call {
  writesTo?: string;
  confirm?: string;
  run: Run;
  after: (answer: unknown) => string[];
  beforeStart: () => Promise<void>;
  settle?: (settling: Settling) => Promise<ResultParts>;
}

/** A tool as this server serves it. */
interface ServedTool {
  definition: ToolDefinition;
  writes?: string;
  readFirst?: string;
  flags: Readonly<Record<string, string>>;
  named: Readonly<Record<string, NamedWords>>;
  exits: Readonly<Partial<Record<number, string>>>;
  read: (
    raw: Record<string, unknown>,
    context: ToolContext,
    launch: Launch,
  ) => Promise<{ call: Call } | { refusal: Refusal }>;
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
function tool<S extends z.ZodType<Record<string, unknown>>, P = undefined>(
  spec: ToolSpec<S, P>,
): ServedTool {
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
    named: spec.named ?? {},
    exits: spec.exits ?? {},
    read: async (raw, context, launch) => {
      const first = spec.refuseFirst?.(raw);
      if (first !== undefined) return { refusal: { code: 'ARGUMENTS', message: first } };
      const parsed = spec.args.safeParse(raw);
      if (!parsed.success) {
        return {
          refusal: {
            code: 'ARGUMENTS',
            message:
              `${spec.name}: ` +
              parsed.error.issues
                .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
                .join('; ') +
              '. Nothing was run.',
          },
        };
      }
      const args = parsed.data;
      let prepared: P;
      if (spec.prepare) {
        const read = await spec.prepare(args, context);
        if ('refusal' in read) return read;
        prepared = read.prepared;
      } else {
        prepared = undefined as P;
      }
      const writesTo = spec.writesTo?.(args, prepared);
      const confirm = (args as { confirm?: unknown }).confirm;
      const { beforeStart, settle } = spec;
      return {
        call: {
          ...(writesTo !== undefined ? { writesTo } : {}),
          ...(typeof confirm === 'string' ? { confirm } : {}),
          run: spec.run(args, prepared, launch),
          after: (answer) => spec.after?.(args, answer) ?? [],
          beforeStart: () => beforeStart?.(args, prepared, launch, context) ?? Promise.resolve(),
          ...(settle ? { settle: (settling: Settling) => settle(args, prepared, settling) } : {}),
        },
      };
    },
  };
}

/**
 * A value set on a script's line after its flag. One that starts with `-`
 * would be read by the script as a flag, so it is refused here first.
 */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ON_A_LINE = /^[^-\r\n][^\r\n]*$/;
/** A resource of a `sandforge.yaml`, as the file names it (`envNameSchema`). */
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

const alias = (of: string) =>
  z
    .string()
    .regex(SF_ALIAS_RE, 'an sf CLI alias, or the username it stands for, not starting with "-"')
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
/**
 * The checkpoint a run takes of what it writes before its first write, as its
 * script's `--checkpoint-first` takes it.
 */
const checkpointFirst = (run: string) =>
  z
    .strictObject({
      keepDays: z
        .number()
        .int()
        .min(CHECKPOINT_BEFORE_RUN_KEEP_DAYS.min)
        .max(CHECKPOINT_BEFORE_RUN_KEEP_DAYS.max)
        .optional()
        .describe('The days it is kept on this machine; 0 until it is deleted (default 7).'),
      excluded: z
        .array(z.string().regex(API_NAME, 'an object API name'))
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Objects to leave out of it, by API name, named in the answer: a rewind leaves their ' +
            'records as they are.',
        ),
    })
    .optional()
    .describe(
      `Before ${run}'s first write, take a checkpoint of each object it writes, and of each the ` +
        "target's flows that still run create as it writes them, held whole: {} takes it with " +
        'the defaults. Its cost is that of the tables, not of the records written, and its values ' +
        'stay unencrypted on this machine: give it only once the person using you has seen, in a ' +
        `dry run with it, what it would hold and cost. Refused, ${run} writes nothing; deleted ` +
        'again when it writes nothing.',
    );
/** A run's `checkpointFirst`, as its script's line takes it. */
function checkpointFirstLine(
  asked: { keepDays?: number | undefined; excluded?: string[] | undefined } | undefined,
): string[] {
  if (asked === undefined) return [];
  return [
    '--checkpoint-first',
    ...(asked.keepDays !== undefined ? ['--checkpoint-keep-days', String(asked.keepDays)] : []),
    ...(asked.excluded ?? []).flatMap((name) => ['--checkpoint-exclude-object', name]),
  ];
}
/**
 * A run's `muteAutomation`, as its script's `--mute-automation` takes it: a
 * seed and a clone named the flag in their refusals, and neither tool took it.
 */
const muteFor = (run: string) =>
  acceptance(
    `Keep quiet what the org runs as ${run} writes, through its own bypass: the permission ` +
      'sets holding it are assigned to the user it writes as, for the run alone, under a lease, ' +
      'and taken back as it ends; what no bypass keeps quiet still runs. A dry run with it says ' +
      'what it would assign, and assigns nothing. Refused on a production org and for a user ' +
      'who cannot assign permission sets. Only once the person using you has agreed to it.',
  );

/**
 * A rewind's or an undo's `muteAutomation`, as the script's `--mute-automation`
 * takes it: their refusal for the emails said "--mute-automation keeps quiet
 * …", and neither tool took it.
 */
const muteActFor = (act: string) =>
  acceptance(
    `Keep quiet what the org runs as ${act} writes, through its own bypass: the permission ` +
      `sets holding it are assigned to the user it writes as, for ${act} alone, under a lease, ` +
      'and taken back as it ends; what no bypass keeps quiet still needs acceptAutomation. ' +
      'Refused on a production org and for a user who cannot assign permission sets. Only ' +
      'once the person using you has agreed to it.',
  );

/**
 * What stands for `--accept-automation` for an environment tool: the file's
 * accept, per resource, where the repository's reviewers read it, which the
 * tool hands the resource's script; no parameter of the tool.
 */
function fileAcceptsAutomation(tool: string): string {
  return (
    `is no parameter of ${tool}: an environment's acceptance of automation is its file's. ` +
    'Write accept: { automation: true } on the resource whose run it names, in the file, once ' +
    `the person using you has accepted what fires, then call ${tool} again.`
  );
}

/** The flags a rewind's refusals name, and the parameters of checkpoint_rewind each stands for. */
const REWIND_FLAGS: Readonly<Record<string, string>> = {
  '--accept-automation': 'acceptAutomation',
  '--accept-emails': 'acceptEmails',
  '--mute-automation': 'muteAutomation',
  '--accept-no-undo': 'acceptNoUndo',
  '--accept-recreate': 'acceptRecreate',
  '--accept-outside': 'acceptOutside',
  '--accept-unseen': 'acceptUnseen',
};

/**
 * What stands, under checkpoint_preview, for each flag of the rewind it
 * previews: a parameter of checkpoint_rewind. Relayed bare, "give
 * --accept-recreate to rewind all the same" named a flag of no tool.
 */
const REWIND_FLAGS_OF_ITS_PREVIEW: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(REWIND_FLAGS).map(([flag, param]) => [
    flag,
    `is checkpoint_rewind's ${param}: true, on the rewind this preview is of. Give it only ` +
      'once the person using you has accepted what it lets through.',
  ]),
);

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
/** The run of an emptying: its id, as its journal names it. */
const EMPTY_RUN = /^em-\d{8}-\d{6}-[a-z0-9]{4}$/;

/** What an emptying empties: the objects named, or every object people work in, and how. */
const emptyScope = {
  objects: z
    .array(z.string().regex(API_NAME, 'an object API name'))
    .min(1)
    .max(500)
    .optional()
    .describe('Empty these objects, by API name: every record of each. Not with wholeOrg.'),
  wholeOrg: z
    .literal(true)
    .optional()
    .describe(
      'Empty every object people work in, less users, setup, Chatter, history, sharing, the ' +
        "org's flows, settings and definitions, and the standard price book. Not with objects.",
    ),
  excluded: z
    .array(z.string().regex(API_NAME, 'an object API name'))
    .min(1)
    .max(500)
    .optional()
    .describe('With wholeOrg: objects to leave out, by API name.'),
  customSettings: acceptance('With wholeOrg: empty the custom settings too.'),
  files: acceptance('With wholeOrg: empty the files and attachments too.'),
  managedPackages: acceptance('With wholeOrg: empty the objects of managed packages too.'),
  unrestorable: acceptance(
    'With wholeOrg: empty too, by passes of their own, the objects whose records Salesforce ' +
      'does not bring back from the recycle bin on their own. Only once the person using you ' +
      'has accepted that Undo cannot bring those back.',
  ),
  hardDelete: acceptance(
    'Delete for good, with what goes along: nothing goes to the recycle bin and no undo brings ' +
      'anything back. Needs the Bulk API Hard Delete permission of the user. Only once the ' +
      'person using you has accepted that nothing can be brought back.',
  ),
  checkpointFirst: acceptance(
    'Take a checkpoint of the objects emptied before the first delete, to rewind to.',
  ),
  acceptAutomation: acceptance(
    'Empty although the org runs flows, Apex triggers, processes or workflow rules as the ' +
      'records are deleted, or would not say what it runs.',
  ),
  acceptEmails: acceptance(
    'Empty although the org delivers every email what still runs as the records go sends, or ' +
      'would not say whether it does. acceptAutomation never stands for it. Only once the person ' +
      'using you has accepted that these emails go out.',
  ),
  muteAutomation: muteActFor('the emptying'),
  acceptNoUndo: acceptance(
    'Empty although some records go before a record they name, as Salesforce requires, so ' +
      'that Undo cannot bring them back once both have gone.',
  ),
  acceptPeopleActive: acceptance(
    'Empty although people other than the user changed records of these objects in the hour ' +
      "before the read, their work going with it: empty_preview says how many and each one's " +
      'last change. It covers those the preview named, and taking up a run, whoever. Only once ' +
      'the person using you has accepted that their work goes.',
  ),
};

/** One of objects, wholeOrg and resume: what an emptying acts on. */
function oneScope(args: { objects?: unknown; wholeOrg?: unknown; resume?: unknown }): boolean {
  const given = [args.objects, args.wholeOrg, args.resume].filter((each) => each !== undefined);
  return given.length === 1;
}

/** An emptying's scope and options, as its script's line takes them. */
function emptyScopeLine(args: {
  objects?: string[] | undefined;
  wholeOrg?: true | undefined;
  excluded?: string[] | undefined;
  customSettings?: boolean | undefined;
  files?: boolean | undefined;
  managedPackages?: boolean | undefined;
  unrestorable?: boolean | undefined;
  hardDelete?: boolean | undefined;
  checkpointFirst?: boolean | undefined;
  acceptNoUndo?: boolean | undefined;
}): string[] {
  return [
    ...(args.objects !== undefined ? ['--objects', args.objects.join(',')] : []),
    ...(args.wholeOrg === true ? ['--org'] : []),
    ...(args.excluded ?? []).flatMap((name) => ['--exclude-object', name]),
    ...(args.customSettings === true ? ['--custom-settings'] : []),
    ...(args.files === true ? ['--files'] : []),
    ...(args.managedPackages === true ? ['--managed-packages'] : []),
    ...(args.unrestorable === true ? ['--unrestorable'] : []),
    ...(args.hardDelete === true ? ['--hard-delete'] : []),
    ...(args.checkpointFirst === true ? ['--checkpoint-first'] : []),
    ...(args.acceptNoUndo === true ? ['--accept-no-undo'] : []),
  ];
}

/** The acceptances of an emptying or its undo, as its script's line takes them. */
function emptyAccordLine(args: {
  acceptAutomation?: boolean | undefined;
  acceptEmails?: boolean | undefined;
  muteAutomation?: boolean | undefined;
}): string[] {
  return [
    ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
    ...(args.acceptEmails === true ? ['--accept-emails'] : []),
    ...(args.muteAutomation === true ? ['--mute-automation'] : []),
  ];
}

/** The flags an emptying's lines, or its undo's, name, and the parameters each stands for. */
const EMPTY_UNDO_FLAGS: Readonly<Record<string, string>> = {
  '--accept-automation': 'acceptAutomation',
  '--accept-emails': 'acceptEmails',
  '--mute-automation': 'muteAutomation',
};
const EMPTY_FLAGS: Readonly<Record<string, string>> = {
  ...EMPTY_UNDO_FLAGS,
  '--accept-no-undo': 'acceptNoUndo',
  '--accept-people-active': 'acceptPeopleActive',
};

/** What stands for the flags of an emptying's lines that take a run. */
const EMPTY_RUN_NAMED: Readonly<Record<string, string>> = {
  '--undo': 'is empty_undo, with the run the line names: it brings back what that run deleted.',
  '--resume': "is empty_run's resume, with the run the line names: it takes that run up.",
};

/** The undo an emptying offers, as the call that brings its records back. */
function emptyUndoHint(answer: unknown): string[] {
  if (typeof answer !== 'object' || answer === null) return [];
  const { result } = answer as { result?: { runId?: unknown; undo?: { offered?: unknown } } };
  return typeof result?.runId === 'string' && result.runId !== '' && result.undo?.offered === true
    ? [
        `empty_undo with run "${result.runId}" brings back what it deleted while the recycle bin ` +
          'holds it, as long as no other emptying of the org follows.',
      ]
    : [];
}

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

// ─── The plan of a pipeline ──────────────────────────────────────────────────

/** A variable of a pipeline, as `--var <name>=<value>` names it: no `=`, not starting with `-`. */
const PIPELINE_VARIABLE = /^[^=\r\n-][^=\r\n]{0,199}$/;

/** An org of a pipeline file, by its key in the file: neither a space nor `=`, not starting with `-`. */
const PIPELINE_ORG_KEY = /^[^\s=-][^\s=]{0,199}$/;

/** An Organization Id: `00D`, then 12 letters and digits, or 15. */
const ORGANIZATION_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** What `pipeline_plan` reads of its arguments, and passes to the plan's line. */
interface PipelinePlanArgs {
  file: string;
  approve?: string[] | undefined;
  vars?: Array<{ name: string; value: string }> | undefined;
  varEnvs?: Array<{ name: string; env: string }> | undefined;
  acceptOrgs?: Array<{ key: string; organizationId: string }> | undefined;
  store?: string | undefined;
}

/**
 * The line of `pipeline_plan`: `pipeline plan --file`, with what the run it
 * plans would be given, and `--json`. Never `run`: no tool runs a pipeline.
 * Exported so it can be tested.
 */
export function pipelinePlanLine(args: PipelinePlanArgs): string[] {
  return [
    'plan',
    '--file',
    args.file,
    ...(args.acceptOrgs ?? []).flatMap((org) => [
      '--accept-org',
      `${org.key}=${org.organizationId}`,
    ]),
    ...(args.vars ?? []).flatMap((each) => ['--var', `${each.name}=${each.value}`]),
    ...(args.varEnvs ?? []).flatMap((each) => ['--var-env', `${each.name}=${each.env}`]),
    ...(args.approve ?? []).flatMap((step) => ['--approve', step]),
    ...(args.store !== undefined ? ['--store', args.store] : []),
    '--json',
  ];
}

/**
 * What a plan of a pipeline says after its own lines: that no tool runs it,
 * where it runs, and that the plan had no terminal to ask its Approval steps
 * on, as a person's run on a terminal has.
 */
function pipelineRunWords(file: string): string {
  return (
    "No tool runs a pipeline: its run is the person's, on a terminal, " +
    `${commandOf('pipeline')} run --file ${shellWord(file)} --dry-run first, then without ` +
    '--dry-run. This plan had no terminal: an Approval step it says has no one to ask ' +
    '(APPROVAL_NO_TERMINAL) is asked there, or answered ahead by approve.'
  );
}

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

/** The checkpoint a run took first and kept, which `checkpoint_rewind` returns the org to. */
function rewindHint(answer: unknown): string[] {
  if (typeof answer !== 'object' || answer === null) return [];
  const { checkpoint } = answer as { checkpoint?: { state?: unknown; checkpointId?: unknown } };
  return checkpoint?.state === 'taken' && typeof checkpoint.checkpointId === 'string'
    ? [
        `checkpoint_rewind with checkpoint "${checkpoint.checkpointId}" returns the org to how it ` +
          'was before this run, and takes back what anyone did since on the objects it holds: ' +
          'checkpoint_preview says what it would do first.',
      ]
    : [];
}

/**
 * A SOQL condition without WHERE, as a filter of Forge takes one
 * (`soqlWhereFragmentSchema`): one line, 512 characters at most, no comment
 * marker, no semicolon at its end.
 */
const whereCondition = () =>
  z
    .string()
    .min(1)
    .max(512)
    .regex(ON_A_LINE, 'one line, not starting with "-"')
    .refine((text) => soqlWhereFragmentSchema.safeParse(text).success, {
      message: 'a SOQL condition without WHERE: no comment marker (--, /*, */) and no ; at its end',
    })
    .describe('A SOQL WHERE condition, without WHERE.');

// ─── A checkpoint replayed into another org ──────────────────────────────────

/** The name of an environment variable, as `--key-env` and `--var-env` take one. */
const ENV_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The checkpoint a replay or its removal is of: its id, or its name or latest with its org. */
const replayOf = {
  checkpoint: checkpointRef(
    'The checkpoint: its id, as checkpoint_list names it; or its name, or latest, with from.',
  ),
  from: alias(
    'With a checkpoint named by its name or latest: the org it was taken of, by its alias, ' +
      'its username or its Organization Id, as checkpoint_list names it. Refreshed or expired ' +
      'since, it is not reached.',
  ).optional(),
};

/** What a replay of a checkpoint is refused for when it names its checkpoint otherwise than by its id. */
function refuseReplayOf(
  args: { checkpoint?: string | undefined; from?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (args.from !== undefined && args.checkpoint === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'from goes with checkpoint, named by its name or latest',
    });
  }
  if (
    args.checkpoint !== undefined &&
    args.from === undefined &&
    !checkpointIdSchema.safeParse(args.checkpoint).success
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message:
        `"${args.checkpoint}" is not a checkpoint's id: a name, or latest, names one of an ` +
        "org's checkpoints, so give from, the org it was taken of, or its id",
    });
  }
}

/** What the removal of a replay asks of its sweep, as `checkpoint_replay_remove` takes it. */
interface ReplaySweepArgs {
  preview?: boolean | undefined;
  sweep?: boolean | undefined;
  sweepList?: boolean | undefined;
  sweepLate?: boolean | undefined;
  sweepUntied?: boolean | undefined;
}

/** Whether the removal of a replay only says what it would delete, or what its sweep would take. */
function listsOnly(args: Pick<ReplaySweepArgs, 'preview' | 'sweepList'>): boolean {
  return args.preview === true || args.sweepList === true;
}

/**
 * What the removal of a replay is refused for in its sweep, as the command
 * refuses it (`parseReplay`, `sweepClassArgsOf`), before any script runs: a
 * sweep and its list both, a preview with the list, which it gives with
 * sweep, and what came late or is tied to nothing without either. Read by
 * the command alone, `--sweep-late` was refused, exit 2, the line its own
 * preview had proposed.
 */
function refuseReplaySweep(args: ReplaySweepArgs, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (args.sweep === true && args.sweepList === true) {
    issue('sweepList', 'sweep deletes and sweepList only lists: give one of them');
  }
  if (args.preview === true && args.sweepList === true) {
    issue(
      'sweepList',
      'preview deletes nothing, and sweepList lists what a sweep would take: give preview ' +
        'without it, or with sweep',
    );
  }
  if (args.sweep !== true && args.sweepList !== true) {
    for (const key of ['sweepLate', 'sweepUntied'] as const) {
      if (args[key] === true) {
        issue(key, `${key} goes with sweep, or with sweepList to see what it would take`);
      }
    }
  }
}

/** The arguments a replay's choices are read from, as `checkpoint_replay` takes them. */
interface ReplayArgs {
  checkpoint?: string | undefined;
  from?: string | undefined;
  file?: string | undefined;
  keyEnv?: string | undefined;
  target: string;
  dryRun?: boolean | undefined;
  verify?: true | undefined;
  maxRecords?: number | undefined;
  objects?: string[] | undefined;
  excludedObjects?: string[] | undefined;
  owners?: 'same' | 'me' | undefined;
  customSettings?: boolean | undefined;
  mask?: boolean | undefined;
  again?: boolean | undefined;
  acceptAutomation?: boolean | undefined;
  acceptEmails?: boolean | undefined;
  muteAutomation?: boolean | undefined;
  checkpointFirst?: { keepDays?: number | undefined; excluded?: string[] | undefined } | undefined;
}

/** What a verification takes none of: the choices and acceptances of a replay that writes. */
const NOT_WITH_VERIFY = [
  'maxRecords',
  'objects',
  'excludedObjects',
  'owners',
  'customSettings',
  'mask',
  'again',
  'acceptAutomation',
  'acceptEmails',
  'muteAutomation',
  'checkpointFirst',
] as const;

/**
 * What a `checkpoint_replay` call is refused for before any script runs: a
 * checkpoint and a file both or neither, a file without the variable its key
 * is read from, a dry run and a verification both or neither, a replay that
 * writes without the count its dry run said, and a verification given the
 * choices of a replay.
 */
function refuseReplay(args: ReplayArgs, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if ((args.checkpoint === undefined) === (args.file === undefined)) {
    issue(
      'checkpoint',
      'give checkpoint, one kept on this machine, or file, a .sfcheckpoint a teammate sent: one ' +
        'of them',
    );
  }
  if (args.file !== undefined && args.keyEnv === undefined) {
    issue(
      'keyEnv',
      "a file goes with keyEnv, the name of the variable of the server's environment that holds " +
        'its key: no terminal is there to type it',
    );
  }
  if (args.keyEnv !== undefined && args.file === undefined) {
    issue('keyEnv', 'keyEnv goes with file: a checkpoint kept on this machine needs no key');
  }
  refuseReplayOf(args, ctx);
  if ((args.dryRun === undefined) === (args.verify === undefined)) {
    issue(
      'dryRun',
      'give dryRun — true first, then false to replay — or verify: true, one of them',
    );
  }
  if (args.verify === true) {
    for (const key of NOT_WITH_VERIFY) {
      if (args[key] !== undefined) {
        issue(
          key,
          `${key} goes with a replay or its dry run: verify reads the choices its last replay ` +
            'was made with, and writes nothing',
        );
      }
    }
  }
  if (args.dryRun === false && args.maxRecords === undefined) {
    issue(
      'maxRecords',
      'a replay that writes takes maxRecords, the count its dry run said, once the person ' +
        'using you has agreed to that many',
    );
  }
  if (args.dryRun === true && args.maxRecords !== undefined) {
    issue('maxRecords', 'maxRecords goes with dryRun: false: the dry run says the count');
  }
}

/** The checkpoint a replay's line names: kept here, by `--checkpoint`, or received, by `--file`. */
function replayOfLine(args: {
  checkpoint?: string | undefined;
  from?: string | undefined;
  file?: string | undefined;
  keyEnv?: string | undefined;
}): string[] {
  return args.file !== undefined
    ? ['--file', args.file, '--key-env', args.keyEnv ?? '']
    : [
        '--checkpoint',
        args.checkpoint ?? '',
        ...(args.from !== undefined ? ['--from', args.from] : []),
      ];
}

/**
 * The line of `checkpoint_replay`: its checkpoint, the other org, the dry
 * run, the verification or the replay, its choices, what accepts its write,
 * and of a replay the count its dry run said and `--yes`, the person having
 * agreed through `confirm`. Exported so it can be tested.
 */
export function checkpointReplayLine(args: ReplayArgs): string[] {
  return [
    'replay',
    ...replayOfLine(args),
    '--target',
    args.target,
    ...(args.verify === true ? ['--verify'] : args.dryRun === true ? ['--dry-run'] : []),
    ...(args.objects !== undefined ? ['--objects', args.objects.join(',')] : []),
    ...(args.excludedObjects ?? []).flatMap((name) => ['--exclude-object', name]),
    ...(args.owners !== undefined ? ['--owners', args.owners] : []),
    ...(args.customSettings === true ? ['--custom-settings'] : []),
    ...(args.mask === true ? ['--mask'] : []),
    ...(args.again === true ? ['--again'] : []),
    ...(args.muteAutomation === true ? ['--mute-automation'] : []),
    ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
    ...(args.acceptEmails === true ? ['--accept-emails'] : []),
    ...checkpointFirstLine(args.checkpointFirst),
    ...(args.dryRun === false ? ['--max-records', String(args.maxRecords), '--yes'] : []),
    '--json',
  ];
}

/** The records a replay's dry run would create, from its plan. */
function replayPlannedRecords(answer: unknown): number | undefined {
  const perObject = objectOf(objectOf(answer).plan).perObject;
  if (!Array.isArray(perObject)) return undefined;
  return perObject.reduce(
    (total: number, object: unknown) => total + (numberOf(objectOf(object).toInsert) ?? 0),
    0,
  );
}

/** What a replay's dry run says next: the call that replays it, with the count it said. */
function replayWriteHint(args: ReplayArgs, answer: unknown): string[] {
  const records = replayPlannedRecords(answer);
  if (records === undefined || records === 0) return [];
  return [
    `checkpoint_replay with the same parameters, dryRun: false, maxRecords: ${records} and ` +
      `confirm "${args.target}" creates them, once the person using you has agreed to it; ` +
      'checkpoint_replay_remove takes it back.',
  ];
}

/** A key of a load's configuration a refusal for want of it names: `requiredFieldDefaults["Account.Region__c"]`. */
const LOAD_CONFIG_GAP = /\b(requiredFieldDefaults|requiredLookupPlaceholders)\["([^"\]\n]+)"\]/g;

/**
 * What `LOAD_CONFIG`, named by a replay's lines, is to `checkpoint_replay`:
 * no parameter of it. The values of the required fields the replay leaves
 * empty are the person's to declare, in the file `--replay-config` reads, on
 * a terminal: the file the keys named make, and the dry run of the replay
 * this call asked with it. Run for real, the replay said "Declare them all,
 * then load again" to an agent that had no way to. Nothing when its lines do
 * not name it. Exported so it can be tested.
 */
export function replayConfigWords(args: ReplayArgs, said: string): string | undefined {
  if (!names(said, 'LOAD_CONFIG')) return undefined;
  const declared: Record<string, Record<string, unknown>> = {};
  for (const [, key = '', field = ''] of said.matchAll(LOAD_CONFIG_GAP)) {
    const part = (declared[key] ??= {});
    part[field] = key === 'requiredFieldDefaults' ? '…' : { name: '…' };
  }
  const line = checkpointReplayLine({
    ...args,
    dryRun: true,
    verify: undefined,
    maxRecords: undefined,
  }).filter((word) => word !== '--json');
  return (
    'LOAD_CONFIG, named above, is no parameter of this tool: the values of the required fields ' +
    'it names are the person’s to declare' +
    (Object.keys(declared).length > 0 ? `, in a file such as ${JSON.stringify(declared)}` : '') +
    ', and the replay goes from a terminal, its dry run first: ' +
    `${commandOf('checkpoint')} ${line.map(shellWord).join(' ')} --replay-config <file.json>`
  );
}

/**
 * What a list of checkpoints says of the ones that no longer rewind their
 * org and replay into another (`replayWith`): the dry run of their replay.
 */
function replayWithHints(answer: unknown): string[] {
  if (!Array.isArray(answer)) return [];
  return answer.flatMap((entry: unknown) => {
    const { id, replayWith } = objectOf(entry);
    const line = stringOf(replayWith);
    if (typeof id !== 'string' || line === undefined) return [];
    const target = /--target (\S+)/.exec(line)?.[1];
    return [
      `checkpoint "${id}" no longer rewinds its org, and replays into another: ` +
        `checkpoint_replay with checkpoint "${id}", ` +
        (target !== undefined && target !== '<alias>'
          ? `target "${target}"`
          : 'target the org it goes into') +
        ' and dryRun: true says what it would create there.',
    ];
  });
}

/**
 * Read, after the checkpoints of an org, the replays kept on this machine
 * that went into it, as `checkpoint replays --target` lists them: the
 * removal of each, by its checkpoint, is a call of `checkpoint_replay_remove`.
 * What cannot be read is said, never the list's failure.
 */
async function withReplays(org: string, settling: Settling): Promise<ResultParts> {
  const { parts, context } = settling;
  const args = ['replays', '--target', org, '--json'];
  let ran: CommandRun;
  try {
    ran = await context.runCommand('sandforge-checkpoint', args, context.stopping);
  } catch (err: unknown) {
    ran = {
      code: FAILED_EXIT,
      stdout: '',
      stderr: `${nameOf('sandforge-checkpoint')} could not be started: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const read = `read by: ${commandText('sandforge-checkpoint', args)}`;
  const replays = answerOf(ran.stdout);
  if (ran.code !== DONE_EXIT || !Array.isArray(replays)) {
    return {
      ...parts,
      added: [
        ...parts.added,
        `The replays into ${org} could not be read (exit ${ran.code}): ${ran.stderr.trimEnd()}`,
        read,
      ],
    };
  }
  const inPlace = replays.map(objectOf).filter((entry) => (numberOf(entry.inPlace) ?? 0) > 0);
  return {
    ...parts,
    added: [
      ...parts.added,
      replays.length === 0
        ? `No replay into ${org} is kept on this machine.`
        : `${replays.length} replay(s) into ${org} kept on this machine, ${inPlace.length} of ` +
          'them with records still there (replays):',
      ...inPlace.map(
        (entry) =>
          `  checkpoint "${String(entry.checkpointId)}": ${String(entry.inPlace)} record(s) in ` +
          `${org}; checkpoint_replay_remove with checkpoint "${String(entry.checkpointId)}" and ` +
          `target "${org}" takes them back, preview: true first.`,
      ),
      read,
    ],
    structured: { ...parts.structured, replays },
  };
}

// ─── A clone of the records a query chooses ──────────────────────────────────

/** What `clone_records` reads of its arguments, and passes to the clone's line. */
interface CloneRecordsArgs {
  source: string;
  target: string;
  object?: string | undefined;
  where?: string | undefined;
  orderBy?: string | undefined;
  limit?: number | undefined;
  recordIds?: string[] | undefined;
  depth?: 'direct' | 'full' | number | undefined;
  maxNodes?: number | undefined;
  maxReadTotal?: number | undefined;
  dryRun: boolean;
  acceptAutomation?: boolean | undefined;
  acceptEmails?: boolean | undefined;
  muteAutomation?: boolean | undefined;
  checkpointFirst?: { keepDays?: number | undefined; excluded?: string[] | undefined } | undefined;
}

/**
 * The query `clone_records` hands the clone for an object and what narrows
 * it: `SELECT Id FROM <object> [WHERE …] [ORDER BY …] LIMIT <limit>`, whose
 * records the clone takes as its roots.
 */
export function rootsQueryOf(args: {
  object: string;
  where?: string | undefined;
  orderBy?: string | undefined;
  limit: number;
}): string {
  return (
    `SELECT Id FROM ${args.object}` +
    (args.where !== undefined ? ` WHERE ${args.where}` : '') +
    (args.orderBy !== undefined ? ` ORDER BY ${args.orderBy}` : '') +
    ` LIMIT ${args.limit}`
  );
}

/**
 * The line of `clone_records`: the records a query chooses (`--query`), the
 * most it takes its limit, or the records named one by one (`--record`
 * given for each), the most it takes their count; then what bounds the read
 * and what accepts the write, as `clone_record` gives them. Exported so it
 * can be tested.
 */
export function cloneRecordsLine(args: CloneRecordsArgs): string[] {
  const roots =
    args.recordIds !== undefined
      ? [
          ...args.recordIds.flatMap((id) => ['--record', id]),
          '--max-roots',
          String(args.recordIds.length),
        ]
      : [
          '--query',
          rootsQueryOf({
            object: args.object ?? '',
            where: args.where,
            orderBy: args.orderBy,
            limit: args.limit ?? FORGE_ROOTS_MAX,
          }),
          '--max-roots',
          String(args.limit ?? FORGE_ROOTS_MAX),
        ];
  return [
    ...roots,
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
    ...(args.maxReadTotal !== undefined ? ['--max-read-total', String(args.maxReadTotal)] : []),
    ...(args.dryRun ? ['--dry-run'] : []),
    ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
    ...(args.acceptEmails === true ? ['--accept-emails'] : []),
    ...(args.muteAutomation === true ? ['--mute-automation'] : []),
    ...checkpointFirstLine(args.checkpointFirst),
    '--json',
  ];
}

/**
 * What a dry run of `clone_records` says of a field only the target
 * requires, which the clone does not write and no decision of its gives a
 * value (`targetGaps`, `required_field_missing` with no `answeredBy`): every
 * record of its object refused by a real run, and no parameter of this tool
 * that gives one. A Forge configuration's `defaultValues` gives it, read by
 * `--config` on a terminal: the file, and the dry run this call asked with
 * it. Run for real, a dry run of accounts said so, and the call could clone
 * leads only. Exported so it can be tested.
 */
export function requiredFieldWords(args: CloneRecordsArgs, answer: unknown): string[] {
  const gaps = objectOf(objectOf(answer).targetGaps).gaps;
  if (!Array.isArray(gaps)) return [];
  const unanswered = gaps.map(objectOf).flatMap((gap) => {
    const object = stringOf(gap.objectApiName);
    const field = stringOf(gap.field);
    return gap.kind === 'required_field_missing' &&
      gap.answeredBy === undefined &&
      object !== undefined &&
      field !== undefined
      ? [{ object, field }]
      : [];
  });
  if (unanswered.length === 0) return [];
  const line = cloneRecordsLine({ ...args, dryRun: true }).filter((word) => word !== '--json');
  const defaultValues = unanswered.map(({ object, field }) => ({ object, field, value: '…' }));
  return [
    ...unanswered.map(
      ({ object, field }) =>
        `${object}.${field} is a field ${args.target} requires that the clone does not write: ` +
        `a real run sees every record of ${object} refused, and no parameter of this tool ` +
        'gives it a value.',
    ),
    `The person using you gives ${unanswered.length === 1 ? 'it' : 'them'} in a Forge ` +
      `configuration file, ${JSON.stringify({ defaultValues })}, and clones from a terminal, its ` +
      `dry run first: ${commandOf('clone')} ${line.map(shellWord).join(' ')} --config <file.json>`,
  ];
}

/** What `--query`, named by the clone's lines, is to `clone_records`. */
const ROOTS_QUERY_WORDS =
  "is this tool's object, where, orderBy and limit: the query they make, SELECT Id FROM " +
  '<object> WHERE <where> ORDER BY <orderBy> LIMIT <limit>.';

/**
 * The query a refusal of a clone's volume names to take as many records as
 * fit, as the clone writes it (`rootsQueryWithLimit`): its ORDER BY, the one
 * asked or the newest first, and its LIMIT, the last of the statement.
 */
const QUERY_THAT_FITS = /--query "SELECT Id FROM [^"]* ORDER BY ([^"]+?) LIMIT (\d+)"/;

/**
 * What `--query`, named by a clone's lines, is to `clone_records`: of a
 * refusal of its volume, which names the query that takes as many records
 * as fit, this call again with that limit and order, its object and where
 * kept; otherwise the query its parameters make. Relayed, the refusal of a
 * query of 41 accounts said "this script's own --query "SELECT … LIMIT 3"",
 * a flag of no tool: the call's limit, 3, is what takes them. Exported so it
 * can be tested.
 */
export function rootsQueryWords(said: string): string {
  const fits = QUERY_THAT_FITS.exec(said);
  if (!fits) return ROOTS_QUERY_WORDS;
  return (
    `is this call with limit: ${fits[2] ?? ''} and orderBy: "${fits[1] ?? ''}", its object and ` +
    'where as they were: dryRun: true first.'
  );
}

/**
 * What a `clone_records` call is refused for before any script runs: a query
 * and records named both or neither, a query without its limit, records of
 * two objects, and a query the clone would refuse, in the clone's own words
 * (`soqlRootQueryIssue`), at the parameter that makes it.
 */
function refuseCloneRecords(args: CloneRecordsArgs, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if ((args.object === undefined) === (args.recordIds === undefined)) {
    issue(
      'object',
      'give object, with limit, for the records a query chooses, or recordIds, the records ' +
        'named one by one: one of them',
    );
    return;
  }
  if (args.recordIds !== undefined) {
    for (const key of ['where', 'orderBy', 'limit'] as const) {
      if (args[key] !== undefined) {
        issue(key, `${key} goes with object: recordIds names its records one by one`);
      }
    }
    const prefixes = [...new Set(args.recordIds.map((id) => id.slice(0, 3)))];
    if (prefixes.length > 1) {
      issue(
        'recordIds',
        `the records of one object: these are of ${prefixes.length} (${prefixes.map((p) => `${p}…`).join(', ')}); ` +
          'clone each object’s apart',
      );
    }
    return;
  }
  if (args.limit === undefined) {
    issue(
      'limit',
      `limit goes with object: the most records the query chooses, 1 to ${FORGE_ROOTS_MAX}, ` +
        'which the run clones and no more',
    );
    return;
  }
  const refused = soqlRootQueryIssue(
    rootsQueryOf({
      object: args.object ?? '',
      where: args.where,
      orderBy: args.orderBy,
      limit: args.limit,
    }),
  );
  if (refused !== undefined) {
    issue(
      refused.kind === 'orderBy' ? 'orderBy' : refused.kind === 'object' ? 'object' : 'where',
      `${soqlRootIssueWords(refused)} (ROOTS_QUERY_REFUSED)`,
    );
  }
}

/** The scripts whose removal `run_remove` runs, by module. */
const REMOVAL_SCRIPT: Readonly<Record<'seed' | 'forge' | 'sync', Script>> = {
  seed: 'sandforge-seed',
  forge: 'sandforge-clone',
  sync: 'sandforge-sync',
};

// ─── A clone of the whole org ────────────────────────────────────────────────

/**
 * Where a person copies the personal data of a whole org as its source holds
 * it, since no tool does: an agent's clone of the whole org always
 * anonymizes, the choice being the person's alone, made on a terminal or in
 * a file the repository's reviewers read.
 */
const REAL_DATA_WORDS =
  "An agent's clone of the whole org always anonymizes its personal fields: no tool copies " +
  'them as the source holds them. A person who means to does it on a terminal, ' +
  `${commandOf('clone')} --depth all --source <alias> --target <alias> --no-anonymize after ` +
  'its --dry-run, or in a sandforge.yaml whose depth: all resource says accept: { realData: ' +
  'true }, reviewed where the repository is, that env_plan and env_apply run.';

/** An object and one of its fields, `Account.Description`, as `--exclude` takes them. */
const OBJECT_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,79}\.[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** A bound of a window of dates: a date, or an instant in UTC, as `--fit-window` takes one. */
const windowBound = (end: boolean) =>
  z.string().refine((text) => forgeSampleWindowBound(text, end) !== undefined, {
    message: 'a date, as 2025-06-30, or an instant in UTC, as 2025-06-30T12:00:00Z',
  });

/**
 * `fitWindow`: the window of dates a sample draws its roots in, its bounds
 * or its last days, never both; a start before its end, read as the clone
 * reads them, a date alone ending with its whole day.
 */
const fitWindowArg = () =>
  z
    .strictObject({
      field: z
        .enum(['created', 'modified'])
        .describe('created: the roots made in the window; modified: those last changed in it.'),
      from: windowBound(false)
        .optional()
        .describe('Its start: a date, from 00:00 UTC, or an instant in UTC.'),
      to: windowBound(true)
        .optional()
        .describe('Its end, left out of it: a date alone takes its whole day.'),
      lastDays: z
        .number()
        .int()
        .min(1)
        .max(FORGE_SAMPLE_MAX_LAST_DAYS)
        .optional()
        .describe(
          'The last days, counted back from when the sample is drawn; not with from or to.',
        ),
    })
    .superRefine((window, ctx) => {
      const bounded = window.from !== undefined || window.to !== undefined;
      if (bounded === (window.lastDays !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lastDays'],
          message: 'a window gives from, to or both, or lastDays: one or the other',
        });
      }
      const from =
        window.from !== undefined ? forgeSampleWindowBound(window.from, false) : undefined;
      const to = window.to !== undefined ? forgeSampleWindowBound(window.to, true) : undefined;
      if (from !== undefined && to !== undefined && from >= to) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'a window starts before it ends: no root is made in this one',
        });
      }
    })
    .optional()
    .describe(
      'With fit: draw only the roots made, or last changed, in a window of dates, in UTC. The ' +
        'records under or above a root come whatever their date.',
    );

/**
 * `fitStrata`: the fields the roots are stratified by, `Field` of every
 * object that has it or `Object.Field`, one of each object at most.
 */
const fitStrataArg = () =>
  z
    .array(
      z
        .string()
        .regex(
          FORGE_SAMPLE_STRATUM_PATTERN,
          'a field, as RecordTypeId, or an object and its field, as Account.RecordTypeId',
        ),
    )
    .min(1)
    .max(FORGE_SAMPLE_MAX_STRATA)
    .superRefine((strata, ctx) => {
      const checked = forgeSampleStrataSchema.safeParse(strata);
      if (checked.success) return;
      for (const issue of checked.error.issues) {
        ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
      }
    })
    .optional()
    .describe(
      'With fit: keep the same share of the roots of each value of a picklist, a checkbox or a ' +
        'lookup (RecordTypeId, OwnerId), at least fitFloor of each value: Field, of every ' +
        'object drawn that has it, or Object.Field, one field of each object.',
    );

/** The most a sample may be asked to take of the target, in MB, as `--fit-within` takes it. */
const FIT_WITHIN_MOST_MB = 1_000_000;

/** The arguments of `clone_org`: a plan, its confirmation, and a resume. */
const CLONE_ORG_ARGS: readonly string[] = ['plan', 'confirm', 'resume'];

/**
 * The refusals of a run of a plan that only a new plan answers: its copy
 * changed or gone, a source that grew past its count, a target with less
 * room or more automation than it was planned with. Its receipt is marked
 * dead, and `clone_org` refuses it after.
 */
const PLAN_NO_LONGER_HOLDS: ReadonlySet<string> = new Set([
  'SAMPLE_PLAN_MISMATCH',
  'SAMPLE_PLAN_GONE',
  'MAX_TOTAL_EXCEEDED',
  'STORAGE_EXCEEDED',
  'AUTOMATION_NOT_ACCEPTED',
]);

/**
 * The window of dates a sample draws its roots in, as `fitWindow` takes it:
 * the field, then its bounds — a date or an instant in UTC, either left out —
 * or its last days.
 */
interface FitWindow {
  field: 'created' | 'modified';
  from?: string | undefined;
  to?: string | undefined;
  lastDays?: number | undefined;
}

/** A window as `--fit-window` takes it: `created:2025-01-01..2025-06-30`, `modified:30d`. */
function fitWindowValue(window: FitWindow): string {
  return window.lastDays !== undefined
    ? `${window.field}:${window.lastDays}d`
    : `${window.field}:${window.from ?? ''}..${window.to ?? ''}`;
}

/** What `clone_org_plan` reads of its arguments, and passes to the clone's line. */
interface CloneOrgPlanArgs {
  source: string;
  target: string;
  fit?: 'share' | undefined;
  fitWithinMB?: number | undefined;
  fitSeed?: number | undefined;
  fitDraw?: 'uniform' | 'recent' | 'oldest' | undefined;
  fitWindow?: FitWindow | undefined;
  fitWhere?: Array<{ objectApiName: string; where: string }> | undefined;
  fitStrata?: string[] | undefined;
  fitParents?: 'all' | 'required' | undefined;
  fitChildren?: number | 'all' | undefined;
  fitWhole?: string[] | undefined;
  fitFloor?: number | undefined;
  maxTotal?: number | undefined;
  excludedObjects?: string[] | undefined;
  excludedFields?: string[] | undefined;
  filters?: Array<{ objectApiName: string; where: string }> | undefined;
  acceptAutomation?: boolean | undefined;
  acceptEmails?: boolean | undefined;
  muteAutomation?: boolean | undefined;
  checkpointFirst?: { keepDays?: number | undefined; excluded?: string[] | undefined } | undefined;
}

/**
 * The line of the dry run `clone_org_plan` runs: the clone of the whole org
 * with what narrows, fits and accepts it, anonymized whatever is asked, its
 * preflight left to the run's gate as an environment leaves it — otherwise a
 * read of each object first. Exported so it can be tested.
 */
export function cloneOrgPlanLine(args: CloneOrgPlanArgs): string[] {
  return [
    '--depth',
    'all',
    '--source',
    args.source,
    '--target',
    args.target,
    ...(args.fit !== undefined ? ['--fit', args.fit] : []),
    ...(args.fitWithinMB !== undefined ? ['--fit-within', String(args.fitWithinMB)] : []),
    ...(args.fitSeed !== undefined ? ['--fit-seed', String(args.fitSeed)] : []),
    ...(args.fitDraw !== undefined ? ['--fit-draw', args.fitDraw] : []),
    ...(args.fitWindow !== undefined ? ['--fit-window', fitWindowValue(args.fitWindow)] : []),
    ...(args.fitWhere ?? []).flatMap((each) => [
      '--fit-where',
      `${each.objectApiName}=${each.where}`,
    ]),
    ...(args.fitStrata ?? []).flatMap((stratum) => ['--fit-strata', stratum]),
    ...(args.fitParents !== undefined ? ['--fit-parents', args.fitParents] : []),
    ...(args.fitChildren !== undefined ? ['--fit-children', String(args.fitChildren)] : []),
    ...(args.fitWhole ?? []).flatMap((name) => ['--fit-whole', name]),
    ...(args.fitFloor !== undefined ? ['--fit-floor', String(args.fitFloor)] : []),
    ...(args.maxTotal !== undefined ? ['--max-total', String(args.maxTotal)] : []),
    ...(args.excludedObjects ?? []).flatMap((name) => ['--exclude-object', name]),
    ...(args.excludedFields ?? []).flatMap((field) => ['--exclude', field]),
    ...(args.filters ?? []).flatMap((filter) => [
      '--filter',
      `${filter.objectApiName}=${filter.where}`,
    ]),
    '--anonymize',
    ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
    ...(args.acceptEmails === true ? ['--accept-emails'] : []),
    ...(args.muteAutomation === true ? ['--mute-automation'] : []),
    ...checkpointFirstLine(args.checkpointFirst),
    '--skip-preflight',
    '--dry-run',
    '--json',
  ];
}

/** The acceptances a plan was asked with, by the parameters that gave them. */
function acceptedOf(args: CloneOrgPlanArgs): string[] {
  return [
    ...(args.acceptAutomation === true ? ['acceptAutomation'] : []),
    ...(args.acceptEmails === true ? ['acceptEmails'] : []),
    ...(args.muteAutomation === true ? ['muteAutomation'] : []),
    ...(args.checkpointFirst !== undefined ? ['checkpointFirst'] : []),
  ];
}

/** `value` when it is an object, else an empty one: what a lenient read of a script's JSON walks. */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `value` when it is a finite number. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `value` when it is a string of something. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A plan as `clone_org_plan` answers it, beside the dry run's own JSON. */
export interface PlanSummary {
  id: string;
  expiresAt: string;
  mode: 'sample' | 'whole';
  source: string;
  target: string;
  records: number;
  objects: number;
  storageMB?: { estimate?: number; remaining?: number };
  requests?: { target?: number; source?: number };
  bulkBatches?: number;
  durationSeconds?: number;
  question?: string;
  anonymize: boolean;
  accepted: string[];
  sample?: {
    share?: number;
    seed?: number;
    draw?: string;
    limitedBy?: string;
    /** How its roots were chosen, as the dry run said it: the window, the filters, the strata. */
    roots?: Record<string, unknown>;
  };
}

/**
 * What `clone_org_plan` says of the plan it kept: the receipt, and the dry
 * run's own figures. Exported so it can be tested.
 */
export function planSummaryOf(receipt: ClonePlanReceipt, answer: unknown): PlanSummary {
  const dry = objectOf(answer);
  const whole = objectOf(dry.wholeOrg);
  const storage = objectOf(whole.storage);
  const requests = objectOf(whole.requests);
  const sample = objectOf(whole.sample);
  const estimate = (value: unknown) => numberOf(objectOf(value).estimate);
  const storageMB = {
    ...(numberOf(storage.estimateMB) !== undefined
      ? { estimate: numberOf(storage.estimateMB) }
      : {}),
    ...(numberOf(storage.remainingMB) !== undefined
      ? { remaining: numberOf(storage.remainingMB) }
      : {}),
  };
  const asked = {
    ...(estimate(requests.target) !== undefined ? { target: estimate(requests.target) } : {}),
    ...(estimate(requests.source) !== undefined ? { source: estimate(requests.source) } : {}),
  };
  const limitedBy = stringOf(objectOf(sample.budget).limitedBy);
  const roots = objectOf(sample.roots);
  return {
    id: receipt.id,
    expiresAt: receipt.expiresAt,
    mode: receipt.mode,
    source: receipt.source,
    target: receipt.target,
    records: receipt.totalRows,
    objects: Array.isArray(whole.wouldInsert) ? whole.wouldInsert.length : 0,
    ...(Object.keys(storageMB).length > 0 ? { storageMB } : {}),
    ...(Object.keys(asked).length > 0 ? { requests: asked } : {}),
    ...(estimate(whole.bulkBatches) !== undefined
      ? { bulkBatches: estimate(whole.bulkBatches) }
      : {}),
    ...(receipt.durationSeconds !== undefined ? { durationSeconds: receipt.durationSeconds } : {}),
    ...(receipt.question !== undefined ? { question: receipt.question } : {}),
    // Asked of every plan; said as the dry run read it.
    anonymize: dry.anonymize !== false,
    accepted: [...receipt.accepted],
    ...(receipt.mode === 'sample'
      ? {
          sample: {
            ...(numberOf(sample.share) !== undefined ? { share: numberOf(sample.share) } : {}),
            ...(numberOf(sample.seed) !== undefined ? { seed: numberOf(sample.seed) } : {}),
            ...(stringOf(sample.draw) !== undefined ? { draw: stringOf(sample.draw) } : {}),
            ...(limitedBy !== undefined ? { limitedBy } : {}),
            ...(Object.keys(roots).length > 0 ? { roots } : {}),
          },
        }
      : {}),
  };
}

/** How a sample's roots were chosen, as a plan's line says it; nothing of a draw among every root. */
function rootsChosenWords(sample: NonNullable<PlanSummary['sample']>): string {
  const order =
    sample.draw === 'recent'
      ? 'newest first'
      : sample.draw === 'oldest'
        ? 'oldest first'
        : undefined;
  const roots = sample.roots ?? {};
  const by = [
    ...(roots.window !== undefined ? ['within a window of their dates'] : []),
    ...(roots.where !== undefined ? ['among the records a condition keeps'] : []),
    ...(roots.strata !== undefined ? ['by strata'] : []),
  ];
  if (order === undefined && by.length === 0) return '';
  return (
    `, its roots drawn ${[...(order !== undefined ? [order] : []), ...by].join(', ')}` +
    (by.length > 0 ? ' (plan.sample.roots says how)' : '')
  );
}

/**
 * What the server says of a plan it kept: what it writes, its question, and
 * the call that writes it. Exported so it can be tested.
 */
export function planLines(plan: PlanSummary): string[] {
  const share = plan.sample?.share;
  const what =
    plan.mode === 'sample'
      ? `a sample of ${plan.source}` +
        (share !== undefined ? `, ${Math.round(share * 1000) / 10} % of each object's roots` : '') +
        (plan.sample !== undefined ? rootsChosenWords(plan.sample) : '') +
        (plan.sample?.limitedBy !== undefined ? `, held by ${plan.sample.limitedBy}` : '')
      : `every record of ${plan.source} it can take`;
  return [
    `The plan "${plan.id}": ${plan.records} records of ${plan.objects} objects into ` +
      `${plan.target}, ${what}, every personal field anonymized` +
      (plan.durationSeconds !== undefined
        ? `; its writes take about ${plan.durationSeconds} seconds`
        : '') +
      `. It holds until ${plan.expiresAt}` +
      (plan.accepted.length > 0 ? `, with ${plan.accepted.join(', ')} given` : '') +
      '.',
    ...(plan.question !== undefined
      ? [`Its question, which a terminal would ask before the first write: ${plan.question}`]
      : []),
    'Show the person this plan and its question. clone_org with plan ' +
      `"${plan.id}" and confirm "${plan.target}" writes it and nothing else, once they have ` +
      'said yes: nothing is written before.',
  ];
}

/**
 * Keep the plan of a dry run of a clone of the whole org that would go: its
 * receipt, and of a sample a copy of the ids it drew. A dry run refused, or
 * one with nothing to write, keeps none; its lines say why, and the
 * parameters that lift each refusal are named by the tool's flags.
 */
async function keepThePlan(args: CloneOrgPlanArgs, settling: Settling): Promise<ResultParts> {
  const { ran, run, parts, context } = settling;
  if (ran.code !== DONE_EXIT) return parts;
  const planned = dryRunPlanOf(parts.answer);
  if (!planned) {
    return {
      ...parts,
      added: [
        ...parts.added,
        'No plan was kept: the dry run counted no record to write, or answered otherwise than ' +
          'a dry run of the whole org that would go. Nothing was written.',
      ],
    };
  }
  let receipt: ClonePlanReceipt;
  try {
    receipt = await keepClonePlan(
      context.journalDir,
      {
        source: args.source,
        target: args.target,
        dryRunArgs: run.args,
        planned,
        accepted: acceptedOf(args),
      },
      context.now(),
    );
  } catch (err: unknown) {
    const message =
      'No plan was kept: the plan of ids its dry run drew is no longer the one it gave — ' +
      `${err instanceof Error ? err.message : String(err)}. clone_org_plan again draws one, ` +
      'kept as it is shown. Nothing was written.';
    return {
      ...parts,
      added: [...parts.added, message],
      structured: { ...parts.structured, refusal: { code: 'PLAN_NOT_KEPT', message } },
      isError: true,
    };
  }
  const plan = planSummaryOf(receipt, parts.answer);
  return {
    ...parts,
    added: [...parts.added, ...planLines(plan)],
    structured: { ...parts.structured, plan },
  };
}

/** The plan a run of `clone_org` writes, as it was found before the call was confirmed. */
interface PlanToWrite {
  receipt: ClonePlanReceipt;
  /** The journal a resume takes up: that of the plan's last run. */
  journal?: string;
}

/** Why `plan` can no longer be written, in the words of the refusal that says so. */
function planGoneWords(id: string, why: string, receipt?: ClonePlanReceipt): string {
  switch (why) {
    case 'expired':
      return `plan "${id}" held until ${receipt?.expiresAt ?? 'a day after it was drawn'}, and no run of it wrote`;
    case 'dead':
      return (
        `plan "${id}" no longer holds: a run of it was refused` +
        (receipt?.dead !== undefined ? ` (${receipt.dead.code})` : '') +
        ' for what changed since it was planned, writing nothing'
      );
    case 'journalGone':
      return (
        `a run of plan "${id}" wrote, and its journal is no longer on this machine: nothing ` +
        'says what it wrote, to take up or back'
      );
    default:
      return `plan "${id}" is not on this machine`;
  }
}

/**
 * What `clone_org` reads before it is confirmed: its plan as a run finds it,
 * and the runs of this server. Refused here, before any script runs, is a
 * plan gone or past its day, one already written (but by `resume`), a
 * resume with nothing to take up, and a target another run of this server
 * still writes.
 */
async function planToWrite(
  args: { plan: string; resume?: true | undefined },
  context: ToolContext,
): Promise<Prepared<PlanToWrite>> {
  const id = args.plan;
  const opened = await openClonePlan(context.journalDir, id, context.now());
  const nothing = 'Refused: nothing was read or written.';
  if (opened.state === 'gone') {
    return {
      refusal: {
        code: 'PLAN_GONE',
        message:
          `clone_org: ${planGoneWords(id, opened.why, opened.receipt)}. clone_org_plan again ` +
          'with the same parameters says what a clone would write now: show the person its ' +
          `question, then clone_org with its plan. ${nothing}`,
      },
    };
  }
  const { receipt } = opened;
  if (opened.state === 'written') {
    const last = opened.run.run;
    const under = context.runs.get(last)?.running === true;
    const journal = opened.journal;
    const removal =
      journal !== undefined
        ? `run_remove with module "forge", org "${receipt.target}" and run "${journal}" ` +
          '(preview: true first) takes it back'
        : `run_status with run "${last}" says what is known of it`;
    if (args.resume !== true || under) {
      return {
        refusal: {
          code: 'PLAN_USED',
          message:
            `clone_org: plan "${id}" ${under ? 'is being written by' : 'was written by'} run ` +
            `"${last}"${journal !== undefined ? `, whose journal is ${journal}` : ''}: a plan ` +
            `is written once. run_status with run "${last}" ` +
            (under ? 'follows it, and run_stop stops it' : 'says how it ended') +
            `; clone_org with plan "${id}", resume: true and confirm "${receipt.target}" takes ` +
            `up a run of it that stopped part way; ${removal}. ${nothing}`,
        },
      };
    }
    if (journal === undefined) {
      return {
        refusal: {
          code: 'NOTHING_TO_RESUME',
          message:
            `clone_org: run "${last}" of plan "${id}" named no journal, so nothing says what it ` +
            `wrote and no resume takes it up. ${removal}. ${nothing}`,
        },
      };
    }
  } else if (args.resume === true) {
    return {
      refusal: {
        code: 'NOTHING_TO_RESUME',
        message:
          `clone_org: no run of plan "${id}" has written, and resume takes up a run that ` +
          `stopped part way. clone_org with plan "${id}" and confirm "${receipt.target}", ` +
          `without resume, writes it. ${nothing}`,
      },
    };
  }
  const busy = context.runs.busyWith(receipt.target);
  if (busy) {
    return {
      refusal: {
        code: 'TARGET_BUSY',
        message:
          `clone_org: ${receipt.target} is being written by run "${busy.handle}" of ` +
          `${busy.meta.tool}, which this server runs: two runs writing one org at once could ` +
          `not tell their records apart. run_status with run "${busy.handle}" says when it has ` +
          `ended, and run_stop stops it. ${nothing}`,
      },
    };
  }
  return {
    prepared: {
      receipt,
      ...(opened.state === 'written' && opened.journal !== undefined
        ? { journal: opened.journal }
        : {}),
    },
  };
}

/** The journal a clone's answer names, which `--resume`, `--remove` and `--verify` take. */
function journalOfAnswer(answer: unknown): string | undefined {
  return stringOf(objectOf(answer).journal);
}

/** What a verification of a run found, as `clone_org` answers it. */
interface VerificationSaid {
  exitCode: number;
  /** VERIFIED, PARTIAL or UNSTABLE, as the verification says it; absent when it said none. */
  status?: string;
  /** The records it set out to read back, those there, in the recycle bin, out of sight. */
  expected?: number;
  present?: number;
  deleted?: number;
  notVisible?: number;
  /** The lookups that do not point where the run set them. */
  linksBroken?: number;
  /** The objects it could not read back, or whose lookups it could not check. */
  unchecked?: number;
  /** Of a verification that was not VERIFIED, the objects it found short, the first fifty. */
  objects?: Array<Record<string, unknown>>;
}

/** The objects a verification lists at most, of those it found short. */
const SHORT_OBJECTS_SAID = 50;

/**
 * Verify what a run of a plan wrote, as an environment verifies a clone
 * after its apply: `sandforge clone --verify` its journal, reading both
 * orgs. Told only "done", an agent had nothing that said every record was
 * there, its lookups holding.
 */
async function verifyTheRun(
  context: ToolContext,
  receipt: ClonePlanReceipt,
  journal: string,
): Promise<{ said: VerificationSaid; line: string; stderr: string }> {
  const args = [
    '--verify',
    journal,
    '--source',
    receipt.source,
    '--target',
    receipt.target,
    '--json',
  ];
  let ran: CommandRun;
  try {
    ran = await context.runCommand('sandforge-clone', args, context.stopping, {
      relayedBy: CLONE_ORG_RELAY,
    });
  } catch (err: unknown) {
    ran = {
      code: FAILED_EXIT,
      stdout: '',
      stderr: `${nameOf('sandforge-clone')} could not be started: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = objectOf(objectOf(answerOf(ran.stdout)).result);
  const verdict = stringOf(result.verdict);
  const objects = Array.isArray(result.objects) ? result.objects.map(objectOf) : [];
  const sum = (key: string) => objects.reduce((total, o) => total + (numberOf(o[key]) ?? 0), 0);
  return {
    said: {
      exitCode: ran.code,
      ...(verdict !== undefined
        ? {
            status: verdict.toUpperCase(),
            expected: sum('expected'),
            present: sum('present'),
            deleted: sum('deleted'),
            notVisible: sum('notVisible'),
            linksBroken: sum('linksBroken'),
            unchecked: objects.filter(
              (o) => stringOf(o.error) !== undefined || stringOf(o.linksUnchecked) !== undefined,
            ).length,
          }
        : {}),
      ...(verdict !== undefined && verdict !== 'verified'
        ? {
            objects: objects
              .filter(
                (o) =>
                  (numberOf(o.present) ?? 0) < (numberOf(o.expected) ?? 0) ||
                  (numberOf(o.linksBroken) ?? 0) > 0 ||
                  stringOf(o.error) !== undefined ||
                  stringOf(o.linksUnchecked) !== undefined,
              )
              .slice(0, SHORT_OBJECTS_SAID)
              .map((o) => ({
                objectApiName: o.objectApiName,
                expected: o.expected,
                present: o.present,
                deleted: o.deleted,
                notVisible: o.notVisible,
                linksBroken: o.linksBroken,
                ...(stringOf(o.error) !== undefined ? { error: o.error } : {}),
                ...(stringOf(o.linksUnchecked) !== undefined
                  ? { linksUnchecked: o.linksUnchecked }
                  : {}),
              })),
          }
        : {}),
    },
    line: `verified by: ${commandText('sandforge-clone', args)}`,
    stderr: ran.stderr.trimEnd(),
  };
}

/** The verification as the answer says it: first, when it found the run short. */
function verificationWords(said: VerificationSaid, target: string): string {
  const counts =
    said.expected !== undefined
      ? `${said.present ?? 0} of the ${said.expected} records the run created read back from ` +
        `${target}` +
        (said.deleted ? `, ${said.deleted} in its recycle bin` : '') +
        (said.notVisible ? `, ${said.notVisible} out of sight` : '') +
        (said.linksBroken ? `; ${said.linksBroken} lookups not where the run set them` : '') +
        (said.unchecked ? `; ${said.unchecked} objects not read or checked whole` : '')
      : '';
  const short =
    (said.present ?? 0) < (said.expected ?? 0) || (said.linksBroken ?? 0) > 0
      ? `${target} does not hold all of it as it was written`
      : `what it wrote could not all be checked`;
  switch (said.status) {
    case 'VERIFIED':
      return `Verification: VERIFIED — ${counts}, every lookup checked where the run set it.`;
    case 'PARTIAL':
      return (
        `Verification: PARTIAL — the clone ended, and ${short}: ${counts}. ` +
        'verification.objects names the objects, each with what it found.'
      );
    case 'UNSTABLE':
      return (
        `Verification: UNSTABLE — no two readings of ${target} agreed: something still writes ` +
        `to the run's records (${counts}). run_status says it again, verified again, once ` +
        'nothing does.'
      );
    default:
      return (
        `Verification: not done — the verification of the run ended on ${said.exitCode} ` +
        '(its lines follow): what the clone wrote is not known to be there.'
      );
  }
}

/**
 * What `clone_org` does once its run has ended: says in the plan's receipt
 * how it ended; verifies what a run that went through wrote, the
 * verification said first unless VERIFIED; marks the plan dead when a
 * refusal says only a new plan answers; and gives the call that takes the
 * run up or back, by its code.
 */
async function settleCloneOrg(prepared: PlanToWrite, settling: Settling): Promise<ResultParts> {
  const { ran, launch, parts, context } = settling;
  const { receipt } = prepared;
  const answer = objectOf(parts.answer);
  const journal = journalOfAnswer(answer) ?? (await readRunSummary(launch.summary))?.journal;
  await endClonePlanRun(context.journalDir, receipt.id, launch.handle, {
    code: ran.code,
    ...(journal !== undefined ? { journal } : {}),
  });
  const head: string[] = [];
  const added = [...parts.added];
  let structured = parts.structured;
  const takeBack =
    journal !== undefined
      ? `run_remove with module "forge", org "${receipt.target}" and run "${journal}" takes it ` +
        'back: preview: true first says what it would delete.'
      : undefined;
  const refusal = objectOf(answer.refused);
  const code = stringOf(refusal.code);
  if (ANSWERED.has(ran.code)) {
    const result = objectOf(answer.result);
    const created = numberOf(result.successCount);
    if (created !== undefined) {
      added.push(
        `It created ${created} records of the ${receipt.totalRows} its plan counted` +
          (numberOf(result.failedCount) ? `, ${numberOf(result.failedCount)} refused` : '') +
          '.',
      );
    }
    if (journal !== undefined) {
      const verified = await verifyTheRun(context, receipt, journal);
      const words = verificationWords(verified.said, receipt.target);
      if (verified.said.status === 'VERIFIED') added.push(words, verified.line);
      else {
        head.push(words);
        added.push(verified.line, ...(verified.stderr !== '' ? [verified.stderr] : []));
      }
      structured = { ...structured, verification: verified.said };
    }
    if (takeBack !== undefined) added.push(`This run: ${takeBack}`);
    added.push(...rewindHint(answer));
  } else if (STOPPED.has(ran.code)) {
    added.push(
      journal !== undefined
        ? `It stopped part way, between two calls to the org: its journal ${journal} holds what ` +
            `it wrote. clone_org with plan "${receipt.id}", resume: true and confirm ` +
            `"${receipt.target}" takes it up, writing nothing twice; ${takeBack ?? ''}`
        : `It stopped before it wrote anything: plan "${receipt.id}" still holds until ` +
            `${receipt.expiresAt}, and clone_org with it writes it.`,
    );
    added.push(...rewindHint(answer));
  } else if (code !== undefined && PLAN_NO_LONGER_HOLDS.has(code)) {
    await markClonePlanDead(context.journalDir, receipt.id, code, context.now());
    added.push(
      `The plan no longer holds (${code}): what it was drawn or counted from changed since. ` +
        'clone_org_plan again with the same parameters says what a clone would write now; show ' +
        'the person its question, then clone_org with its plan. Nothing was written.',
    );
  } else if (code === 'API_BUDGET_EXCEEDED') {
    added.push(
      `Plan "${receipt.id}" still holds until ${receipt.expiresAt}: clone_org with it again ` +
        'once the org has the requests it takes, within its day, or clone_org_plan again. ' +
        'Nothing was written.',
    );
  } else if (code === 'RESUME_UNCERTAIN') {
    const retryAt = stringOf(refusal.retryAt);
    added.push(
      retryAt !== undefined
        ? `clone_org with plan "${receipt.id}", resume: true and confirm "${receipt.target}" ` +
            `again from ${retryAt}, once the calls the run left under way have ended. Nothing ` +
            'was written.'
        : `${takeBack ?? 'run_remove takes back what it wrote'} Nothing was written.`,
    );
  }
  return { ...parts, head, added, structured };
}

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
      'with generated rows (objects), as sandforge seed --json does. Run it with dryRun: true ' +
      'first: it reads the org and writes nothing, and says what a real run would meet — the data ' +
      "storage it takes, the emails the org's automation would send, what runs as the records are " +
      'created. Past the storage the org has left, it says the counts that fit; fit: "share" ' +
      'seeds them, the largest share of every count that fits, and fitWithinMB holds the run to ' +
      'fewer MB still. checkpointFirst takes a checkpoint of what the run writes before its ' +
      'first write, and a dry run says what it would hold and cost. dryRun: false writes, a ' +
      'production org refused, and needs confirm. acceptEmails lets it write although the org ' +
      'delivers every email what still runs sends, or would not say whether it does; ' +
      "muteAutomation keeps the org's automation quiet for the run through its own bypass, and " +
      'a dry run with it says what it would assign. The answer names the run file, which ' +
      'run_remove with module "seed" takes the run back from, and the checkpoint it took, which ' +
      'checkpoint_rewind returns the org to.',
    readOnly: false,
    destructive: false,
    args: z
      .strictObject({
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
        fit: z
          .enum(['share'])
          .optional()
          .describe(
            '"share": seed the largest share of every count that fits the data storage the org ' +
              'has left, each object about that share of its records, a child no more than its ' +
              'parents kept hold, room kept for what its flows still running create. The answer ' +
              'says the counts, object by object; give it to a write only once the person using ' +
              'you has seen them in a dry run.',
          ),
        fitWithinMB: z
          .number()
          .min(0.01)
          .max(1_000_000)
          .optional()
          .describe('With fit: take no more than this many MB, whatever the org has left.'),
        checkpointFirst: checkpointFirst('the seed'),
        acceptEmails: acceptance(
          'Write although the org delivers every email of what still runs as the records go ' +
            'in, or would not say whether it does: only once the person using you has accepted ' +
            'that these emails go out.',
        ),
        muteAutomation: muteFor('the seed'),
        confirm: confirmOf('org').optional(),
      })
      .refine((args) => args.fitWithinMB === undefined || args.fit !== undefined, {
        message: 'fitWithinMB goes with fit: "share"',
        path: ['fitWithinMB'],
      }),
    writesTo: (args) => (args.dryRun ? undefined : args.org),
    writes: 'creates the records of the seed in it',
    readFirst: 'a dry run of the same seed says what it would write and meet',
    flags: { '--accept-emails': 'acceptEmails', '--mute-automation': 'muteAutomation' },
    after: (args, answer) =>
      args.dryRun ? [] : [...removalHint('seed', answer), ...rewindHint(answer)],
    run: (args) => ({
      script: 'sandforge-seed',
      args: [
        '--target',
        args.org,
        ...(args.template !== undefined ? ['--template', args.template] : []),
        ...(args.objects ?? []).flatMap((o) => ['--object', `${o.objectApiName}:${o.count}`]),
        ...(args.dryRun ? ['--dry-run'] : []),
        ...(args.fit !== undefined ? ['--fit', args.fit] : []),
        ...(args.fitWithinMB !== undefined ? ['--fit-within', String(args.fitWithinMB)] : []),
        ...(args.acceptEmails === true ? ['--accept-emails'] : []),
        ...(args.muteAutomation === true ? ['--mute-automation'] : []),
        ...checkpointFirstLine(args.checkpointFirst),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'clone_record',
    title: 'Clone a record (Forge)',
    description:
      'Clone one record from source into target with the records it needs and the ones that ' +
      "hang from it, as Forge's record clone and sandforge clone --record --json do. Run it with " +
      'dryRun: true first: it reads both orgs, counts what it would write and says what would ' +
      "stop a real run — the target's automation, its data storage, the emails its flows send — " +
      'and writes nothing. dryRun: false writes into target, a sandbox or a Developer Edition ' +
      'only, and needs confirm, the alias of target. acceptAutomation lets it write although the ' +
      'target runs automation as the records go in; acceptEmails, although the target delivers ' +
      'every email what still runs sends, or would not say whether it does, which ' +
      'acceptAutomation never stands for. muteAutomation keeps what the target runs quiet for ' +
      "the clone through the target's own bypass; what no bypass keeps quiet still needs " +
      'acceptAutomation. checkpointFirst takes a checkpoint of what ' +
      'the clone writes before its first write, and a dry run says what it would hold and cost. ' +
      'The answer names the run journal, which run_remove with module "forge" takes the run back ' +
      'from, and the checkpoint it took, which checkpoint_rewind returns the org to.',
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
      acceptEmails: acceptance(
        'Write although the target delivers every email of what still runs as the records go ' +
          'in, or would not say whether it does. acceptAutomation never stands for it. Only ' +
          'once the person using you has accepted that these emails go out.',
      ),
      muteAutomation: muteFor('the clone'),
      checkpointFirst: checkpointFirst('the clone'),
    }),
    writesTo: (args) => (args.dryRun ? undefined : args.target),
    writes: 'creates the records of the clone in it',
    readFirst: 'a dry run of the same clone says what it would write and meet',
    flags: {
      '--accept-automation': 'acceptAutomation',
      '--accept-emails': 'acceptEmails',
      '--mute-automation': 'muteAutomation',
    },
    after: (args, answer) =>
      args.dryRun ? [] : [...removalHint('forge', answer), ...rewindHint(answer)],
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
        ...(args.acceptEmails === true ? ['--accept-emails'] : []),
        ...(args.muteAutomation === true ? ['--mute-automation'] : []),
        ...checkpointFirstLine(args.checkpointFirst),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'clone_records',
    title: 'Clone records a query chooses (Forge)',
    description:
      'Clone from source into target the records a query chooses — object, with where, orderBy ' +
      `and limit, 1 to ${FORGE_ROOTS_MAX} —, or several records named by their ids ` +
      '(recordIds, of one object), each with the records it needs and the ones that hang from ' +
      'it, as sandforge clone --query --json does: a record they share is read and written once. ' +
      'Run it with dryRun: true first: it reads both orgs, says the records the query chose ' +
      'and per object what it would write, and what would stop a real run, and writes nothing. ' +
      'dryRun: false writes into target, a sandbox or a Developer Edition only, and needs ' +
      'confirm, the alias of target; the run reads the query again. acceptAutomation, ' +
      'acceptEmails, muteAutomation and checkpointFirst as for clone_record. maxReadTotal bounds ' +
      'the records it reads in all before it writes. The answer names the run journal, which ' +
      'run_remove with module "forge" takes the run back from.',
    readOnly: false,
    destructive: false,
    args: z
      .strictObject({
        source: alias('The org to read from: its sf CLI alias.'),
        target: alias('The org to write into: its sf CLI alias.'),
        object: z
          .string()
          .regex(API_NAME, 'an object API name')
          .optional()
          .describe('The object whose records the query chooses, by API name; or give recordIds.'),
        where: whereCondition()
          .optional()
          .describe(
            'With object: the condition its records are chosen by, without WHERE. It chooses the ' +
              'records cloned, and filters nothing they reach.',
          ),
        orderBy: z
          .string()
          .min(1)
          .max(SOQL_ROOT_ORDER_BY_MAX)
          .refine((text) => soqlOrderBySchema.safeParse(text).success, {
            message:
              'field paths, each with ASC or DESC and NULLS FIRST or LAST, separated by commas',
          })
          .optional()
          .describe(
            'With object: the order the records are chosen in, without ORDER BY (default Id): ' +
              'CreatedDate DESC, Id DESC takes the newest, the ids ordering those made in the ' +
              'same second.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(FORGE_ROOTS_MAX)
          .optional()
          .describe(
            `With object: the most records the query chooses and the run clones, 1 to ${FORGE_ROOTS_MAX}.`,
          ),
        recordIds: z
          .array(z.string().regex(RECORD_ID, 'a 15- or 18-character Salesforce record id'))
          .min(2)
          .max(FORGE_ROOTS_MAX)
          .optional()
          .describe(
            'In place of object: the records to clone, by their ids in source, two or more, all ' +
              'of one object; clone_record clones one.',
          ),
        depth: z
          .union([z.enum(['direct', 'full']), z.number().int().min(1).max(10)])
          .optional()
          .describe(
            'How far from each record discovery goes: "direct", "full", or a number of hops ' +
              '(default 5).',
          ),
        maxNodes: z
          .number()
          .int()
          .min(10)
          .max(500)
          .optional()
          .describe('How many objects discovery may reach (default 50).'),
        maxReadTotal: z
          .number()
          .int()
          .min(1)
          .max(10_000_000)
          .optional()
          .describe(
            'The most records the run reads in all before it writes (default 50,000): past it, ' +
              'it is refused, nothing written.',
          ),
        dryRun: z
          .boolean()
          .describe('true: read both orgs and say what a clone would do, writing nothing.'),
        confirm: confirmOf('target').optional(),
        acceptAutomation: acceptance(
          'Write although the target runs flows, Apex triggers, processes or workflow rules as ' +
            'the records go in, or would not say what it runs: only once the person using you ' +
            'has accepted what the dry run named.',
        ),
        acceptEmails: acceptance(
          'Write although the target delivers every email of what still runs as the records go ' +
            'in, or would not say whether it does. acceptAutomation never stands for it. Only ' +
            'once the person using you has accepted that these emails go out.',
        ),
        muteAutomation: muteFor('the clone'),
        checkpointFirst: checkpointFirst('the clone'),
      })
      .superRefine(refuseCloneRecords),
    writesTo: (args) => (args.dryRun ? undefined : args.target),
    writes: 'creates the records of the clone in it',
    readFirst: 'a dry run of the same clone says the records it chose and what it would write',
    flags: {
      '--accept-automation': 'acceptAutomation',
      '--accept-emails': 'acceptEmails',
      '--mute-automation': 'muteAutomation',
    },
    named: {
      '--query': rootsQueryWords,
      '--max-roots': `is this tool's limit, or the count of its recordIds: the records a run clones, 1 to ${FORGE_ROOTS_MAX}.`,
      '--max-read-total': "is this tool's maxReadTotal.",
      '--checkpoint-first': "is this tool's checkpointFirst: {} takes it with the defaults.",
      '--fit':
        'is clone_org_plan\'s fit: "share", a sample of the whole org, whose fitWhere draws ' +
        "an object's roots among the records a condition keeps.",
    },
    exits: {
      [NO_TERMINAL_EXIT]:
        'the clone refused what it was asked before any org was reached — a query its ' +
        'object, where, orderBy and limit make that cannot choose the records it clones ' +
        '(ROOTS_QUERY_REFUSED), records of two objects —: change the parameter it names, then ' +
        'dryRun: true again; nothing was read or written',
    },
    after: (args, answer) => [
      ...requiredFieldWords(args, answer),
      ...(args.dryRun ? [] : [...removalHint('forge', answer), ...rewindHint(answer)]),
    ],
    run: (args) => ({ script: 'sandforge-clone', args: cloneRecordsLine(args) }),
  }),
  tool({
    name: 'clone_org_plan',
    title: 'Plan a clone of the whole org (Forge)',
    description:
      'The dry run of a clone of the whole org from source into target, or of a sample of it ' +
      'that fits the target (fit: "share"), as sandforge clone --depth all --dry-run --json ' +
      'says it: per object the records it would write, the API requests, Bulk API batches, ' +
      'data storage and time it takes against what each org has left today, what it leaves out ' +
      'and why, and every refusal a run would meet, each with the parameter that lifts it. It ' +
      'reads both orgs and writes nothing to either. A plan that would go is kept on this ' +
      "machine for a day, its owner's alone — of a sample, the ids of the records it drew — and " +
      'comes back with its id and the question a terminal would ask before the first write: ' +
      'show the person both; clone_org with that plan and confirm writes it and nothing else. ' +
      'Every personal field is anonymized, always. acceptAutomation, acceptEmails, ' +
      'muteAutomation and checkpointFirst are given here, to the plan, which says what was ' +
      'accepted; maxTotal bounds the records, excludedObjects, excludedFields and filters narrow ' +
      'the clone. A production target is refused.',
    readOnly: false,
    destructive: false,
    args: z
      .strictObject({
        source: alias('The org to read from: its sf CLI alias.'),
        target: alias('The org the plan writes into: its sf CLI alias.'),
        fit: z
          .enum(['share'])
          .optional()
          .describe(
            '"share": a sample of the org rather than every record — roots drawn of each ' +
              'object, each with its children and the records it names, none without a record ' +
              'it cannot be written without —, the largest share that fits what the target ' +
              'has left and maxTotal.',
          ),
        fitWithinMB: z
          .number()
          .min(0.01)
          .max(FIT_WITHIN_MOST_MB)
          .optional()
          .describe('With fit: take no more than this many MB of the target.'),
        fitSeed: z
          .number()
          .int()
          .min(0)
          .max(999_999_999_999_999)
          .optional()
          .describe('With fit: the seed the roots are drawn by (default 1).'),
        fitDraw: z
          .enum(['uniform', 'recent', 'oldest'])
          .optional()
          .describe(
            'With fit: "uniform" spreads the roots over each object (default), "recent" takes ' +
              'the newest by their creation date, "oldest" the oldest.',
          ),
        fitWindow: fitWindowArg(),
        fitWhere: z
          .array(
            z.strictObject({
              objectApiName: z.string().regex(API_NAME, 'an object API name'),
              where: whereCondition(),
            }),
          )
          .min(1)
          .max(FORGE_SAMPLE_MAX_ROOT_WHERE)
          .optional()
          .describe(
            "With fit: draw an object's roots only among its records that match, one condition " +
              'an object. Unlike filters, the records under or above the roots come whatever it ' +
              'says, and no lookup is written empty for it. Not of an object of fitWhole or ' +
              'excludedObjects.',
          ),
        fitStrata: fitStrataArg(),
        fitParents: z
          .enum(['all', 'required'])
          .optional()
          .describe(
            'With fit: "all" copies a record outside the sample an optional lookup names ' +
              '(default), "required" writes such a lookup empty.',
          ),
        fitChildren: z
          .union([z.number().int().min(1).max(1_000_000), z.literal('all')])
          .optional()
          .describe('With fit: the most children a record brings through each relation (100).'),
        fitWhole: z
          .array(z.string().regex(API_NAME, 'an object API name'))
          .min(1)
          .max(500)
          .optional()
          .describe('With fit: objects copied whole, by API name.'),
        fitFloor: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe('With fit: the roots kept of each object whatever the share (default 1).'),
        maxTotal: z
          .number()
          .int()
          .min(1)
          .max(100_000_000)
          .optional()
          .describe(
            'The most records the clone may write in all (default 10,000): past it, its run ' +
              'is refused, and a sample is drawn within it.',
          ),
        excludedObjects: z
          .array(z.string().regex(API_NAME, 'an object API name'))
          .min(1)
          .max(500)
          .optional()
          .describe('Objects left out, by API name; what that costs is said.'),
        excludedFields: z
          .array(z.string().regex(OBJECT_FIELD, 'Object.Field, by API names'))
          .min(1)
          .max(500)
          .optional()
          .describe('Fields left out, as Object.Field.'),
        filters: z
          .array(
            z.strictObject({
              objectApiName: z.string().regex(API_NAME, 'an object API name'),
              where: z
                .string()
                .min(1)
                .max(512)
                .regex(ON_A_LINE, 'one line, not starting with "-"')
                .describe('A SOQL WHERE condition, without WHERE.'),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe('Conditions that narrow an object, each added to what the clone reads of it.'),
        anonymize: z
          .literal(true)
          .optional()
          .describe(
            'Always on, whether given or not: every personal field is anonymized by its ' +
              "category's default method. false is refused: no tool copies them as they are.",
          ),
        acceptAutomation: acceptance(
          'Plan the run with --accept-automation: it writes although the target runs flows, ' +
            'Apex triggers, processes or workflow rules as the records go in. Only once the ' +
            'person using you has accepted what a plan without it named.',
        ),
        acceptEmails: acceptance(
          'Plan the run with --accept-emails: it writes although the target delivers every ' +
            'email what still runs sends, or would not say whether it does. acceptAutomation ' +
            'never stands for it. Only once the person using you has accepted that they go out.',
        ),
        muteAutomation: muteFor('the clone'),
        checkpointFirst: checkpointFirst('the clone'),
      })
      .refine(
        (args) =>
          args.fit !== undefined ||
          [
            args.fitWithinMB,
            args.fitSeed,
            args.fitDraw,
            args.fitWindow,
            args.fitWhere,
            args.fitStrata,
            args.fitParents,
            args.fitChildren,
            args.fitWhole,
            args.fitFloor,
          ].every((value) => value === undefined),
        { message: 'the fit* parameters go with fit: "share"', path: ['fit'] },
      ),
    refuseFirst: (raw) =>
      raw.anonymize === false || ['acceptRealData', 'noAnonymize', 'realData'].some((k) => k in raw)
        ? `clone_org_plan: the personal fields cannot be left as they are. ${REAL_DATA_WORDS} ` +
          'Nothing was run.'
        : undefined,
    // The plans past their day and the runs whose journal is gone, swept as
    // a new plan is made: a receipt holds the ids of a production's records.
    prepare: async (_args, context) => {
      await sweepKept(context.journalDir, context.runs, context.now(), context.log);
      return { prepared: undefined };
    },
    flags: {
      '--accept-automation': 'acceptAutomation',
      '--accept-emails': 'acceptEmails',
      '--mute-automation': 'muteAutomation',
    },
    named: {
      '--max-total':
        "is this tool's maxTotal: the most records the clone may write. Give it the count the " +
        'dry run said only once the person using you has agreed to that many.',
      '--fit':
        'is this tool\'s fit: "share", a sample of the org that fits the target rather than ' +
        'every record.',
      '--fit-within': "is this tool's fitWithinMB.",
      '--fit-seed': "is this tool's fitSeed.",
      '--fit-draw': "is this tool's fitDraw.",
      '--fit-window':
        'is this tool\'s fitWindow: {field: "created" or "modified", from, to}, each a date or ' +
        'an instant in UTC, either left out, or {field, lastDays}.',
      '--fit-where': "is this tool's fitWhere, an objectApiName and the where its roots match.",
      '--fit-strata': "is this tool's fitStrata, a Field or an Object.Field.",
      '--fit-parents': "is this tool's fitParents.",
      '--fit-children': "is this tool's fitChildren.",
      '--fit-whole': "is this tool's fitWhole, an object by API name.",
      '--fit-floor': "is this tool's fitFloor.",
      '--exclude-object': "is this tool's excludedObjects, an object by API name.",
      '--exclude': "is this tool's excludedFields, as Object.Field.",
      '--filter': "is this tool's filters, an objectApiName and its where.",
      '--checkpoint-first': "is this tool's checkpointFirst: {} takes it with the defaults.",
      '--no-anonymize': `is no parameter of any tool. ${REAL_DATA_WORDS}`,
      '--yes':
        "is clone_org's to give: once the person has said yes to the plan's question, " +
        'clone_org with the plan and confirm writes it without asking again.',
    },
    exits: {
      [FAILED_EXIT]:
        'refused, or a run of this plan would be: each refusal is said above, with the ' +
        'parameter that lifts it; no plan was kept',
      [NO_TERMINAL_EXIT]:
        'refused for what it was asked, before any record was drawn: a window, a condition ' +
        'of the roots or a stratum the source cannot take, or two parameters that do not go ' +
        'together, each said above with the parameter of its flag; no plan was kept',
    },
    run: (args) => ({
      script: 'sandforge-clone',
      args: cloneOrgPlanLine(args),
      relayedBy: CLONE_ORG_PLAN_RELAY,
    }),
    settle: (args, _prepared, settling) => keepThePlan(args, settling),
  }),
  tool({
    name: 'clone_org',
    title: 'Clone the whole org (Forge)',
    description:
      'Write the plan clone_org_plan kept, and nothing else: its records into its target, as ' +
      'sandforge clone --depth all writes them, as Bulk API jobs from 2000 records of an object ' +
      'and by REST under that. plan is the id clone_org_plan gave, good for a day; confirm is ' +
      "the alias of the plan's target, given once the person has said yes to the question the " +
      'plan came back with, which the run then does not ask again. A sample writes the records ' +
      'its dry run drew, a plan of every record no more than its dry run counted: a source or ' +
      'a target that changed since is refused, nothing written, and needs a new plan. It takes ' +
      'no scope of its own. resume: true takes up the run of the plan that stopped part way, ' +
      'from its journal. Once a run has ended, the server verifies what it wrote, and says the ' +
      'verification first unless VERIFIED. The answer names the journal, which run_remove with ' +
      'module "forge" takes the run back from. A plan already written, gone or past its day is ' +
      'refused before anything is read.',
    readOnly: false,
    destructive: false,
    args: z.strictObject({
      plan: z
        .string()
        .regex(PLAN_ID, 'the id of a plan clone_org_plan kept, co-...')
        .describe('The plan clone_org_plan kept, by the id its answer gave.'),
      confirm: confirmOf("the plan's target").optional(),
      resume: z
        .literal(true)
        .optional()
        .describe(
          'Take up the run of this plan that stopped part way, from its journal, writing ' +
            'nothing it wrote.',
        ),
    }),
    refuseFirst: (raw) => {
      const scope = Object.keys(raw).filter((key) => !CLONE_ORG_ARGS.includes(key));
      if (scope.length === 0) return undefined;
      return (
        `clone_org takes a plan, not its scope: ${scope.join(', ')} ` +
        `${scope.length === 1 ? 'is' : 'are'} clone_org_plan's to give. clone_org_plan with ` +
        `${scope.length === 1 ? 'it' : 'them'} plans again: show the person its question, then ` +
        'clone_org with its plan and confirm. Nothing was run.'
      );
    },
    prepare: (args, context) => planToWrite(args, context),
    writesTo: (_args, prepared) => prepared.receipt.target,
    writes: 'writes into it the records of the plan, and nothing else',
    readFirst: 'clone_org_plan says what it would write, with the question to answer',
    named: {
      '--resume':
        "is this tool's resume: true, with the plan and confirm: it takes the run up from its " +
        'journal.',
      '--remove':
        'is run_remove, with module "forge", the org the run wrote to and its journal: ' +
        'preview: true first says what it would delete.',
      '--max-total':
        "is no parameter of clone_org, which holds a run to the count its plan's dry run gave: " +
        'clone_org_plan again plans with the source as it is now.',
      '--no-anonymize': `is no parameter of any tool. ${REAL_DATA_WORDS}`,
    },
    beforeStart: async (args, prepared, launch, context) => {
      // Kept in the receipt before the script starts: a server ended in the
      // middle leaves a plan that reads as written, never as one to write again.
      await makePrivateDir(runsDirOf(context.journalDir));
      await addClonePlanRun(context.journalDir, prepared.receipt.id, {
        run: launch.handle,
        startedAt: context.now().toISOString(),
        summary: launch.summary,
        resume: args.resume === true,
      });
    },
    run: (args, prepared, launch) => ({
      script: 'sandforge-clone',
      args: clonePlanRunLine(prepared.receipt, {
        summary: launch.summary,
        ...(args.resume === true && prepared.journal !== undefined
          ? { resume: prepared.journal }
          : {}),
      }),
      relayedBy: CLONE_ORG_RELAY,
      follow: {
        plan: prepared.receipt.id,
        summary: launch.summary,
        ...(prepared.receipt.durationSeconds !== undefined
          ? { expectedSeconds: prepared.receipt.durationSeconds }
          : {}),
      },
    }),
    settle: (_args, prepared, settling) => settleCloneOrg(prepared, settling),
  }),
  tool({
    name: 'run_remove',
    title: "Remove a run's records",
    description:
      'Delete from org, into its recycle bin, what one run of Seed (module "seed"), Forge ' +
      '(module "forge") or Sync (module "sync") created, as that script\'s --remove --json does; ' +
      'a Sync run also gives the records it wrote over their values back. run is the summary ' +
      "file the run's --json was saved to, its run file or journal, or, for Seed and Sync, its " +
      'run id. Records changed since the run are kept, unless includeChanged. A production org ' +
      'is refused. preview: true, for a Seed or Forge run, says per object what it would delete, ' +
      'what is gone already, what changed since and who changed it, and what a removal would be ' +
      'refused for, deleting nothing and needing no confirm; otherwise it needs confirm, the ' +
      'alias of org. A run of this server still running is refused: run_stop stops it first. ' +
      'acceptAutomation lets it delete although ' +
      'the org runs automation as the records go; muteAutomation keeps that automation quiet ' +
      "for the removal through the org's own bypass. Where its user may not delete the records " +
      'of some objects of the run, it stops before its first delete, unless leaveUndeletable. ' +
      "store, for a Sync run of a saved configuration, is that configuration's store, which " +
      'the removal tells what it took.',
    readOnly: false,
    destructive: true,
    args: z
      .strictObject({
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
        includeChanged: acceptance(
          'Take also the records changed since the run, and what was added to them since: on a ' +
            "shared sandbox, others' work. Only once the person using you has accepted it.",
        ),
        acceptAutomation: acceptance(
          'Delete although the org runs flows, Apex triggers, processes or workflow rules as the ' +
            'records go, or would not say what it runs: only once the person using you has ' +
            'accepted it.',
        ),
        muteAutomation: acceptance(
          'Keep quiet what the org runs as the records go, through its own bypass: the removal ' +
            'assigns the permission sets holding it to the user it deletes as, for the removal ' +
            'alone, under a lease, and takes them back as it ends; what no bypass keeps quiet ' +
            'still needs acceptAutomation. Refused on a production org and for a user who cannot ' +
            'assign permission sets. Only once the person using you has agreed to it.',
        ),
        leaveUndeletable: acceptance(
          'Where the user the alias connects as may not delete the records of some objects of ' +
            'the run, remove the rest and leave those, with the records they hang from; without ' +
            'it the removal stops before its first delete and names them. Only once the person ' +
            'using you has accepted it.',
        ),
        store: z
          .string()
          .min(1)
          .max(4096)
          .regex(ON_A_LINE, 'one line, not starting with "-"')
          .optional()
          .describe(
            'module "sync" only: the directory the saved configuration the run was of is kept in, ' +
              "the run's --store, which the removal tells what it took, so that its next delta " +
              'run reads those objects whole; a relative path is read from where the server was ' +
              'started. The person using you names it.',
          ),
        preview: acceptance(
          'module "seed" or "forge": say what the removal would do, and do nothing — per object ' +
            'the records it would delete, those gone already, those changed since the run and ' +
            'who changed them, and what a removal now would be refused for. It reads the org, ' +
            'deletes nothing, and takes no confirm.',
        ),
      })
      .refine((args) => args.store === undefined || args.module === 'sync', {
        message: 'store goes with module "sync": a Seed or Forge run keeps no configuration',
        path: ['store'],
      })
      .refine((args) => args.preview !== true || args.module !== 'sync', {
        message:
          'preview goes with module "seed" or "forge": the removal of a Sync run has none, and ' +
          'says what it gives back as it does it',
        path: ['preview'],
      }),
    // A removal under way of a run still writing would delete what the run
    // goes on writing under it. The script refuses that itself (RUN_WRITING),
    // naming the process that writes; the server refuses first a run it runs
    // itself, naming its handle, which run_stop stops.
    prepare: async (args, context) => {
      const under = await runUnderWay(context.runs, args.run);
      return under ? { refusal: runUnderWayRefusal(under, args.run) } : { prepared: undefined };
    },
    writesTo: (args) => (args.preview === true ? undefined : args.org),
    writes: 'deletes the records the run created, into the recycle bin',
    readFirst:
      'run_remove with preview: true (a Seed or Forge run) says what it would delete, deleting ' +
      'nothing',
    flags: {
      '--include-changed': 'includeChanged',
      '--accept-automation': 'acceptAutomation',
      '--mute-automation': 'muteAutomation',
      '--leave-undeletable': 'leaveUndeletable',
    },
    named: {
      '--store':
        "is this tool's store: the directory of the run's saved configuration, as the person " +
        'using you names it.',
      '--preview':
        "is this tool's preview: true, for a Seed or Forge run: it says what the removal would " +
        'delete, and deletes nothing.',
    },
    run: (args) => ({
      script: REMOVAL_SCRIPT[args.module],
      args: [
        '--remove',
        args.run,
        '--target',
        args.org,
        ...(args.preview === true ? ['--preview'] : []),
        ...(args.includeChanged === true ? ['--include-changed'] : []),
        ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
        ...(args.muteAutomation === true ? ['--mute-automation'] : []),
        ...(args.leaveUndeletable === true ? ['--leave-undeletable'] : []),
        ...(args.store !== undefined ? ['--store', args.store] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'run_status',
    title: 'Follow a run',
    description:
      'How far a run is that a call handed back, by its handle (mr-...): a call whose script ' +
      `still runs after ${Math.round(holdMsOf() / 1000)} seconds answers with one. While it ` +
      "runs, its time against its plan's, what it wrote so far, its journal and its script's " +
      'last lines; once it has ended, the answer its call would have given, the verification ' +
      'of a clone included. waitSeconds waits that long for its end first (default 30, 50 at ' +
      'most). A run of a server that has ended since is read off this machine: what it wrote, ' +
      'and the calls that take it up or back. Reads this machine alone.',
    readOnly: true,
    args: z.strictObject({
      run: z
        .string()
        .regex(RUN_HANDLE, 'the handle of a run, mr-...')
        .describe('The run, by the handle the call that started it answered with.'),
      waitSeconds: z
        .number()
        .min(0)
        .max(WAIT_SECONDS_MOST)
        .optional()
        .describe(`How long to wait for its end first, in seconds (default 30).`),
    }),
    run: (args) => ({
      local: (context) => runStatus(context, args.run, args.waitSeconds ?? RUN_STATUS_WAIT_SECONDS),
    }),
  }),
  tool({
    name: 'run_stop',
    title: 'Stop a run',
    description:
      'Stop a run a call handed back, by its handle, as Ctrl-C stops its script on a terminal: ' +
      'before its next call to the org, what it wrote kept in its journal, a Bulk API job still ' +
      'open aborted and one the org is writing left to end. Only when the person using you ' +
      'asks. It waits a while for the run to end, then answers as run_status does, with the ' +
      'calls that take the run up or back.',
    readOnly: false,
    destructive: false,
    args: z.strictObject({
      run: z
        .string()
        .regex(RUN_HANDLE, 'the handle of a run, mr-...')
        .describe('The run, by the handle the call that started it answered with.'),
    }),
    run: (args) => ({ local: (context) => runStop(context, args.run) }),
  }),
  tool({
    name: 'checkpoint_list',
    title: 'List checkpoints',
    description:
      'The checkpoints of org kept on this machine, newest first, with what a rewind and an ' +
      'undo can still reach, and of one that no longer rewinds it, the dry run of its replay ' +
      'into another org; then the replays into org kept on this machine (replays), each with ' +
      'the records it left there, which checkpoint_replay_remove takes back. Reads this machine ' +
      "alone, and never contacts an org. Named org only: the other orgs' names and aliases " +
      'never reach the agent.',
    readOnly: true,
    args: z.strictObject({
      org: alias('The org, by its sf CLI alias: its checkpoints alone.'),
    }),
    after: (_args, answer) => replayWithHints(answer),
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: ['list', '--org', args.org, '--json'],
    }),
    settle: (args, _prepared, settling) => withReplays(args.org, settling),
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
    named: REWIND_FLAGS_OF_ITS_PREVIEW,
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
      maxTotal: z
        .number()
        .int()
        .min(1)
        .max(CHECKPOINT_MAX_TOTAL_MOST)
        .optional()
        .describe(
          'The most records it holds, all objects together (default 500,000, a million at ' +
            'most): past it, it is refused before reading any, the refusal naming --max-total, ' +
            'which this sets.',
        ),
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
        ...(args.maxTotal !== undefined ? ['--max-total', String(args.maxTotal)] : []),
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
      'as the rewind writes, without acceptEmails when the org delivers every email what still ' +
      'runs sends, or would not say whether it does, without acceptNoUndo when Undo could not ' +
      'bring back records it deletes, without acceptRecreate when records no longer in the ' +
      'recycle bin would be made again with new Ids, without acceptUnseen when, for a user ' +
      'without View All Data and Modify All Data, what it deletes takes along records the user ' +
      'is not proven to see. ' +
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
      acceptEmails: acceptance(
        'Rewind although the org delivers every email its automation sends (Setup > ' +
          'Deliverability: All email), or would not say whether it does, and what still runs as ' +
          'the rewind writes sends some. acceptAutomation never stands for it. Only once the ' +
          'person using you has accepted that these emails go out.',
      ),
      muteAutomation: muteActFor('the rewind'),
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
    flags: REWIND_FLAGS,
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
        ...(args.acceptEmails === true ? ['--accept-emails'] : []),
        ...(args.muteAutomation === true ? ['--mute-automation'] : []),
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
      'since the rewind stays, and is said. Needs confirm, the alias of org. acceptAutomation ' +
      'and acceptEmails as for checkpoint_rewind.',
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
      acceptEmails: acceptance(
        'Undo although the org delivers every email its automation sends (Setup > ' +
          'Deliverability: All email), or would not say whether it does, and what still runs as ' +
          'the undo writes sends some. acceptAutomation never stands for it. Only once the ' +
          'person using you has accepted that these emails go out.',
      ),
      muteAutomation: muteActFor('the undo'),
    }),
    writesTo: (args) => args.org,
    writes:
      'brings back what its last rewind deleted, gives back what it wrote over and sends back ' +
      'to the recycle bin what it brought back',
    readFirst: 'checkpoint_list says which rewind it would take back, and until when',
    flags: {
      '--accept-automation': 'acceptAutomation',
      '--accept-emails': 'acceptEmails',
      '--mute-automation': 'muteAutomation',
    },
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
        ...(args.acceptEmails === true ? ['--accept-emails'] : []),
        ...(args.muteAutomation === true ? ['--mute-automation'] : []),
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
    name: 'checkpoint_replay',
    title: 'Replay a checkpoint into another org',
    description:
      "Set a checkpoint's records up again in another org (target), parents first, with new " +
      'Ids, as sandforge checkpoint replay --json does: the sandbox its org became once ' +
      "refreshed, another sandbox, a scratch org. The checkpoint's own org is never reached, " +
      'and nothing target holds is changed or deleted. Run it with dryRun: true first: it reads ' +
      'target and says what it would create, link, leave and refuse — owners, record types, ' +
      'currencies, the files a checkpoint keeps no content of —, writing nothing. dryRun: false ' +
      'replays, with confirm, the alias of target, and maxRecords, the count its dry run said. ' +
      'A checkpoint of a Partial Copy, a Full or a Staging sandbox replays masked only (mask: ' +
      "true). file replays a .sfcheckpoint a teammate sent, its key read from the server's " +
      'environment by the variable keyEnv names, never given in an argument. verify: true ' +
      'counts what its last replay created there. again replays over what the replays before ' +
      'created there, which goes first. checkpoint_replay_remove takes a replay back. A ' +
      "production org, a sandbox marked Staging and the checkpoint's own org are refused.",
    readOnly: false,
    destructive: true,
    args: z
      .strictObject({
        checkpoint: replayOf.checkpoint.optional(),
        from: replayOf.from,
        file: z
          .string()
          .min(1)
          .max(4096)
          .regex(ON_A_LINE, 'one line, not starting with "-"')
          .optional()
          .describe(
            'In place of checkpoint: a .sfcheckpoint file a teammate sent, replayed without its ' +
              "org, the key standing for the teammate's consent; a relative path is read from " +
              'where the server was started. With keyEnv.',
          ),
        keyEnv: z
          .string()
          .regex(ENV_VARIABLE, 'the name of an environment variable')
          .refine((name) => parseArchiveKey(name) === undefined, {
            message:
              'the name of the variable that holds the key, never the key: a key in the ' +
              "arguments stays in the agent's context and in its client's logs",
          })
          .optional()
          .describe(
            "With file: the name of the variable of the server's environment that holds its " +
              'key, which the person using you set where the server is started. Never the key.',
          ),
        target: alias(
          'The org the records go into: its sf CLI alias. A sandbox, a scratch org or a ' +
            'Developer Edition org.',
        ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'true: read target and say what the replay would do, writing nothing; false: ' +
              'replay, with maxRecords and confirm. Not with verify.',
          ),
        verify: z
          .literal(true)
          .optional()
          .describe(
            'Read target and count what the last replay of the checkpoint created there against ' +
              'what it said it created; writes nothing. Not with dryRun.',
          ),
        maxRecords: z
          .number()
          .int()
          .min(1)
          .max(REPLAY_MAX_RECORDS)
          .optional()
          .describe(
            'With dryRun: false: the most records it may create, the count its dry run said; ' +
              'more is refused before it writes.',
          ),
        confirm: confirmOf('target').optional(),
        objects: z
          .array(z.string().regex(API_NAME, 'an object API name'))
          .min(1)
          .max(500)
          .optional()
          .describe('Replay these objects of the checkpoint alone, by API name (default: all).'),
        excludedObjects: z
          .array(z.string().regex(API_NAME, 'an object API name'))
          .min(1)
          .max(500)
          .optional()
          .describe('Objects of the checkpoint to leave out, by API name.'),
        owners: z
          .enum(['same', 'me'])
          .optional()
          .describe(
            '"same" (default): a record keeps its owner where target has that user active, and ' +
              'goes to the user who replays otherwise; "me": every record to that user.',
          ),
        customSettings: acceptance(
          'Set up the custom settings the checkpoint holds too; a row target has already is ' +
            'kept, never written over.',
        ),
        mask: acceptance(
          "Mask personal data, as Forge's anonymization masks it: required of a checkpoint of a " +
            'Partial Copy, a Full or a Staging sandbox, which may hold real data.',
        ),
        again: acceptance(
          'Replay over what the replays of this checkpoint before created in target, which ' +
            'goes first, deleted. Only once the person using you has agreed to it.',
        ),
        acceptAutomation: acceptance(
          'Write although target runs flows, Apex triggers, processes or workflow rules as the ' +
            'records go in, or would not say what it runs: only once the person using you has ' +
            'accepted what the dry run named.',
        ),
        acceptEmails: acceptance(
          'Write although target delivers the emails what still runs sends, or would not say ' +
            'whether it does. acceptAutomation never stands for it. Only once the person using ' +
            'you has accepted that these emails go out.',
        ),
        muteAutomation: muteFor('the replay'),
        checkpointFirst: checkpointFirst('the replay'),
      })
      .superRefine(refuseReplay),
    refuseFirst: (raw) => {
      const keys = Object.keys(raw).filter((key) => /key/i.test(key) && key !== 'keyEnv');
      return keys.length > 0
        ? `checkpoint_replay takes no key (${keys.join(', ')}): a key in the arguments stays in ` +
            "the agent's context and in its client's logs. keyEnv names the variable of the " +
            "server's environment that holds it, which the person using you sets where the " +
            'server is started. Nothing was run.'
        : undefined;
    },
    writesTo: (args) => (args.dryRun === false ? args.target : undefined),
    writes: 'creates there the records of the checkpoint, with new Ids',
    readFirst: 'checkpoint_replay with dryRun: true says what it would create, link and leave',
    flags: {
      '--accept-automation': 'acceptAutomation',
      '--accept-emails': 'acceptEmails',
      '--mute-automation': 'muteAutomation',
    },
    named: {
      '--dry-run': "is this tool's dryRun: true.",
      '--verify': "is this tool's verify: true.",
      '--remove':
        'is checkpoint_replay_remove, with the checkpoint and the target: preview: true first ' +
        'says what it would delete.',
      '--again': "is this tool's again: true, once the person using you has agreed to it.",
      '--mask': "is this tool's mask: true.",
      '--max-records':
        "is this tool's maxRecords: the count the dry run said, once the person using you has " +
        'agreed to that many.',
      '--objects': "is this tool's objects, by API name.",
      '--exclude-object': "is this tool's excludedObjects, by API name.",
      '--owners': 'is this tool\'s owners: "same" or "me".',
      '--custom-settings': "is this tool's customSettings: true.",
      '--checkpoint-first': "is this tool's checkpointFirst: {} takes it with the defaults.",
      '--key-env':
        "is this tool's keyEnv: the name of a variable of the server's environment that holds " +
        'the key, never the key.',
      '--no-real-data':
        "is no parameter of any tool: the declaration that a sandbox's checkpoint holds no " +
        "real data is the person's, on a terminal, kept in the audit trail " +
        `(${commandOf('checkpoint')} replay … --no-real-data). mask: true replays it masked.`,
    },
    after: (args, answer) => (args.dryRun === true ? replayWriteHint(args, answer) : []),
    // Whatever its code: a configuration a replay lacks is a refusal, exit 1.
    settle: async (args, _prepared, { ran, parts }) => {
      const words = replayConfigWords(args, `${ran.stderr}\n${ran.stdout}`);
      return words === undefined ? parts : { ...parts, added: [...parts.added, words] };
    },
    run: (args) => ({ script: 'sandforge-checkpoint', args: checkpointReplayLine(args) }),
  }),
  tool({
    name: 'checkpoint_replay_remove',
    title: 'Take a replay back',
    description:
      'Delete from target, into its recycle bin, what the replays of a checkpoint created ' +
      'there, children first, the checkpoint kept or not, as sandforge checkpoint replay ' +
      '--remove --json does; records changed since are kept, unless includeChanged. preview: ' +
      'true says what it would delete, deleting nothing and needing no confirm; otherwise it ' +
      'needs confirm, the alias of target. sweep takes too what the automation of target made ' +
      'for those records, and sweepList lists it, deleting nothing and needing no confirm; ' +
      'sweepLate and sweepUntied take too what the list says came late, or is tied to nothing ' +
      'of the replay. acceptAutomation lets it delete although target runs automation as ' +
      "the records go; muteAutomation keeps that automation quiet through target's own " +
      'bypass. checkpoint_list names the replays into an org, by their checkpoint. A replay ' +
      'this server still runs into target is refused: run_stop stops it first. A production ' +
      'org is refused.',
    readOnly: false,
    destructive: true,
    args: z
      .strictObject({
        ...replayOf,
        target: alias('The org the replay went into: its sf CLI alias.'),
        preview: acceptance(
          'Say what the removal would delete, and delete nothing: it reads target, and takes ' +
            'no confirm.',
        ),
        confirm: confirmOf('target').optional(),
        sweep: acceptance(
          "Take too what target's automation made for the records of the replay. Only once the " +
            'person using you has seen, in a preview with it, what it takes.',
        ),
        sweepList: acceptance(
          'List what sweep would take, per object, and delete nothing: it reads target, and ' +
            'takes no confirm. Not with sweep, nor with preview, which lists it with sweep.',
        ),
        sweepLate: acceptance(
          'With sweep, take too what the list says came late, after the replay ended; with ' +
            'sweepList, say what it would take. Only once the person using you has seen it.',
        ),
        sweepUntied: acceptance(
          'With sweep, take too what the list says is tied to nothing of the replay, refused ' +
            'when another run of this machine wrote to target meanwhile; with sweepList, say ' +
            'what it would take. Only once the person using you has seen it.',
        ),
        includeChanged: acceptance(
          'Take also the records changed since the replay, and what was added under them since: ' +
            "on a shared sandbox, others' work. Only once the person using you has accepted it.",
        ),
        acceptAutomation: acceptance(
          'Delete although target runs flows, Apex triggers, processes or workflow rules as the ' +
            'records go, or would not say what it runs: only once the person using you has ' +
            'accepted it.',
        ),
        muteAutomation: muteActFor('the removal'),
      })
      .superRefine(refuseReplayOf)
      .superRefine(refuseReplaySweep),
    // A replay this server handed back may still be writing into target: a
    // removal now would delete under it what it goes on creating.
    prepare: (args, context) => {
      const busy = context.runs.busyWith(args.target);
      return Promise.resolve(
        !listsOnly(args) && busy?.meta.tool === 'checkpoint_replay'
          ? { refusal: replayUnderWayRefusal(busy, args.target) }
          : { prepared: undefined },
      );
    },
    writesTo: (args) => (listsOnly(args) ? undefined : args.target),
    writes: 'deletes from it, into its recycle bin, what the replays of the checkpoint created',
    readFirst:
      'checkpoint_replay_remove with preview: true says what it would delete, deleting nothing',
    flags: {
      '--include-changed': 'includeChanged',
      '--sweep': 'sweep',
      '--sweep-late': 'sweepLate',
      '--sweep-untied': 'sweepUntied',
      '--accept-automation': 'acceptAutomation',
      '--mute-automation': 'muteAutomation',
    },
    named: {
      '--preview':
        "is this tool's preview: true: it says what it would delete, and deletes nothing.",
      '--sweep-list':
        "is this tool's sweepList: true: it lists what the sweep would take, and deletes nothing.",
    },
    run: (args) => ({
      script: 'sandforge-checkpoint',
      args: [
        'replay',
        ...replayOfLine(args),
        '--target',
        args.target,
        '--remove',
        ...(args.preview === true ? ['--preview'] : []),
        ...(args.sweep === true ? ['--sweep'] : []),
        ...(args.sweepList === true ? ['--sweep-list'] : []),
        ...(args.sweepLate === true ? ['--sweep-late'] : []),
        ...(args.sweepUntied === true ? ['--sweep-untied'] : []),
        ...(args.includeChanged === true ? ['--include-changed'] : []),
        ...(args.muteAutomation === true ? ['--mute-automation'] : []),
        ...(args.acceptAutomation === true ? ['--accept-automation'] : []),
        ...(listsOnly(args) ? [] : ['--yes']),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'empty_preview',
    title: 'Preview an emptying',
    description:
      'What emptying objects of org, or every object people work in there, would do: per ' +
      'object the records it deletes and what the org deletes along with them, in the order it ' +
      'takes them; what will likely refuse, what blocks, what no undo would bring back, what it ' +
      'leaves out and why; the API requests, Bulk API batches and time against what the org has ' +
      'left today, and the recycle bin; what the user is not proven to see; what the org runs as ' +
      'the records go, and its emails; and every refusal a run with the same parameters would ' +
      'meet now. Reads the org, deletes nothing.',
    readOnly: true,
    args: z
      .strictObject({ org: alias('The org: its sf CLI alias.'), ...emptyScope })
      .refine(oneScope, { message: 'give objects or wholeOrg, one of them' }),
    flags: EMPTY_FLAGS,
    named: EMPTY_RUN_NAMED,
    run: (args) => ({
      script: 'sandforge-empty',
      args: [
        '--target',
        args.org,
        ...emptyScopeLine(args),
        ...emptyAccordLine(args),
        ...(args.acceptPeopleActive === true ? ['--accept-people-active'] : []),
        '--dry-run',
        '--json',
      ],
    }),
  }),
  tool({
    name: 'empty_run',
    title: 'Empty objects or an org',
    description:
      'Delete every record of the objects named of org, or of every object people work in ' +
      'there, with what the org deletes along with them: to the recycle bin, which ' +
      'empty_undo brings them back from, or for good with hardDelete. It reads the org as ' +
      'empty_preview does, says it all first in its answer, and deletes only when nothing ' +
      "refuses it. Given resume, the run id of the org's last emptying stopped part way, it " +
      'takes that run up instead. Needs confirm, the alias of org: empty_preview first. ' +
      'Refused without acceptAutomation when the org runs automation as the records go, ' +
      'without acceptEmails when the org delivers every email what still runs sends, or would ' +
      'not say whether it does, without acceptNoUndo when Undo could not bring back some ' +
      'records, without acceptPeopleActive while someone else changed records of these objects ' +
      "in the last hour, past the day's API requests or Bulk API batches, and on a production " +
      'org, always.',
    readOnly: false,
    destructive: true,
    args: z
      .strictObject({
        org: alias('The org: its sf CLI alias.'),
        confirm: confirmOf('org').optional(),
        ...emptyScope,
        resume: z
          .string()
          .regex(EMPTY_RUN, 'the run id of an emptying, em-...')
          .optional()
          .describe(
            "Take up the org's last emptying stopped part way, by its run id, in place of " +
              'objects or wholeOrg: on what its journal confirmed.',
          ),
      })
      .refine(oneScope, { message: 'give objects, wholeOrg or resume, one of them' }),
    writesTo: (args) => args.org,
    writes:
      'deletes every record of the objects named, or of every object people work in, with ' +
      'what the org deletes along with them',
    readFirst: 'empty_preview says what it would delete and meet, deleting nothing',
    flags: EMPTY_FLAGS,
    named: EMPTY_RUN_NAMED,
    after: (_args, answer) => emptyUndoHint(answer),
    run: (args) => ({
      script: 'sandforge-empty',
      args: [
        '--target',
        args.org,
        ...(args.resume !== undefined ? ['--resume', args.resume] : emptyScopeLine(args)),
        ...emptyAccordLine(args),
        ...(args.acceptPeopleActive === true ? ['--accept-people-active'] : []),
        '--yes',
        '--json',
      ],
    }),
  }),
  tool({
    name: 'empty_undo',
    title: 'Undo an emptying',
    description:
      "Bring back from the recycle bin what org's last emptying deleted, parents first, while " +
      'the bin holds them; the answer names what could not come back and why. Refused for a ' +
      'run that deleted for good. Needs confirm, the alias of org. acceptAutomation, ' +
      'acceptEmails and muteAutomation as for empty_run.',
    readOnly: false,
    destructive: true,
    args: z.strictObject({
      org: alias('The org: its sf CLI alias.'),
      run: z
        .string()
        .regex(EMPTY_RUN, 'the run id of an emptying, em-...')
        .describe("The org's last emptying, by the run id its answer gave."),
      confirm: confirmOf('org').optional(),
      acceptAutomation: acceptance(
        'Undo although the org runs flows, Apex triggers, processes or workflow rules as ' +
          'records are brought back, or would not say what it runs.',
      ),
      acceptEmails: acceptance(
        'Undo although the org delivers every email what still runs as records come back ' +
          'sends, or would not say whether it does. Only once the person using you has accepted ' +
          'that these emails go out.',
      ),
      muteAutomation: muteActFor('the undo'),
    }),
    writesTo: (args) => args.org,
    writes: "brings back from the recycle bin what the org's last emptying deleted",
    readFirst: "empty_run's answer names the run and whether its undo is offered",
    flags: EMPTY_UNDO_FLAGS,
    run: (args) => ({
      script: 'sandforge-empty',
      args: ['--target', args.org, '--undo', args.run, ...emptyAccordLine(args), '--yes', '--json'],
    }),
  }),
  tool({
    name: 'env_plan',
    title: 'Plan an environment',
    description:
      'What env_apply would do to org from a sandforge.yaml (file), as sandforge env plan --json ' +
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
      acceptEmails: acceptance(
        'Plan what env_apply would do with acceptEmails: a seed or a clone is otherwise blocked ' +
          'where the org delivers the emails what still runs sends, or would not say whether it ' +
          'does.',
      ),
    }),
    flags: { '--accept-emails': 'acceptEmails' },
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
        ...(args.acceptEmails === true ? ['--accept-emails'] : []),
        '--json',
      ],
    }),
  }),
  tool({
    name: 'env_apply',
    title: 'Apply an environment',
    description:
      'Do to org what env_plan says, as sandforge env apply --yes --json does: plans again, then ' +
      'creates what the file declares, replaces what it is told to (replace: the resources, by ' +
      'name) and deletes the resources the file no longer holds, each by its own script, into ' +
      'the state kept on this machine; applied again, it writes nothing. A production org is ' +
      'refused, and a sandbox the file does not list. Needs confirm, the alias of org: env_plan ' +
      'first. acceptNoState lets it apply to an org this machine has no state of, where records ' +
      "an earlier apply left would be created twice. A resource's accept: { automation: true } " +
      'in the file is what lets its runs be taken back although the org runs automation. ' +
      'acceptEmails lets its resources write although the org delivers the emails what still ' +
      'runs sends, or would not say whether it does. The ' +
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
      acceptEmails: acceptance(
        'Apply although the org delivers every email its automation sends (Setup > ' +
          'Deliverability: All email), or would not say whether it does, and what still runs as ' +
          'its resources write sends some. Only once the person using you has accepted that ' +
          'these emails go out.',
      ),
    }),
    writesTo: (args) => args.org,
    writes:
      'creates, replaces and deletes the resources of the file there as its plan says, taking ' +
      'back the earlier runs a replace or a delete takes back',
    readFirst: 'env_plan of the same file says what it would do, writing nothing',
    flags: { '--accept-no-state': 'acceptNoState', '--accept-emails': 'acceptEmails' },
    named: { '--accept-automation': fileAcceptsAutomation('env_apply') },
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
        ...(args.acceptEmails === true ? ['--accept-emails'] : []),
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
      'into its recycle bin, as sandforge env destroy --yes --json does; what it cannot take ' +
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
    named: { '--accept-automation': fileAcceptsAutomation('env_destroy') },
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
  tool({
    name: 'pipeline_plan',
    title: 'Plan a pipeline',
    description:
      'What a run of a pipeline exported from the Automation page would do and refuse, as ' +
      'sandforge pipeline plan --json says it: each org of the file reached by its alias and ' +
      'typed, each step, and every refusal a run would meet before its first step, with what ' +
      "lifts it. It reads the orgs, on a copy of the pipeline's store, and writes nothing. No " +
      "tool runs a pipeline: its run is the person's, on a terminal, where its Approval steps " +
      'are asked. approve answers one ahead, as a run with no terminal is answered; vars and ' +
      "varEnvs give its variables, a secret by varEnvs, a variable of the server's " +
      'environment; acceptOrgs takes an org whose Organization Id changed since the export, a ' +
      'sandbox refreshed, once the person using you checked it is the one.',
    readOnly: true,
    args: z.strictObject({
      file: z
        .string()
        .min(1)
        .max(4096)
        .regex(ON_A_LINE, 'one line, not starting with "-"')
        .describe(
          'The pipeline file the Automation page exported (<name>.sandforge-pipeline.json), by ' +
            'its path; a relative path is read from where the server was started.',
        ),
      approve: z
        .array(z.string().min(1).max(200).regex(ON_A_LINE, 'one line, not starting with "-"'))
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Approval steps, by name, answered ahead, yes, as --approve answers them for a run ' +
            'with no terminal; never one before a write to a sandbox marked Staging.',
        ),
      vars: z
        .array(
          z.strictObject({
            name: z.string().regex(PIPELINE_VARIABLE, 'a variable of the pipeline, by its name'),
            value: z
              .string()
              .min(1)
              .max(2_000)
              .regex(/^[^\r\n]*$/, 'one line'),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('Variables of the pipeline and their values. A secret goes by varEnvs.'),
      varEnvs: z
        .array(
          z.strictObject({
            name: z.string().regex(PIPELINE_VARIABLE, 'a variable of the pipeline, by its name'),
            env: z.string().regex(ENV_VARIABLE, 'the name of an environment variable'),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Variables of the pipeline, each read from a variable of the server's environment: a " +
            'secret, which neither the file nor the arguments hold.',
        ),
      acceptOrgs: z
        .array(
          z.strictObject({
            key: z
              .string()
              .regex(PIPELINE_ORG_KEY, 'an org of the file, by its alias or its key in its orgs'),
            organizationId: z
              .string()
              .regex(ORGANIZATION_ID, 'an Organization Id, 00D and 12 or 15 letters and digits'),
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe(
          'Orgs of the file whose alias reaches an org of another Organization Id than the ' +
            "file's — a sandbox refreshed since —, taken for it once the person using you checked " +
            'it is the one: the org by its alias, or by its key in the file, and the Id the plan ' +
            'said, as its refusal (ORG_MOVED) names them.',
        ),
      store: z
        .string()
        .min(1)
        .max(4096)
        .regex(ON_A_LINE, 'one line, not starting with "-"')
        .optional()
        .describe(
          "Where the pipeline's runs keep their state, as its runs are given it: the plan reads " +
            "a copy of it. The default is the pipeline's folder under the journal folder.",
        ),
    }),
    refuseFirst: (raw) => {
      if ('org' in raw || 'orgs' in raw) {
        return (
          'pipeline_plan plans the orgs the file names, each by its alias in the file: a ' +
          'person maps one to another alias on a terminal, ' +
          `${commandOf('pipeline')} plan --file <file> --org <key>=<alias>. Nothing was run.`
        );
      }
      if (['dryRun', 'run', 'confirm'].some((key) => key in raw)) {
        return (
          "pipeline_plan only plans: no tool runs a pipeline. Its run is the person's, on a " +
          `terminal, ${commandOf('pipeline')} run --file <file> --dry-run first. Nothing was run.`
        );
      }
      return undefined;
    },
    named: {
      '--approve':
        "is this tool's approve: the Approval steps answered ahead, by name; never one before " +
        'a write to a sandbox marked Staging, which a person answers at a terminal.',
      '--accept-org':
        "is this tool's acceptOrgs: the org by its alias, or by its key in the file, and the " +
        'Organization Id taken for it, once the person using you checked it is the one.',
      '--var': "is this tool's vars, a name and its value; a secret goes by varEnvs.",
      '--var-env':
        "is this tool's varEnvs, a name and the variable of the server's environment that holds " +
        'its value.',
      '--store': "is this tool's store.",
      '--org':
        'is no parameter of pipeline_plan, which plans the aliases the file names: a person maps ' +
        'an org of the file to another alias on a terminal, ' +
        `${commandOf('pipeline')} plan --file <file> --org <key>=<alias>.`,
      '--confirm-rewind':
        'is no parameter of any tool: a Rewind step is confirmed by the person, on a terminal, ' +
        `${commandOf('pipeline')} confirm --file <file>.`,
    },
    exits: {
      [NO_TERMINAL_EXIT]:
        'the plan refuses: a run would be refused before its first step, or the file does not ' +
        'read, each refusal said above with what lifts it; nothing ran',
    },
    run: (args) => ({ script: 'sandforge-pipeline', args: pipelinePlanLine(args) }),
    settle: (args, _prepared, settling) =>
      Promise.resolve({
        ...settling.parts,
        added: [...settling.parts.added, pipelineRunWords(args.file)],
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
async function seedTemplates(): Promise<ToolResult> {
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
  return answered(
    templates.map(
      (t) =>
        `${t.id} — ${t.name}: ${t.records} records at most in ${t.objects.length} objects ` +
        `(${t.objects.map((o) => `${o.objectApiName} ${o.records}`).join(', ')})`,
    ),
    { templates },
    false,
  );
}

// ─── What a call answers ─────────────────────────────────────────────────────

/** A `tools/call` result, before the revision's fields are put on it. */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** A result of lines and of what they say as JSON, the JSON following the lines. */
function answered(
  lines: readonly string[],
  structured: Record<string, unknown>,
  isError: boolean,
): ToolResult {
  return {
    content: [
      { type: 'text', text: lines.join('\n') },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    isError,
  };
}

/** A call refused before anything ran, as the scripts' own refusals are shaped. */
function refused(code: string, message: string): ToolResult {
  return answered([message], { refusal: { code, message } }, true);
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

/**
 * A run stopped part way, as Ctrl-C, a kill or a closed terminal stops it
 * (130, 143, 129): what it wrote is kept, and its answer names where. Told
 * nothing past "stopped", an agent whose seed or clone was cut had no line
 * that took it back, nor one that took it up.
 */
const STOPPED: ReadonlySet<number> = new Set(STOP_SIGNALS.map((signal) => stopExitCode(signal)));

/** What the prompt says when no terminal can answer its question (`prompt.ts`). */
const NO_TERMINAL = 'no terminal to answer';

/** Whether a text names a flag (`--accept-automation`: letters and hyphens), as a word of its own. */
const names = (text: string, flag: string): boolean =>
  new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);

/** A word of a line as a shell reads it: as it is, or quoted. */
function shellWord(arg: string): string {
  return /^[\w.@:+/=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** A script's line as a person would type it. */
export function commandText(script: Script, args: readonly string[]): string {
  const quoted = args.map(shellWord);
  return ['pnpm exec tsx', `packages/extension/cli/${script}.ts`, ...quoted].join(' ');
}

/**
 * The refusal a script said on a line of its own, `refused (CODE): message`,
 * when it answered no JSON: a line it refused before any org was reached, a
 * query the clone cannot take among them. Told only "exit 2", an agent had
 * the words but no code to tell one refusal from another.
 */
function lineRefusalOf(stderr: string): { code: string; message: string } | undefined {
  const said = /^refused \(([A-Z][A-Z0-9_]*)\): (.+)$/m.exec(stderr);
  return said ? { code: said[1] ?? '', message: (said[2] ?? '').trim() } : undefined;
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
 * A script's run as the call's result, in its parts: what the server says
 * first (`head`), the line it ran with the script's own lines (`said`), what
 * the server adds to them (`added`), and the JSON beside them.
 */
interface ResultParts {
  head: string[];
  said: string[];
  added: string[];
  structured: Record<string, unknown>;
  /** The script's own JSON, as `structured.answer` carries it. */
  answer: unknown;
  isError: boolean;
}

/** The result its parts make: the head, the script's lines, what the server adds, then the JSON. */
function assembled(parts: ResultParts): ToolResult {
  const lines = [...parts.head, ...(parts.head.length > 0 ? [''] : []), ...parts.said];
  if (parts.added.length > 0) lines.push('', ...parts.added);
  return answered(lines, parts.structured, parts.isError);
}

/**
 * A script's run as the call's result: its JSON as `answer`, beside its exit
 * code; its lines, then what the server adds to them — that a question it
 * asked is the person's to answer, which of its flags are this tool's
 * parameters, how to take the run back.
 */
export function resultOf(
  served: Pick<ServedTool, 'flags'> & Partial<Pick<ServedTool, 'exits' | 'named'>>,
  run: { script: Script; args: readonly string[] },
  ran: CommandRun,
  after: (answer: unknown) => string[] = () => [],
): ToolResult {
  return assembled(resultPartsOf(served, run, ran, after));
}

/** A script's run as the parts of the call's result: see {@link resultOf}. */
function resultPartsOf(
  served: Pick<ServedTool, 'flags'> & Partial<Pick<ServedTool, 'exits' | 'named'>>,
  run: { script: Script; args: readonly string[] },
  ran: CommandRun,
  after: (answer: unknown) => string[] = () => [],
): ResultParts {
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
  for (const [flag, line] of Object.entries(served.named ?? {})) {
    if (!names(text, flag)) continue;
    added.push(`${flag}, named above, ${typeof line === 'function' ? line(text) : line}`);
  }
  if (ANSWERED.has(ran.code)) added.push(...after(answer));
  else if (STOPPED.has(ran.code)) {
    const back = after(answer);
    if (back.length > 0) {
      added.push(
        'It stopped part way, between two calls to the org: what it wrote is kept, and said ' +
          'above.',
        ...back,
      );
    }
  }
  const lineRefusal = answer === undefined ? lineRefusalOf(ran.stderr) : undefined;
  return {
    head: [],
    said: lines,
    added,
    structured: {
      exitCode: ran.code,
      ...(answer !== undefined ? { answer } : {}),
      ...(lineRefusal !== undefined ? { refused: lineRefusal } : {}),
    },
    answer,
    isError: !ANSWERED.has(ran.code),
  };
}

// ─── Runs handed back ────────────────────────────────────────────────────────

/** How long `run_status` waits for a run's end unless told, in seconds. */
const RUN_STATUS_WAIT_SECONDS = 30;

/** What `work` settles to within `ms`, or nothing when it has not by then. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a call answers whose script still runs once it has held it: the
 * handle of its run, and the calls that follow and stop it. Not an error:
 * the run goes on, and its answer comes by `run_status`.
 */
function handedBack(
  run: McpRun<ToolResult>,
  line: { script: Script; args: readonly string[] },
): ToolResult {
  const { handle, meta } = run;
  return answered(
    [
      `ran: ${commandText(line.script, line.args)}`,
      `still running: run_status with run "${handle}" follows it (waitSeconds up to ` +
        `${WAIT_SECONDS_MOST}), and gives its answer once it has ended; run_stop with run ` +
        `"${handle}" stops it as Ctrl-C would, what it wrote kept. It runs as long as this ` +
        "server: closing the agent's session stops it the same way.",
    ],
    {
      running: {
        run: handle,
        tool: meta.tool,
        startedAt: meta.startedAt,
        ...(meta.expectedSeconds !== undefined ? { expectedSeconds: meta.expectedSeconds } : {}),
        ...(meta.plan !== undefined ? { plan: meta.plan } : {}),
        ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
      },
    },
    false,
  );
}

/** A run's answer once it has ended, as `run_status` gives it: its call's own, and that it ended. */
function endedResult(answer: ToolResult, handle: string): ToolResult {
  const structured = { ...answer.structuredContent, run: { run: handle, state: 'ended' } };
  return answered([answer.content[0]?.text ?? ''], structured, answer.isError);
}

/** What a run's summary says of it so far, as `run_status` says it. */
function summaryWords(summary: RunSummaryRead, records: number | undefined): string {
  return (
    `${summary.written} records written` +
    (records !== undefined ? ` of the ${records} its plan counted` : '') +
    `, of ${summary.objectsWritten} objects` +
    (summary.failed > 0 ? `, ${summary.failed} refused by the org` : '') +
    (summary.journal !== undefined ? `; its journal is ${summary.journal}` : '')
  );
}

/** How far a run of this server is, as `run_status` and `run_stop` say it while it goes on. */
async function progressResult(
  context: ToolContext,
  run: McpRun<ToolResult>,
  stopping = false,
): Promise<ToolResult> {
  const progress = await context.runs.progress(run);
  const plan =
    run.meta.plan !== undefined
      ? await readClonePlan(context.journalDir, run.meta.plan)
      : undefined;
  const { handle } = run;
  const lines = [
    `run "${handle}" of ${run.meta.tool} ` +
      (!run.running
        ? 'has ended, and what the server does after it — the verification of a clone — is ' +
          'under way'
        : stopping
          ? 'is stopping: it stops before its next call to the org, and says what it wrote'
          : 'is still running') +
      `: ${progress.elapsedSeconds} seconds since it started` +
      (progress.expectedSeconds !== undefined
        ? `, its plan said its writes take about ${progress.expectedSeconds}`
        : '') +
      '.',
    ...(progress.summary ? [`So far: ${summaryWords(progress.summary, plan?.totalRows)}.`] : []),
    ...(progress.tail.length > 0 ? ['Its last lines:', ...progress.tail] : []),
    `run_status with run "${handle}" follows it` +
      (run.running && !stopping ? `; run_stop with run "${handle}" stops it.` : '.'),
  ];
  return answered(
    lines,
    {
      running: {
        run: handle,
        tool: run.meta.tool,
        startedAt: run.meta.startedAt,
        state: run.running ? (stopping ? 'stopping' : 'running') : 'settling',
        elapsedSeconds: progress.elapsedSeconds,
        ...(progress.expectedSeconds !== undefined
          ? { expectedSeconds: progress.expectedSeconds }
          : {}),
        ...(plan ? { plan: { id: plan.id, records: plan.totalRows } } : {}),
        ...(progress.summary ? { summary: progress.summary } : {}),
        tail: progress.tail,
      },
    },
    false,
  );
}

/**
 * What is known of a run another server handed back, read off the disk:
 * that server has ended, which stopped the run as Ctrl-C stops it, and its
 * summary says how far it went. With it, the calls that take it up and back.
 */
async function fromDiskResult(
  context: ToolContext,
  handle: string,
  onDisk: RunOnDisk,
): Promise<ToolResult> {
  const { meta, summary } = onDisk;
  const state =
    summary?.state === 'running'
      ? 'its summary was last written while it ran: it was cut without saying it stopped'
      : summary?.state === 'interrupted'
        ? 'it stopped part way, as its summary says'
        : summary?.state === 'failed'
          ? 'it ended on an error, as its summary says'
          : summary?.state === 'ended'
            ? 'it ended, as its summary says'
            : 'no summary of it is left';
  const plan =
    meta.plan !== undefined ? await readClonePlan(context.journalDir, meta.plan) : undefined;
  const journal = summary?.journal;
  const lines = [
    `run "${handle}" of ${meta.tool} is not one of this server's: the server that started it ` +
      `at ${meta.startedAt} has ended, which stopped it as Ctrl-C stops it. ${state}` +
      (summary ? `: ${summaryWords(summary, plan?.totalRows)}` : '') +
      '.',
    ...(meta.tool === 'clone_org' && meta.plan !== undefined && meta.target !== undefined
      ? [
          `clone_org with plan "${meta.plan}", resume: true and confirm "${meta.target}" takes ` +
            'it up, writing nothing twice.',
        ]
      : []),
    ...(journal !== undefined && meta.target !== undefined
      ? [
          `run_remove with module "forge", org "${meta.target}" and run "${journal}" takes it ` +
            'back: preview: true first says what it would delete.',
        ]
      : []),
  ];
  return answered(
    lines,
    {
      run: {
        run: handle,
        state: 'gone',
        tool: meta.tool,
        startedAt: meta.startedAt,
        ...(meta.target !== undefined ? { target: meta.target } : {}),
        ...(meta.plan !== undefined ? { plan: meta.plan } : {}),
        ...(summary ? { summary } : {}),
      },
    },
    false,
  );
}

/** A handle no server of this machine handed back. */
function runUnknown(handle: string): ToolResult {
  return refused(
    'RUN_UNKNOWN',
    `No run "${handle}" on this machine: this server holds none by that handle, and no server ` +
      'before it left one. A call answers with the handle of its run only when it is still ' +
      'running after its hold; the handle is in that answer.',
  );
}

/** `run_status`: how far a run is, or its answer once it has ended. */
async function runStatus(
  context: ToolContext,
  handle: string,
  waitSeconds: number,
): Promise<ToolResult> {
  const run = context.runs.get(handle);
  if (run) {
    const final = context.finalOf(handle);
    const seconds = Math.min(Math.max(0, waitSeconds), WAIT_SECONDS_MOST);
    const answer = final ? await within(final, seconds * 1000) : undefined;
    return answer ? endedResult(answer, handle) : progressResult(context, run);
  }
  const onDisk = await context.runs.readOnDisk(handle);
  return onDisk ? fromDiskResult(context, handle, onDisk) : runUnknown(handle);
}

/** `run_stop`: stop a run as Ctrl-C stops it, then say what became of it. */
async function runStop(context: ToolContext, handle: string): Promise<ToolResult> {
  const run = context.runs.get(handle);
  if (run) {
    const wasRunning = run.running;
    if (wasRunning) {
      context.log(`sandforge mcp: run_stop stops ${handle} as Ctrl-C stops its script`);
      run.stop();
    }
    const final = context.finalOf(handle);
    const answer = final ? await within(final, context.runs.holdMs) : undefined;
    if (!answer) return progressResult(context, run, wasRunning);
    const ended = endedResult(answer, handle);
    if (wasRunning) return ended;
    return answered(
      [`run "${handle}" had already ended: nothing was stopped.`, '', ended.content[0]?.text ?? ''],
      ended.structuredContent,
      ended.isError,
    );
  }
  const onDisk = await context.runs.readOnDisk(handle);
  return onDisk ? fromDiskResult(context, handle, onDisk) : runUnknown(handle);
}

/**
 * The run of this server, still running, that writes the run a removal
 * names: by the summary it writes, or by the journal that summary names.
 */
async function runUnderWay(
  runs: McpRuns<ToolResult>,
  named: string,
): Promise<McpRun<ToolResult> | undefined> {
  const asked = resolve(named);
  const bySummary = runs
    .all()
    .find(
      (run) => run.running && run.meta.summary !== undefined && resolve(run.meta.summary) === asked,
    );
  return bySummary ?? (await runs.underWayWith(named));
}

/** The refusal of a removal of a run this server still runs. */
function runUnderWayRefusal(run: McpRun<ToolResult>, named: string): Refusal {
  return {
    code: 'RUN_UNDER_WAY',
    message:
      `run_remove: ${named} is the run "${run.handle}" of ${run.meta.tool}, which this server ` +
      'still runs: a removal now would delete under it what it goes on writing. run_stop with ' +
      `run "${run.handle}" stops it, and run_status says when it has ended; then run_remove ` +
      'takes back what it wrote. Refused: nothing was read or written.',
  };
}

/** The refusal of the removal of a replay this server still runs into `target`. */
function replayUnderWayRefusal(run: McpRun<ToolResult>, target: string): Refusal {
  return {
    code: 'RUN_UNDER_WAY',
    message:
      `checkpoint_replay_remove: run "${run.handle}" of checkpoint_replay, which this server ` +
      `still runs, writes into ${target}: a removal now would delete under it what it goes on ` +
      `creating. run_stop with run "${run.handle}" stops it, and run_status says when it has ` +
      'ended; then checkpoint_replay_remove takes back what it created. Refused: nothing was ' +
      'read or written.',
  };
}

/**
 * Remove what no run will need any longer: the plans past their day, with
 * their copies, and the files of runs whose journal is gone — a receipt and
 * a summary hold the ids of a production's records. A plan a run of this
 * server still writes is kept. What cannot be removed is said, never the
 * call's failure.
 */
async function sweepKept(
  journalDir: string,
  runs: McpRuns<ToolResult>,
  now: Date,
  log: (line: string) => void,
): Promise<void> {
  try {
    const writing = new Set(
      runs
        .all()
        .filter((run) => run.running)
        .map((run) => run.meta.plan),
    );
    await sweepClonePlans(journalDir, now, (id) => writing.has(id));
    await runs.sweep();
  } catch (err: unknown) {
    log(
      'sandforge mcp: the plans and runs past their day could not all be removed: ' +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  /** Where the scripts keep their journals: `SANDFORGE_JOURNAL_DIR`, or `~/.sandforge`. */
  journalDir?: string;
  /** How long a call holds its script before it hands the run back: `SANDFORGE_MCP_HOLD_SECONDS`. */
  holdMs?: number;
  /** This machine's clock. */
  now?: () => Date;
}

export interface Serving {
  /** Settles once the input has ended and every call under way with it. */
  done: Promise<void>;
  /**
   * Stops every call under way and every run handed back, as Ctrl-C stops a
   * script, and settles once they have ended.
   */
  stop: () => Promise<void>;
}

/**
 * Serve the tools to the client whose messages `input` carries. Each request
 * is answered as it ends, calls running side by side; a call the client
 * cancels is stopped as Ctrl-C stops its script, and gets no answer. A call
 * whose script still runs once it has held it `holdMs` answers with the
 * handle of its run, which goes on: `run_status` follows it, `run_stop`
 * stops it. Once the input ends, the calls and the runs still running are
 * stopped the same way.
 */
export function serve(options: ServeOptions): Serving {
  const runCommand = options.runCommand ?? TOOL_RUNNER;
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const journalDir = options.journalDir ?? journalDirOf();
  const now = options.now ?? (() => new Date());
  const runs = new McpRuns<ToolResult>({
    dir: runsDirOf(journalDir),
    holdMs: options.holdMs ?? holdMsOf(),
    now,
  });
  /** The answer each run gives once it has ended, by handle: made once, whoever asks. */
  const finals = new Map<string, Promise<ToolResult>>();
  const stopping = new AbortController();
  const context: ToolContext = {
    journalDir,
    runs,
    now,
    log,
    runCommand,
    stopping: stopping.signal,
    finalOf: (handle) => finals.get(handle),
  };
  /** The revision `initialize` agreed on, for the requests that do not name one. */
  let handshake: string | undefined;
  /** The calls whose script runs and whose answer is not given yet, by request. */
  const running = new Map<RequestId, McpRun<ToolResult>>();
  /** The calls not answered yet, their script started or not. */
  const calling = new Set<RequestId>();
  const cancelled = new Set<RequestId>();
  const pending = new Set<Promise<unknown>>();
  /** Keep `work` among what the server waits for before it ends. */
  const held = <T>(work: Promise<T>): Promise<T> => {
    // Settled either way: what fails is said by whoever awaits `work`.
    const kept: Promise<unknown> = work
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        pending.delete(kept);
      });
    pending.add(kept);
    return work;
  };

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
      `sandforge mcp: ${asked === agreed ? 'agreed on' : `asked for ${asked}, offered`} ${agreed}`,
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
    const handle = runs.newHandle();
    const launch: Launch = { handle, summary: runs.summaryPathOf(handle) };
    calling.add(id);
    try {
      const read = await served.read(params.arguments ?? {}, context, launch);
      // Cancelled while its plan or its runs were read: nothing ran, nothing is answered.
      if (cancelled.has(id)) return undefined;
      if ('refusal' in read) {
        return { result: completed(era, { ...refused(read.refusal.code, read.refusal.message) }) };
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
        const answer = await call.run.local(context);
        return cancelled.has(id) ? undefined : { result: completed(era, { ...answer }) };
      }
      return await runScript(id, era, served, call, call.run, launch);
    } finally {
      calling.delete(id);
      cancelled.delete(id);
    }
  };

  /**
   * Run a call's script under a run of the registry: its answer when it ends
   * within the hold, the handle of its run when it does not.
   */
  const runScript = async (
    id: RequestId,
    era: Era,
    served: ServedTool,
    call: Call,
    run: Extract<Run, { script: Script }>,
    launch: Launch,
  ): Promise<Outcome> => {
    const { handle } = launch;
    const { script, args, relayedBy, follow } = run;
    await call.beforeStart();
    log(`sandforge mcp: ${served.definition.name} runs ${commandText(script, args)}`);
    const started = runs.start(
      {
        handle,
        tool: served.definition.name,
        ...(call.writesTo !== undefined ? { target: call.writesTo } : {}),
        ...(follow?.plan !== undefined ? { plan: follow.plan } : {}),
        ...(follow?.summary !== undefined ? { summary: follow.summary } : {}),
        ...(follow?.expectedSeconds !== undefined
          ? { expectedSeconds: follow.expectedSeconds }
          : {}),
      },
      ({ signal, onStderr }) => {
        const told: RunOptions = { ...(relayedBy !== undefined ? { relayedBy } : {}), onStderr };
        return runCommand(script, args, signal, told).catch((err: unknown): CommandRun => ({
          code: FAILED_EXIT,
          stdout: '',
          stderr: `${nameOf(script)} could not be started: ${err instanceof Error ? err.message : String(err)}`,
        }));
      },
    );
    // What the call answers once the script has ended, and what follows its
    // end — a plan kept, a clone verified —: made once, whether the call
    // gives it or run_status does, and made even when nobody asks.
    const final = held(
      started.settled(async (ran) => {
        const parts = resultPartsOf(served, run, ran, call.after);
        if (!call.settle) return assembled(parts);
        try {
          return assembled(await call.settle({ ran, run, launch, parts, context }));
        } catch (err: unknown) {
          return assembled({
            ...parts,
            added: [
              ...parts.added,
              `What the server does once ${served.definition.name} has ended failed: ` +
                `${err instanceof Error ? err.message : String(err)}.`,
            ],
            isError: true,
          });
        }
      }),
    );
    finals.set(handle, final);
    running.set(id, started);
    // Cancelled while what it keeps before it starts was being written: it
    // stops as soon as it has started, as a call cancelled under way does.
    if (cancelled.has(id)) started.stop();
    try {
      const answer = await within(final, runs.holdMs);
      if (cancelled.has(id)) {
        await final;
        finals.delete(handle);
        return undefined;
      }
      if (answer !== undefined) {
        finals.delete(handle);
        return { result: completed(era, { ...answer }) };
      }
      // Kept in memory whatever the disk says: the handle answered is what
      // follows the run and stops it; the files are for a later server.
      await runs.handBack(started).catch((err: unknown) => {
        log(
          `sandforge mcp: what a later server reads of ${handle} could not be written: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
      log(`sandforge mcp: ${served.definition.name} handed back as ${handle}, still running`);
      return { result: completed(era, { ...handedBack(started, run) }) };
    } finally {
      running.delete(id);
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
    // A call not answered yet: its handle never reached the client, so its
    // run would go on unseen. One cancelled before its script started never
    // starts it, or stops it as it does; one already handed back is run_stop's.
    if (!calling.has(requestId)) return;
    cancelled.add(requestId);
    const run = running.get(requestId);
    if (!run) return;
    log(
      `sandforge mcp: request ${String(requestId)} cancelled: its script is stopped as Ctrl-C stops it`,
    );
    run.stop();
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
    if (!isRequestId(id) || calling.has(id)) {
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
    // The runs handed back go with the calls under way: nothing writes on
    // once the session that could see it has closed.
    stopping.abort();
    await runs.stopAll();
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

const HELP = `sandforge mcp — Seed, Forge's clone of a record, of the records a query chooses or of the
whole org, the removal of a run, the emptying of objects or of a whole org, Checkpoints and their
replay into another org, the environments of a sandforge.yaml and the plan of an Automation
pipeline, as tools for an AI agent, over the Model Context Protocol on stdio.

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

A clone of the whole org is planned first: clone_org_plan runs its dry run and keeps the plan,
for a day, in mcp-plans/ under the journal directory, its owner's alone; clone_org writes that
plan and nothing else, its personal fields always anonymized. A call whose script still runs
after the hold answers with the handle of its run, which goes on: run_status follows it,
run_stop stops it, and the server stops it as it ends. What a later server reads of it is kept
in mcp-runs/ under the journal directory.

checkpoint_replay replays a .sfcheckpoint file a teammate sent with the key the variable keyEnv
names holds in this server's environment: a key is never an argument. pipeline_plan plans a
pipeline and writes nothing; no tool runs one.

Environment:
  SANDFORGE_JOURNAL_DIR=<dir>   where the scripts keep their run files, journals and
                                checkpoints (default: ~/.sandforge), as each script's --help says
  ${HOLD_SECONDS_VARIABLE}=<s>
                                how long a call holds its script before it hands its run back,
                                0 to 55 seconds (default: 45), under the minute a client gives
                                a call before it cancels it

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
  // What servers before this one left past its day goes first: plans no run
  // will write, and the files of runs whose journal is gone.
  const journalDir = journalDirOf();
  await sweepKept(
    journalDir,
    new McpRuns<ToolResult>({ dir: runsDirOf(journalDir), holdMs: 0 }),
    new Date(),
    (line) => void process.stderr.write(`${line}\n`),
  );
  const serving = serve({ input: process.stdin, send, journalDir });
  // A client that went away reads no answer: the scripts still running are
  // stopped as Ctrl-C stops them, and the server ends.
  process.stdout.on('error', () => {
    void serving.stop().then(() => process.exit(0));
  });
  const release = onStopSignal((signal: StopSignal) => {
    void serving.stop().then(() => process.exit(stopExitCode(signal)));
  });
  process.stderr.write(
    `sandforge mcp: ${TOOLS.length} tools on stdio, MCP ${PROTOCOL_VERSION} (and ` +
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
