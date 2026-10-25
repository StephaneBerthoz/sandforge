#!/usr/bin/env tsx
/**
 * sandforge-env — apply a `sandforge.yaml` to an org: the data an
 * environment needs, declared in a project's repository, created, kept and
 * taken back, without the editor.
 *
 * It writes nothing to an org itself. Each resource is planned, applied,
 * previewed and taken back by the script that already does it —
 * `sandforge-clone` for a forge resource, `sandforge-frozen` for a frozen
 * resource, and
 * `sandforge-seed` for a seed resource — spawned with `--json` as the MCP
 * server spawns its tools, so every guard, gate and run file of the script
 * holds unchanged. What it adds is what no script has: the declared file, a
 * state of what was applied to which org, a plan, an order, and refusals of
 * its own (`env/envGuards.ts`). The checkpoints a file asks are taken,
 * previewed, rewound to and deleted by `sandforge-checkpoint`, the same way
 * (`env/envCheckpoints.ts`, `env/envRewind.ts`).
 *
 * What it reads in its own process: the file, the state, the plan's
 * arithmetic, the org's kind and its `/limits` — the guard needs them before
 * anything runs —; for a forge resource, its source's Organization Id and
 * the one row its record's query answers, which its fingerprint is of; for a
 * frozen resource, its dataset's digest, held to the file's pin; and the ids
 * of the records a resource created, read from its run's own files, that a
 * seed relation draws its parents from. Every record is written by a spawned
 * script.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-env.ts validate --file sandforge.yaml
 *   pnpm exec tsx packages/extension/cli/sandforge-env.ts plan --file sandforge.yaml --org pool-1
 *   pnpm exec tsx packages/extension/cli/sandforge-env.ts apply --file sandforge.yaml --org pool-1 --yes
 *   pnpm exec tsx packages/extension/cli/sandforge-env.ts destroy --file sandforge.yaml --org pool-1 --yes
 *   pnpm exec tsx packages/extension/cli/sandforge-env.ts reset --file sandforge.yaml --org pool-1 --yes
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Connection } from 'jsforce';
import type {
  EnvIssue,
  EnvPlan,
  EnvPlanDrift,
  EnvRefusalAnswer,
  EnvState,
  EnvStateList,
  EnvValidation,
} from '@sandforge/shared';
import { typeTarget, type TypedTarget } from '../src/core/precheck/orgKindLive.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  readApiBudget,
  readDataStorage,
  readEmailLimits,
  type LimitsTransport,
} from '../src/modules/forge/ForgeRunGate.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, endWith } from './exitCodes.js';
import { typed } from './prompt.js';
import { spawnCommand, type CommandRunner } from './scriptRunner.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { loadOrg, makeConn, type SfOrg } from './sfSession.js';
import { applyPlan, removalSubjectOf, runResultLines, type EnvStepDeps } from './env/envApply.js';
import { destroyEnvironment } from './env/envDestroy.js';
import {
  checkEnvFile,
  dependenciesOf,
  documentOf,
  pathText,
  readEnvFile,
  refusalLine,
  resolveEnvFile,
  unsetVariablesOf,
  type EnvFileRefusal,
  type EnvFileResolved,
} from './env/envFile.js';
import {
  dryRunLineOf,
  objectsOfRun,
  payloadOf,
  previewedRunsOf,
  previewLineOf,
  readDryRunOf,
  readPreviewOf,
  readRefreshOf,
  refreshLineOf,
  replacesInOneRun,
  type EnvKindRun,
} from './env/envKinds.js';
import { drawnOf, type EnvDrawn } from './env/envReferences.js';
import { StepAnswerError } from './env/kinds/common.js';
import { readForgeSource, type EnvSourceRead } from './env/kinds/forge.js';
import { frozenSasOf, readFrozenDataset, type EnvDatasetRead } from './env/kinds/frozen.js';
import {
  envTargetOf,
  noStateGuard,
  sameOrganization,
  stateRefusal,
  stateTargetRefusal,
  storeRefusal,
  targetRefusal,
  type EnvRefusal,
  type EnvTarget,
} from './env/envGuards.js';
import { defaultEnvLocksDir, envLockHolder, envLockLine } from './env/envLock.js';
import {
  CHECKPOINT_SCRIPT,
  checkpointEstimateLine,
  checkpointPreviewLine,
  checkpointStepsOf,
  driftOf,
  envCheckpointStoreOf,
  estimateReadOf,
  rewindPreviewLines,
  type CheckpointEstimateRead,
  type RewindPreview,
} from './env/envCheckpoints.js';
import {
  classifyResources,
  destructionPlan,
  envPlan,
  liveResources,
  planChanges,
  planDrifts,
  planLines,
  removalOrder,
  writes,
  type EnvActionDraft,
  type EnvBudget,
  type EnvDryRun,
  type EnvRunPreview,
} from './env/envPlan.js';
import {
  previewEnvRewind,
  rewindEnvironment,
  rewindQuestionOf,
  rewindRefusalOf,
  rewindResultLines,
  type EnvRewindInput,
} from './env/envRewind.js';
import {
  EnvStateError,
  envJournalDirOf,
  envRunIdOf,
  journalInsideRepository,
  nextRunNumber,
  openEnvStore,
  stateExpiresAt,
  type EnvStore,
} from './env/envState.js';

const HELP = `sandforge-env — apply a sandforge.yaml to an org: the data an environment needs, declared in
your repository, created, kept and taken back, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-env.ts <command> [--file <sandforge.yaml>] --org <alias> [options]

Commands:
  validate  check the file, offline: its schema, each resource against its module's own rules,
            the order of the resources, the variables it names; reaches no org
  plan      say what apply would do to the org: per resource, create, keep, replace, delete, or why
            it is blocked; what an earlier apply left there and what changed since; per object the
            records it would write; the API requests, storage and emails it takes; writes nothing
  apply     do what plan says, after asking you to type the org's alias; applied again, it writes
            nothing; stopped, run it again and it takes up
  destroy   take back what apply created, the last resource first, into the recycle bin; name what
            it cannot take back
  reset     rewind the org to the checkpoint taken after the last apply: what anyone created,
            changed or deleted since is taken back, the environment's records back as applied;
            between two test suites, after asking you to type the org's alias
  state     list the environments kept on this machine, or those of one org (--org, an alias or
            an Organization Id); reaches no org

Required:
  --org <alias>              sf CLI alias of the org to fill (validate and state: not needed)

Options:
  --file <path>              the file (default: sandforge.yaml in this folder)
  --alias <role>=<alias>     the alias of a role the file's orgs name; wins over its variable
  --json                     the answer alone on stdout, every other line on stderr
plan:
  --fail-on-change           exit 3 when apply would write or delete anything
  --fail-on-drift            exit 3 when the org no longer holds the environment as applied:
                             records deleted or changed since
  --quick                    skip the dry runs and the removal previews: no counts, and no word
                             on what the org holds
  --replace <resource>, --replace-drifted
                             plan what apply would do with them
apply:
  --replace <resource>       replace a resource kept or drifted; repeat for more
  --replace-drifted          replace every drifted resource
  --accept-automation        take back the runs a replace or a delete takes back although the org
                             runs automation as records go
  --accept-no-state          apply to a Developer Edition or a sandbox this machine has no state
                             of: records an earlier apply left there would be created twice
  --yes                      do not ask; without it and with no terminal, stop at the question,
                             exit 2, having written nothing
destroy:
  --include-changed          take also the records changed since apply, and what was created
                             under them since: on a shared sandbox, a colleague's work
  --sweep                    take also what the org's automation created during each run
  --accept-automation        delete although the org runs automation as records go
  --rewind                   rewind the org to the checkpoint taken before the first apply
                             instead: everyone's changes since are taken back, not only the
                             environment's records, and its checkpoints are then deleted
  --accept-no-undo           with --rewind, rewind although undo could not bring back some of
                             the records it deletes
  --yes                      as for apply
reset:
  --accept-automation        rewind although the org runs automation as records are written back
  --accept-no-undo           rewind although undo could not bring back some of the records it
                             deletes
  --yes                      as for apply

The file holds no secret: org credentials stay with the sf CLI. A value comes from the environment
only where the file writes { env: NAME }. The org to fill is never in the file. A resource's
accept: { automation: true } is the file's --accept-automation for that resource.

A forge resource clones from the org its source names: a role of the file's orgs, its alias
given there, in a { env: NAME } variable or with --alias. A record named by a query is the one
row its source answers, read at each plan. Each forge run is held to the count its dry run gave
the plan: a source that grew since is refused, not written. Once it ended, the clone verifies
what it created: records not there, or lookups that do not hold, leave it partial. A source that
is a production org is refused unless the resource anonymizes what it clones (anonymize) or the
file accepts real data (accept: { realData: true }); emails and phone numbers are neutralized
either way, unless keepContactPoints.

The file's checkpoint.before takes a checkpoint of the org before the first write of its first
apply, which destroy --rewind returns to; checkpoint.after takes one once an apply ended 0, and
again after each apply that writes, which reset returns to and plan compares the whole org with.
sandforge-checkpoint takes, rewinds to and deletes them, in checkpoints/ of the journal
directory: they hold the org's values in clear. plan says what each take costs and what refuses
it, which refuses the apply before its first write. A destroy that took everything back deletes
them; reset keeps them, and sandforge-checkpoint undo takes a reset back.

A frozen resource loads a Frozen Dataset frozen beforehand, through sandforge-frozen: its
configuration committed beside the file, its dataset named by its path from the root or in a
{ env: NAME } variable, and pinned by its version and its digest — a dataset whose digest is not
the file's is refused, both named. Each load is held to the count its dry run gave and judged by
the verification it chains; a replace is a reload, refused when it would leave records.

A seed relation may draw its parents from the records another resource created:
parents: { from: <resource>.<Object> }. They are read from that resource's own run, handed to
the seed by their ids, at most 2,000 or the relation's limit, and counted exactly once that
resource has run; the resource drawn from runs first, and is taken back last.

A production org is refused before anything is read, exit 1. No flag lifts it. A sandbox is
written to only when the file lists its Organization Id under targets.sandboxes and allows the
sandbox kind; scratch orgs and Developer Edition orgs need no listing. A scratch org is told
apart by the Dev Hub the sf CLI names for it; one it names none for is taken for a sandbox.

What apply keeps of the org is the state: ids, counts and dates, never a record's values, in
env/<Organization Id>/<name>/ of the folder SANDFORGE_JOURNAL_DIR names (default: ~/.sandforge),
beside the run files of the seeds and clones it ran; each frozen resource's loads are kept
there, in a sas of its own. That folder must be outside the repository that holds the file.
Keep it between the jobs that apply and destroy, in a cache keyed by the org. A scratch org's
state is deleted 30 days after its last write. Two machines applying to one org at once are not
kept apart: give the jobs one concurrency group.

Exit codes: 0 done (validate: the file is valid; plan: answered; apply: every resource applied
whole, or nothing to do; destroy: every record taken back; reset and destroy --rewind: read again,
the org matches the checkpoint); 1 refused before it read or wrote — a production org, a kind of
org or a sandbox the file does not allow, a protected org, a state of another org, no state
without --accept-no-state, another apply of the org under way, a removal refused for automation
without --accept-automation, more API requests, storage or emails than the org has left, a
checkpoint the file asks that its script refuses, a production source without anonymize or
accept: { realData: true }, no checkpoint to reset or rewind to, a rewind refused for want of
--accept-automation or --accept-no-undo —, or nothing written; 2 a bad command line, a file that
does not validate, a variable not set, the journal directory or a dataset inside the file's
repository, a question with no terminal (give --yes); 3 partial (apply: a resource partial, or
failed after others wrote; destroy: records left, each with why; reset and destroy --rewind:
records still differ; plan with --fail-on-change or --fail-on-drift: changes or drift found); 4
unstable (a forge run's or a frozen load's verification found records still changing; reset and
destroy --rewind: someone changed records during it); 130, 143, 129 Ctrl-C, SIGTERM or SIGHUP
stopped it — run it again: it takes up from the state.
`;

// ─── The command line ────────────────────────────────────────────────────────

const COMMANDS = ['validate', 'plan', 'apply', 'destroy', 'reset', 'state'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (word: string): word is Command => (COMMANDS as readonly string[]).includes(word);

/** What each command reads of its line, after its own word. */
const FLAGS: Readonly<Record<Command, CommandFlags>> = {
  validate: { words: 1, switches: ['--json'], values: ['--file'] },
  plan: {
    words: 1,
    switches: ['--json', '--fail-on-change', '--fail-on-drift', '--quick', '--replace-drifted'],
    values: ['--file', '--org', '--alias', '--replace'],
  },
  apply: {
    words: 1,
    switches: ['--json', '--replace-drifted', '--accept-automation', '--accept-no-state', '--yes'],
    values: ['--file', '--org', '--alias', '--replace'],
  },
  destroy: {
    words: 1,
    switches: [
      '--json',
      '--include-changed',
      '--sweep',
      '--accept-automation',
      '--rewind',
      '--accept-no-undo',
      '--yes',
    ],
    values: ['--file', '--org', '--alias'],
  },
  reset: {
    words: 1,
    switches: ['--json', '--accept-automation', '--accept-no-undo', '--yes'],
    values: ['--file', '--org', '--alias'],
  },
  state: { words: 1, switches: ['--json'], values: ['--org', '--file'] },
};

/** Everything the command line settled. */
export interface CliArgs {
  command: Command;
  /** The file, absolute. */
  file: string;
  /** Given with --file, or left to the default. */
  fileGiven: boolean;
  org?: string;
  aliases: Record<string, string>;
  json: boolean;
  failOnChange: boolean;
  failOnDrift: boolean;
  quick: boolean;
  replace: string[];
  replaceDrifted: boolean;
  acceptAutomation: boolean;
  acceptNoState: boolean;
  includeChanged: boolean;
  sweep: boolean;
  /** destroy: rewind the org to the checkpoint taken before the first apply. */
  rewind: boolean;
  acceptNoUndo: boolean;
  yes: boolean;
}

/** Stop the command, exit 2, on a line it cannot read: said on stderr, nothing on stdout. */
function refuseLine(line: string): never {
  process.stderr.write(`${line} Run with --help.\n`);
  process.exit(2);
}

/** Read the command line, or stop, exit 2, on one that cannot be read. */
export function parseArgs(argv: readonly string[], cwd: string = process.cwd()): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const command = args[0];
  if (command === undefined || command.startsWith('-')) {
    return refuseLine('Name the command first: validate, plan, apply, destroy, reset or state.');
  }
  if (!isCommand(command)) {
    return refuseLine(
      `"${command}" is not a command of sandforge-env: validate, plan, apply, destroy, reset ` +
        'or state. Nothing was run.',
    );
  }
  // `--yes=true`, a misspelt `--dryrun`, would be dropped without a word.
  refuseUnreadArguments(args, FLAGS[command]);
  const values = (flag: string): string[] => {
    const out: string[] = [];
    for (let at = 1; at < args.length; at++) {
      if (args[at] !== flag) continue;
      out.push(args[at + 1] ?? '');
      at++;
    }
    return out;
  };
  const single = (flag: string): string | undefined => {
    const given = values(flag);
    if (given.length > 1) refuseLine(`${flag} is given ${given.length} times: give it once.`);
    return given[0];
  };
  const aliases: Record<string, string> = {};
  for (const pair of values('--alias')) {
    const at = pair.indexOf('=');
    const role = at > 0 ? pair.slice(0, at) : '';
    const alias = at > 0 ? pair.slice(at + 1) : '';
    if (role === '' || alias === '') {
      refuseLine(`--alias wants <role>=<alias>, as --alias uat=UAT-ORG, not "${pair}".`);
    }
    if (role in aliases) refuseLine(`--alias gives the role ${role} twice: give it once.`);
    aliases[role] = alias;
  }
  const org = single('--org');
  if (
    (command === 'plan' || command === 'apply' || command === 'destroy' || command === 'reset') &&
    org === undefined
  ) {
    refuseLine(`${command} needs --org, the sf CLI alias of the org.`);
  }
  // A destroy by rewind takes the whole org back: a removal's switches would be read as kept.
  const rewind = args.includes('--rewind');
  if (rewind) {
    const removal = ['--include-changed', '--sweep'].filter((flag) => args.includes(flag));
    if (removal.length > 0) {
      refuseLine(
        `${removal.join(' and ')} take back records by removal: --rewind takes the whole org ` +
          'back to the checkpoint before the first apply. Give one or the other.',
      );
    }
  } else if (command === 'destroy' && args.includes('--accept-no-undo')) {
    refuseLine('--accept-no-undo goes with --rewind: a destroy by removal is no rewind.');
  }
  const fileGiven = single('--file');
  const replace = values('--replace');
  return {
    command,
    file: resolve(cwd, fileGiven ?? 'sandforge.yaml'),
    fileGiven: fileGiven !== undefined,
    ...(org !== undefined ? { org } : {}),
    aliases,
    json: args.includes('--json'),
    failOnChange: args.includes('--fail-on-change'),
    failOnDrift: args.includes('--fail-on-drift'),
    quick: args.includes('--quick'),
    replace: [...new Set(replace)],
    replaceDrifted: args.includes('--replace-drifted'),
    acceptAutomation: args.includes('--accept-automation'),
    acceptNoState: args.includes('--accept-no-state'),
    includeChanged: args.includes('--include-changed'),
    sweep: args.includes('--sweep'),
    rewind,
    acceptNoUndo: args.includes('--accept-no-undo'),
    yes: args.includes('--yes'),
  };
}

// ─── What the command runs with ──────────────────────────────────────────────

/** An org reached: its session and a connection to it. */
export interface Reached {
  session: SfOrg;
  conn: Connection;
}

/** What the command runs with, beside its line; tests give their own. */
export interface EnvCliDeps {
  /** Runs a script of this folder: spawned in a process of its own unless a test gives another. */
  runner?: CommandRunner;
  /** Reaches an org by its alias, through the sf CLI's session. */
  reach?: (alias: string) => Promise<Reached>;
  /** The journal directory: `SANDFORGE_JOURNAL_DIR`, else `~/.sandforge`. */
  journalDir?: string;
  /** Where the locks are: `~/.sandforge/locks`. */
  locksDir?: string;
  /** Asks for the alias to be typed: on the terminal unless a test gives another. */
  ask?: (question: string) => Promise<string>;
  /** Hears the stop signals; the process's own unless a test gives another. */
  onStop?: EnvStepDeps['onStop'];
  /** The checks a lock makes of its holder. */
  lockOptions?: EnvStepDeps['lockOptions'];
  /** The folder the file is read from by default. */
  cwd?: string;
}

/** This SandForge's version, which a new state records. */
function sandforgeVersion(): string {
  try {
    const read = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof read.version === 'string' ? read.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** A verb stopped by a refusal: said on stderr, and with `--json` as the answer on stdout. */
class Stop extends Error {
  constructor(
    readonly answer: EnvRefusalAnswer,
    readonly code: number,
  ) {
    super(answer.refusal.message);
    this.name = 'Stop';
  }
}

function stopWith(refusal: EnvRefusal): Stop {
  return new Stop({ refusal: { code: refusal.code, message: refusal.message } }, refusal.exit);
}

function issueOf(refusal: EnvFileRefusal): EnvIssue {
  return {
    path: pathText(refusal.path),
    ...(refusal.resource !== undefined ? { resource: refusal.resource } : {}),
    message: refusal.message,
  };
}

/** The file read and checked offline, or the stop it ends the command with. */
function readDocument(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    throw new Stop(
      {
        refusal: {
          code: 'FILE_UNREAD',
          message: `${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      2,
    );
  }
  const read = documentOf(text);
  if ('refusal' in read) {
    throw new Stop({ refusal: { code: 'INVALID_FILE', message: `${file}: ${read.refusal}` } }, 2);
  }
  return read.document;
}

/** The file's refusals as the command stops on them. */
function fileStop(file: string, refusals: readonly EnvFileRefusal[]): Stop {
  return new Stop(
    {
      refusal: {
        code: 'INVALID_FILE',
        message: `${file} does not validate:\n${refusals.map((r) => `  ${refusalLine(r)}`).join('\n')}`,
        issues: refusals.map(issueOf),
      },
    },
    2,
  );
}

/** The org's `/limits`, read once, as the plan's gates hold the day's writes to them. */
export async function readBudget(conn: Pick<Connection, 'request'>): Promise<EnvBudget> {
  let answer: Promise<unknown> | undefined;
  const transport: LimitsTransport = {
    request: (request) => (answer ??= conn.request(request)),
  };
  const unread = (err: unknown): { unread: string } => ({
    unread: err instanceof Error ? err.message : String(err),
  });
  const storage = await readDataStorage(transport).catch(unread);
  const apiRequests =
    'unread' in storage || storage.dailyApiRequests === undefined
      ? await readApiBudget(transport).catch(unread)
      : storage.dailyApiRequests;
  const emails = await readEmailLimits(transport).catch(unread);
  return {
    apiRequests,
    storage:
      'unread' in storage ? storage : { remainingMB: storage.remainingMB, maxMB: storage.maxMB },
    emails,
  };
}

/** The last line a script said on stderr: what a refusal before its first write is. */
function lastLine(stderr: string): string {
  return (
    stderr
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? 'it said nothing'
  );
}

/** What the plan, the apply and the destroy share once the org is typed and the state read. */
interface Prepared {
  resolved: EnvFileResolved;
  store: EnvStore;
  journalDir: string;
  locksDir: string;
  target: EnvTarget;
  reached: Reached;
  state: EnvState | undefined;
  warnings: string[];
  /** What a real apply would meet: no state without --accept-no-state. */
  noState?: EnvRefusal;
  runner: CommandRunner;
}

/**
 * Read the file and its variables, open the states, reach and type the org,
 * and read its state: every refusal a guard makes before any record is read.
 */
async function prepare(
  args: CliArgs,
  deps: EnvCliDeps,
  say: (line: string) => void,
): Promise<Prepared> {
  const document = readDocument(args.file);
  const read = readEnvFile(document, dirname(args.file), process.env, { aliases: args.aliases });
  if ('refusals' in read) throw fileStop(args.file, read.refusals);
  let resolved = read.resolved;
  const names = resolved.resources.map((resource) => resource.name);
  for (const name of args.replace) {
    if (!names.includes(name)) {
      throw new Stop(
        {
          refusal: {
            code: 'BAD_LINE',
            message: `--replace ${name} names no resource of the file: it has ${names.join(', ')}.`,
          },
        },
        2,
      );
    }
  }

  const journalDir = deps.journalDir ?? envJournalDirOf();
  const locksDir = deps.locksDir ?? defaultEnvLocksDir();
  const inside = journalInsideRepository(dirname(args.file), journalDir);
  const opened = openEnvStore({ journalDir, fileFolder: dirname(args.file) });
  if ('refusal' in opened) throw stopWith(storeRefusal(opened.refusal, inside !== undefined));
  const store = opened.store;
  for (const expired of await store.sweep()) {
    say(
      `the state of ${expired.env} on ${expired.alias ?? expired.organizationId} expired on ` +
        `${expired.expiresAt}, a month after its last write, as a scratch org does: deleted`,
    );
  }

  const alias = args.org ?? '';
  let reached: Reached;
  try {
    reached = await (deps.reach ?? reachOrg)(alias);
  } catch (err: unknown) {
    throw new Stop(
      {
        refusal: {
          code: 'NOT_CONNECTED',
          message: `${alias} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      FAILED_EXIT,
    );
  }
  let typedTarget: TypedTarget | { unread: string };
  try {
    typedTarget = await typeTarget(reached.conn);
  } catch (err: unknown) {
    typedTarget = { unread: err instanceof Error ? err.message : String(err) };
  }
  const typedOrg = envTargetOf(alias, typedTarget, reached.session);
  if ('refusal' in typedOrg) throw stopWith(typedOrg.refusal);
  const target = typedOrg.target;
  const refused = targetRefusal(resolved.checked.file.targets, target);
  if (refused !== undefined) throw stopWith(refused);

  let state: EnvState | undefined;
  try {
    state = await store.read(target.organizationId, resolved.checked.file.name);
  } catch (err: unknown) {
    if (err instanceof EnvStateError) throw stopWith(stateRefusal(err));
    throw err;
  }
  if (state !== undefined) {
    const other = stateTargetRefusal(state, resolved.checked.file.name, target);
    if (other !== undefined) throw stopWith(other);
  }
  const warnings: string[] = [];
  let noState: EnvRefusal | undefined;
  const plans = args.command === 'plan' || args.command === 'apply';
  if (state === undefined && plans) {
    const guarded = noStateGuard(target, resolved.checked.file.name, args.acceptNoState);
    if ('warning' in guarded) warnings.push(guarded.warning);
    else noState = guarded.refusal;
  }
  const holder = envLockHolder(locksDir, target.organizationId, deps.lockOptions);
  if (holder !== undefined) {
    warnings.push(`${envLockLine(holder)}: this plan may be out of date when it ends`);
  }
  // The source of each forge resource, read for a plan and an apply: the org
  // its alias reaches and the record its query names, which its fingerprint
  // is of; the dataset of each frozen resource, held to the file's pin. A
  // destroy takes back what the state names, and a reset rewinds to a
  // checkpoint of it: neither reads a source or a dataset.
  if (plans) {
    const sources = await readSources(resolved, target, deps, say);
    const datasets = await readDatasets(resolved, say);
    if (Object.keys(sources).length + Object.keys(datasets).length > 0) {
      const again = resolveEnvFile(resolved.checked, process.env, {
        aliases: args.aliases,
        sources,
        datasets,
      });
      if ('refusals' in again) throw fileStop(args.file, again.refusals);
      resolved = again.resolved;
    }
  }
  return {
    resolved,
    store,
    journalDir,
    locksDir,
    target,
    reached,
    state,
    warnings,
    ...(noState !== undefined ? { noState } : {}),
    runner: deps.runner ?? spawnCommand,
  };
}

/**
 * What each forge resource's source answers: the org its role's alias
 * reaches, and the one row its record's query names. Each alias is reached
 * once. A source that cannot be reached, a query that answers no row or
 * more than one, and a source that is the org to fill are said, and the plan
 * blocks the resource: a clone reads one org and writes another.
 */
async function readSources(
  resolved: EnvFileResolved,
  target: EnvTarget,
  deps: EnvCliDeps,
  say: (line: string) => void,
): Promise<Record<string, EnvSourceRead>> {
  const reached = new Map<string, Promise<Reached>>();
  const sources: Record<string, EnvSourceRead> = {};
  for (const resource of resolved.resources) {
    if (resource.kind !== 'forge') continue;
    const { role, alias } = resource.source;
    say(`${resource.name}: reading its source, the ${role} org (${alias})`);
    let conn: Connection;
    try {
      let reaching = reached.get(alias);
      if (reaching === undefined) {
        reaching = (deps.reach ?? reachOrg)(alias);
        reached.set(alias, reaching);
      }
      conn = (await reaching).conn;
    } catch (err: unknown) {
      sources[resource.name] = {
        refusal: `the ${role} org (${alias}) could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      };
      continue;
    }
    const read = await readForgeSource(conn, resource.run, role, alias);
    sources[resource.name] =
      'organizationId' in read && sameOrganization(read.organizationId, target.organizationId)
        ? {
            refusal:
              `its source, the ${role} org (${alias}), is the org to fill: a clone reads one ` +
              'org and writes another',
          }
        : read;
  }
  return sources;
}

/**
 * What each frozen resource's dataset holds: its digest and version, held to
 * what the file pins. A dataset that is not the one pinned is said, and the
 * plan blocks the resource.
 */
async function readDatasets(
  resolved: EnvFileResolved,
  say: (line: string) => void,
): Promise<Record<string, EnvDatasetRead>> {
  const datasets: Record<string, EnvDatasetRead> = {};
  for (const resource of resolved.resources) {
    if (resource.kind !== 'frozen') continue;
    say(`${resource.name}: reading its dataset at ${resource.dataset.dir}`);
    datasets[resource.name] = await readFrozenDataset(resource.dataset.dir, resource.run.dataset);
  }
  return datasets;
}

/** The production way to reach an org: the sf CLI's session. */
async function reachOrg(alias: string): Promise<Reached> {
  const session = await loadOrg(alias);
  return { session, conn: makeConn(session) };
}

/**
 * Preview the removal of every run of the resources the state holds, through
 * its script's own `--remove … --preview`: what the org holds of each, what is
 * gone and what changed since, and what a removal would be refused for now.
 * A frozen resource's removal takes the next load of its sas whichever run
 * asks: its last run is previewed alone. With `refresh`, a frozen resource
 * applied from the file is verified too, as its script verifies a load.
 */
async function previewRuns(
  prepared: Prepared,
  options: { includeChanged: boolean; acceptAutomation: boolean; refresh: boolean },
  say: (line: string) => void,
  signal: AbortSignal,
): Promise<Record<string, EnvRunPreview[]>> {
  const { state, resolved, target } = prepared;
  const previews: Record<string, EnvRunPreview[]> = {};
  if (state === undefined) return previews;
  const where = { organizationId: target.organizationId, env: resolved.checked.file.name };
  const names = removalOrder(
    state,
    liveResources(state).map(([name]) => name),
  );
  for (const name of names) {
    const resource = state.resources[name];
    if (resource === undefined) continue;
    const accept =
      options.acceptAutomation ||
      resolved.checked.file.resources[name]?.accept?.automation === true;
    const runs: EnvRunPreview[] = [];
    // A run a removal took back whole holds nothing of the org's, and the
    // removal passes it over: read again, it cost a script and the org's
    // reads on every plan, one more at each replace.
    for (const run of previewedRunsOf(resource.kind, resource.runs)) {
      if (signal.aborted) break;
      const subject = removalSubjectOf(run, where, prepared);
      if (subject === undefined) {
        runs.push({ n: run.n, nothing: true });
        continue;
      }
      say(`${name}: reading what the org holds of run ${run.n}`);
      const line = previewLineOf(resource.kind, {
        target: target.alias,
        subject,
        includeChanged: options.includeChanged,
        acceptAutomation: accept,
      });
      const ran = await prepared.runner(line.script, line.args, signal);
      let preview: EnvRunPreview;
      try {
        preview = { n: run.n, preview: readPreviewOf(resource.kind, ran.stdout) };
      } catch (err: unknown) {
        if (!(err instanceof StepAnswerError)) throw err;
        runs.push({ n: run.n, failed: `exit ${ran.code}: ${lastLine(ran.stderr)}` });
        continue;
      }
      const refresh =
        options.refresh &&
        resource.status === 'applied' &&
        resolved.checked.file.resources[name] !== undefined
          ? refreshLineOf(resource.kind, { target: target.alias, subject })
          : undefined;
      if (refresh !== undefined && !signal.aborted) {
        say(`${name}: verifying run ${run.n}`);
        const checked = await prepared.runner(refresh.script, refresh.args, signal);
        try {
          preview = { ...preview, refreshed: readRefreshOf(checked.stdout) };
        } catch (err: unknown) {
          if (!(err instanceof StepAnswerError)) throw err;
          preview = {
            ...preview,
            refreshed: { unread: `exit ${checked.code}: ${lastLine(checked.stderr)}` },
          };
        }
      }
      runs.push(preview);
    }
    previews[name] = runs;
  }
  return previews;
}

/**
 * What each seed resource drawing its parents from another resource's
 * records is handed: the ids of the records that resource's last run
 * created, read from its run's own files — or nothing yet, for one that runs
 * in the same apply (`running`).
 */
async function drawsOf(
  prepared: Prepared,
  running: ReadonlySet<string>,
): Promise<Record<string, EnvDrawn>> {
  const { resolved, state, target, store, journalDir } = prepared;
  const out: Record<string, EnvDrawn> = {};
  for (const resource of resolved.resources) {
    if (!running.has(resource.name)) continue;
    if (resource.kind !== 'seed' || (resource.run.draws ?? []).length === 0) continue;
    out[resource.name] = await drawnOf(
      resource,
      state,
      running,
      {
        organizationId: target.organizationId,
        env: resolved.checked.file.name,
        target: target.alias,
      },
      { store, journalDir },
    );
  }
  return out;
}

/**
 * Dry-run each resource to create or replace, through its script's own
 * `--dry-run --json`. A forge resource whose source was not read is not, nor
 * a frozen resource whose dataset is not the one pinned, nor a seed resource
 * whose draws cannot be handed their parents: the plan blocks each for that.
 * A seed is given the parents its draws are handed; a draw from a resource
 * that runs first in the same apply stands in with what the org holds. A
 * frozen resource is dry-run in its own sas when loads keep one, the
 * script's store apart: a dry run writes nothing there.
 */
async function dryRun(
  prepared: Prepared,
  drafts: readonly EnvActionDraft[],
  draws: Readonly<Record<string, EnvDrawn>>,
  say: (line: string) => void,
  signal: AbortSignal,
): Promise<Record<string, EnvDryRun>> {
  const { resolved, target, state, store } = prepared;
  const dryRuns: Record<string, EnvDryRun> = {};
  const runs = new Map(
    drafts
      .filter((d) => d.action === 'create' || d.action === 'replace')
      .map((d) => [d.resource, d.action] as const),
  );
  if (runs.size === 0) return dryRuns;
  const env = resolved.checked.file.name;
  const folder = mkdtempSync(join(tmpdir(), 'sandforge-env-plan-'));
  try {
    for (const resource of resolved.resources) {
      const action = runs.get(resource.name);
      if (action === undefined || signal.aborted) continue;
      if (resource.kind === 'forge') {
        const read = resource.source.read;
        if (read === undefined || 'refusal' in read) continue;
      }
      if (resource.kind === 'frozen') {
        const read = resource.dataset.read;
        if (read === undefined || 'refusal' in read) continue;
      }
      const drawn = draws[resource.name];
      if (drawn !== undefined && drawn.refusals.length > 0) continue;
      const templateFile = join(folder, `${resource.name}.json`);
      let storeFile: string | undefined;
      let sasDir: string | undefined;
      if (resource.kind === 'frozen') {
        const kept = store.sasOf(target.organizationId, env, frozenSasOf(resource.name));
        sasDir = existsSync(kept) ? kept : join(folder, `${resource.name}.sas`);
        if (sasDir === kept) storeFile = join(folder, `${resource.name}.cli-store.json`);
      }
      const payload = payloadOf(resource, {
        ...(drawn !== undefined ? { drawn: drawn.ids } : {}),
        standIns: true,
        ...(sasDir !== undefined ? { sasDir } : {}),
      });
      writeFileSync(templateFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      say(`${resource.name}: dry run`);
      const line = dryRunLineOf(resource, {
        target: target.alias,
        templateFile,
        runId: envRunIdOf(env, resource.name, nextRunNumber(state?.resources[resource.name])),
        replace: action === 'replace' && replacesInOneRun(resource.kind),
        ...(storeFile !== undefined ? { storeFile } : {}),
      });
      const ran = await prepared.runner(line.script, line.args, signal);
      try {
        dryRuns[resource.name] = { answer: readDryRunOf(resource.kind, ran.stdout) };
      } catch (err: unknown) {
        if (!(err instanceof StepAnswerError)) throw err;
        dryRuns[resource.name] = { failed: `exit ${ran.code}: ${lastLine(ran.stderr)}` };
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return dryRuns;
}

/**
 * Run `work` hearing the stop signals: a Ctrl-C, a SIGTERM or a SIGHUP stops
 * the script under way as it stops on a terminal, and the command stops with
 * that signal's exit code once it has, having written nothing.
 */
async function stoppable<T>(
  deps: EnvCliDeps,
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  let stoppedBy: StopSignal | undefined;
  const release = (deps.onStop ?? onStopSignal)((signal) => {
    stoppedBy = signal;
    stop.abort();
  });
  try {
    const done = await work(stop.signal);
    if (stoppedBy !== undefined) {
      throw new Stop(
        {
          refusal: {
            code: 'STOPPED',
            message: `stopped by ${stoppedBy} while ${what}: nothing was written`,
          },
        },
        stopExitCode(stoppedBy),
      );
    }
    return done;
  } finally {
    release();
  }
}

/** The plan of an apply, read through the scripts: previews, dry runs and the day's budget. */
async function planOf(
  prepared: Prepared,
  args: CliArgs,
  say: (line: string) => void,
  signal: AbortSignal,
): Promise<{ plan: EnvPlan; dryRuns: Record<string, EnvDryRun> }> {
  const org = {
    organizationId: prepared.target.organizationId,
    kind: prepared.target.kind,
    alias: prepared.target.alias,
  };
  const common = {
    resolved: prepared.resolved,
    org,
    state: prepared.state,
    replace: args.replace,
    replaceDrifted: args.replaceDrifted,
    warnings: prepared.warnings,
    ...(prepared.noState !== undefined ? { refusal: prepared.noState.message } : {}),
  };
  if (args.quick) return { plan: envPlan(common), dryRuns: {} };
  const previews = await previewRuns(
    prepared,
    { includeChanged: false, acceptAutomation: args.acceptAutomation, refresh: true },
    say,
    signal,
  );
  const drift = await wholeOrgDrift(prepared, say, signal);
  const drafts = classifyResources({ ...common, previews, ...(drift ? { drift } : {}) });
  const running = new Set(
    drafts.filter((d) => d.action === 'create' || d.action === 'replace').map((d) => d.resource),
  );
  const draws = await drawsOf(prepared, running);
  const dryRuns = await dryRun(prepared, drafts, draws, say, signal);
  const budget = await readBudget(prepared.reached.conn);
  const checkpointEstimate = await estimateCheckpoints(prepared, drafts.some(writes), say, signal);
  return {
    plan: envPlan({
      ...common,
      previews,
      dryRuns,
      budget,
      ...(drift ? { drift } : {}),
      ...(checkpointEstimate ? { checkpointEstimate } : {}),
      draws: Object.fromEntries(
        Object.entries(draws).map(([name, drawn]) => [
          name,
          { draws: drawn.draws, refusals: drawn.refusals },
        ]),
      ),
    }),
    dryRuns,
  };
}

/**
 * The whole org against the checkpoint taken after the last apply, through
 * the checkpoint script's own preview; nothing when the state names none.
 */
async function wholeOrgDrift(
  prepared: Prepared,
  say: (line: string) => void,
  signal: AbortSignal,
): Promise<EnvPlanDrift | undefined> {
  const after = prepared.state?.checkpoints?.after;
  if (after === undefined || signal.aborted) return undefined;
  say(`checkpoint ${after}: comparing the whole org with it`);
  const ran = await prepared.runner(
    CHECKPOINT_SCRIPT,
    checkpointPreviewLine({
      org: prepared.target.alias,
      store: envCheckpointStoreOf(prepared.journalDir),
      checkpoint: after,
    }),
    signal,
  );
  return driftOf(after, ran);
}

/**
 * What the checkpoint script estimates a take of the org costs, when the
 * apply takes one: one estimate for both, which read the same objects.
 */
async function estimateCheckpoints(
  prepared: Prepared,
  writesAny: boolean,
  say: (line: string) => void,
  signal: AbortSignal,
): Promise<CheckpointEstimateRead | undefined> {
  const file = prepared.resolved.checked.file;
  if (checkpointStepsOf(file, prepared.state, writesAny).length === 0 || signal.aborted) {
    return undefined;
  }
  say('checkpoint: estimating what a take of the org costs');
  const ignoreFields = file.checkpoint?.ignoreFields;
  const ran = await prepared.runner(
    CHECKPOINT_SCRIPT,
    checkpointEstimateLine({
      org: prepared.target.alias,
      store: envCheckpointStoreOf(prepared.journalDir),
      ...(ignoreFields !== undefined ? { ignoreFields } : {}),
    }),
    signal,
  );
  return estimateReadOf(ran);
}

/** The org's clock, or this machine's, said once, when the org does not answer. */
function orgClock(conn: Connection, say: (line: string) => void): () => Promise<string> {
  const org = removalOrg(conn, 'sandforge-env');
  let said = false;
  return async () => {
    try {
      return await org.serverTime();
    } catch (err: unknown) {
      if (!said) {
        said = true;
        say(
          `the org did not say its time (${err instanceof Error ? err.message : String(err)}): ` +
            "the state's spans are on this machine's clock",
        );
      }
      return new Date().toISOString();
    }
  };
}

// ─── The verbs ───────────────────────────────────────────────────────────────

/**
 * What `validate` says a resource writes: a seed's objects with their counts,
 * and the resources its relations draw their parents from; a forge
 * resource's source and what it clones, which its dry run alone counts; a
 * frozen resource's dataset, pinned.
 */
function validatedLine(run: EnvKindRun): string {
  if (run.kind === 'seed') {
    const objects = objectsOfRun(run)
      .map((o) => `${o.object} ${o.count ?? ''}`)
      .join(', ');
    const drawn = (run.draws ?? []).map(
      (draw) =>
        `${draw.relation.childObject}.${draw.relation.lookupField} under the ` +
        `${draw.relation.parentObject} records ${draw.from} created`,
    );
    return drawn.length > 0 ? `${objects}; ${drawn.join(', ')}` : objects;
  }
  if (run.kind === 'frozen') {
    const { path, version, digest } = run.dataset;
    const where = typeof path === 'string' ? path : `$${path.env}`;
    return `the Frozen dataset ${version} at ${where} (${digest.slice(0, 19)}…), as ${run.configFile} configures its load`;
  }
  const where = (object: string, condition: string | undefined): string =>
    condition !== undefined ? `${object} WHERE ${condition}` : object;
  const what =
    run.tables !== undefined
      ? `tables ${run.tables.map((table) => where(table.object, table.where)).join(', ')}`
      : run.record?.id !== undefined
        ? `record ${run.record.id}`
        : `the one record of ${where(run.record?.object ?? '', run.record?.where)}`;
  return `cloned from the ${run.source} org: ${what}`;
}

/** `validate`: the file checked offline, its variables named. */
function validate(
  args: CliArgs,
  say: (line: string) => void,
): { answer: EnvValidation; code: number } {
  const document = readDocument(args.file);
  const checked = checkEnvFile(document, dirname(args.file));
  if ('refusals' in checked) {
    say(`${args.file} does not validate:`);
    for (const refusal of checked.refusals) say(`  ${refusalLine(refusal)}`);
    return {
      answer: {
        file: args.file,
        valid: false,
        issues: checked.refusals.map(issueOf),
        warnings: [],
      },
      code: 2,
    };
  }
  const { file, order, runs, variables } = checked.checked;
  const unset = new Set(unsetVariablesOf(checked.checked, process.env).map((v) => v.name));
  const resources = order.flatMap((name) => {
    const run = runs[name];
    const resource = file.resources[name];
    if (run === undefined) return [];
    return [
      {
        name,
        kind: run.kind,
        dependsOn: resource !== undefined ? dependenciesOf(name, resource) : [],
        ...(run.kind === 'forge' ? { source: run.source } : {}),
        objects: objectsOfRun(run),
      },
    ];
  });
  const warnings = checked.checked.warnings.map(issueOf);
  say(`${args.file}: valid, the environment ${file.name}`);
  for (const resource of resources) {
    const run = runs[resource.name];
    say(
      `  ${resource.name}: ${run !== undefined ? validatedLine(run) : ''}` +
        (resource.dependsOn.length > 0 ? `, after ${resource.dependsOn.join(', ')}` : ''),
    );
  }
  for (const variable of variables) {
    const holds =
      variable.role !== undefined
        ? `the ${variable.role} org`
        : `the dataset of ${variable.resource ?? ''}`;
    say(
      `  variable ${variable.name} (${holds}): ` +
        (unset.has(variable.name) ? 'not set in this shell' : 'set'),
    );
  }
  for (const warning of warnings) say(`warning: ${warning.path}: ${warning.message}`);
  return {
    answer: {
      file: args.file,
      valid: true,
      env: file.name,
      resources,
      variables: variables.map((v) => ({
        name: v.name,
        ...(v.role !== undefined ? { role: v.role } : {}),
        ...(v.resource !== undefined ? { resource: v.resource } : {}),
        set: !unset.has(v.name),
      })),
      issues: [],
      warnings,
    },
    code: DONE_EXIT,
  };
}

/** `state`: the states kept on this machine, those of one org, or of one file. */
async function listStates(
  args: CliArgs,
  deps: EnvCliDeps,
  say: (line: string) => void,
): Promise<EnvStateList> {
  const journalDir = deps.journalDir ?? envJournalDirOf();
  const opened = openEnvStore({ journalDir, fileFolder: null });
  if ('refusal' in opened) throw stopWith(storeRefusal(opened.refusal, false));
  const expired = await opened.store.sweep();
  let envName: string | undefined;
  if (args.fileGiven) {
    const read = checkEnvFile(readDocument(args.file), dirname(args.file));
    if ('refusals' in read) throw fileStop(args.file, read.refusals);
    envName = read.checked.file.name;
  }
  const org = args.org;
  const states = (await opened.store.list()).filter(
    (listing) =>
      (envName === undefined || listing.env === envName) &&
      (org === undefined ||
        listing.state?.org.alias === org ||
        listing.organizationId.slice(0, 15) === org.slice(0, 15)),
  );
  for (const gone of expired) {
    say(`expired and deleted: ${gone.env} on ${gone.alias ?? gone.organizationId}`);
  }
  if (states.length === 0) say(`no state kept in ${opened.store.root}`);
  for (const listing of states) {
    const state = listing.state;
    if (state === undefined) {
      say(`${listing.env} on ${listing.organizationId}: not used — ${listing.damaged ?? ''}`);
      continue;
    }
    const resources = Object.entries(state.resources)
      .map(([name, resource]) => `${name} ${resource.status}`)
      .join(', ');
    say(
      `${state.env} on ${state.org.alias ?? state.org.organizationId} (${state.org.kind}, ` +
        `${state.org.organizationId}): serial ${state.serial}, written ${state.updatedAt}` +
        (listing.expiresAt !== undefined ? `, expires ${listing.expiresAt}` : '') +
        (resources ? `; ${resources}` : ''),
    );
  }
  return {
    journalDir,
    states: states.map((listing) => {
      const state = listing.state;
      if (state === undefined) {
        return {
          env: listing.env,
          organizationId: listing.organizationId,
          damaged: listing.damaged ?? 'not used',
        };
      }
      const expiresAt = stateExpiresAt(state);
      return {
        env: state.env,
        organizationId: state.org.organizationId,
        ...(state.org.alias !== undefined ? { alias: state.org.alias } : {}),
        kind: state.org.kind,
        serial: state.serial,
        resources: Object.fromEntries(
          Object.entries(state.resources).map(([name, resource]) => [name, resource.status]),
        ),
        updatedAt: state.updatedAt,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    }),
    expired: expired.map((gone) => ({
      env: gone.env,
      organizationId: gone.organizationId,
      ...(gone.alias !== undefined ? { alias: gone.alias } : {}),
      expiresAt: gone.expiresAt,
    })),
  };
}

/** Ask for the org's alias to be typed, or go on when `--yes` said so. */
async function confirmed(
  args: CliArgs,
  deps: EnvCliDeps,
  question: string,
  say: (line: string) => void,
): Promise<boolean> {
  if (args.yes) return true;
  const answer = await (deps.ask ?? ((q: string) => typed(q)))(question);
  if (answer === args.org) return true;
  say('Nothing was written: the alias typed is not the org’s.');
  return false;
}

/** The deps of an apply's or a destroy's steps. */
function stepDeps(prepared: Prepared, deps: EnvCliDeps, say: (line: string) => void): EnvStepDeps {
  return {
    runner: prepared.runner,
    store: prepared.store,
    locksDir: prepared.locksDir,
    journalDir: prepared.journalDir,
    orgNow: orgClock(prepared.reached.conn, say),
    say,
    sandforgeVersion: sandforgeVersion(),
    ...(deps.onStop !== undefined ? { onStop: deps.onStop } : {}),
    ...(deps.lockOptions !== undefined ? { lockOptions: deps.lockOptions } : {}),
  };
}

/**
 * `reset`, and `destroy --rewind`: the org rewound to a checkpoint of the
 * environment by the checkpoint script. On a terminal, the rewind's preview
 * first — what it deletes, gives back and brings back, who last changed it —
 * then the alias typed, as an apply asks it; with `--yes`, the rewind alone,
 * which previews the org itself before it writes.
 */
async function rewindVerb(
  args: CliArgs,
  deps: EnvCliDeps,
  verb: EnvRewindInput['verb'],
  say: (line: string) => void,
  answerJson: (value: unknown) => void,
): Promise<void> {
  const prepared = await prepare(args, deps, say);
  const input: EnvRewindInput = {
    verb,
    resolved: prepared.resolved,
    target: prepared.target,
    state: prepared.state,
    acceptAutomation: args.acceptAutomation,
    acceptNoUndo: args.acceptNoUndo,
  };
  const refused = rewindRefusalOf(input);
  if (refused !== undefined) throw stopWith(refused);
  for (const warning of prepared.warnings) say(`warning: ${warning}`);
  let preview: RewindPreview | undefined;
  if (!args.yes) {
    const read = await stoppable(deps, 'reading what a rewind would do', (signal) =>
      previewEnvRewind(stepDeps(prepared, deps, say), input, signal),
    );
    if (!('differs' in read)) {
      throw new Stop(
        { refusal: { code: 'REWIND_REFUSED', message: `${read.refusal} Nothing was written.` } },
        FAILED_EXIT,
      );
    }
    preview = read;
    for (const line of rewindPreviewLines(verb, prepared.target.alias, read)) say(line);
    if (read.refusal !== undefined) {
      throw new Stop(
        { refusal: { code: read.refusal.code, message: read.refusal.message } },
        FAILED_EXIT,
      );
    }
    // Nothing to write, nothing to ask: the checkpoint script asks no question of such a rewind.
    if (read.differs && !(await confirmed(args, deps, rewindQuestionOf(input, read), say))) {
      throw new Stop(
        { refusal: { code: 'DECLINED', message: 'Nothing was written.' } },
        FAILED_EXIT,
      );
    }
  }
  const outcome = await rewindEnvironment(stepDeps(prepared, deps, say), input, preview);
  for (const line of rewindResultLines(outcome.result)) say(line);
  answerJson(outcome.result);
  endWith(outcome.exitCode);
}

/** Run the command; exported so it can be run on the memory org. */
export async function main(argv: string[] = process.argv, deps: EnvCliDeps = {}): Promise<void> {
  const args = parseArgs(argv, deps.cwd);
  // On stderr with --json, where stdout carries the answer alone.
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };
  const answerJson = (value: unknown): void => {
    if (args.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    switch (args.command) {
      case 'validate': {
        const { answer, code } = validate(args, say);
        answerJson(answer);
        endWith(code);
        return;
      }
      case 'state': {
        answerJson(await listStates(args, deps, say));
        return;
      }
      case 'plan': {
        const prepared = await prepare(args, deps, say);
        const { plan } = await stoppable(deps, 'planning', (signal) =>
          planOf(prepared, args, say, signal),
        );
        for (const line of planLines(plan)) say(line);
        answerJson(plan);
        const changed = args.failOnChange && planChanges(plan);
        const drifted = args.failOnDrift && planDrifts(plan);
        endWith(changed || drifted ? PARTIAL_EXIT : DONE_EXIT);
        return;
      }
      case 'apply': {
        if (args.quick) refuseLine('apply makes a whole plan: --quick is for plan alone.');
        const prepared = await prepare(args, deps, say);
        const { plan, dryRuns } = await stoppable(deps, 'planning', (signal) =>
          planOf(prepared, args, say, signal),
        );
        for (const line of planLines(plan)) say(line);
        const writes = plan.refusal === undefined && planChanges(plan);
        if (
          writes &&
          !(await confirmed(
            args,
            deps,
            `Type ${prepared.target.alias} to apply ${plan.env} to it as planned:`,
            say,
          ))
        ) {
          throw new Stop(
            { refusal: { code: 'DECLINED', message: 'Nothing was written.' } },
            FAILED_EXIT,
          );
        }
        const outcome = await applyPlan(stepDeps(prepared, deps, say), {
          plan,
          resolved: prepared.resolved,
          target: prepared.target,
          state: prepared.state,
          dryRuns,
          acceptAutomation: args.acceptAutomation,
        });
        for (const line of runResultLines(outcome.result, 'apply')) say(line);
        answerJson(outcome.result);
        endWith(outcome.exitCode);
        return;
      }
      case 'reset': {
        await rewindVerb(args, deps, 'reset', say, answerJson);
        return;
      }
      case 'destroy': {
        if (args.rewind) {
          await rewindVerb(args, deps, 'destroy', say, answerJson);
          return;
        }
        const prepared = await prepare(args, deps, say);
        const org = {
          organizationId: prepared.target.organizationId,
          kind: prepared.target.kind,
          alias: prepared.target.alias,
        };
        const previews = await stoppable(deps, 'reading what the org holds', (signal) =>
          previewRuns(
            prepared,
            {
              includeChanged: args.includeChanged,
              acceptAutomation: args.acceptAutomation,
              refresh: false,
            },
            say,
            signal,
          ),
        );
        const plan = destructionPlan({
          resolved: prepared.resolved,
          org,
          state: prepared.state,
          previews,
          warnings: prepared.warnings,
        });
        for (const line of planLines(plan)) say(line);
        if (
          plan.refusal === undefined &&
          plan.actions.length > 0 &&
          !(await confirmed(
            args,
            deps,
            `Type ${prepared.target.alias} to take ${plan.env} back from it` +
              (args.includeChanged
                ? ', the records changed since included — on a shared org, others’ work:'
                : ':'),
            say,
          ))
        ) {
          throw new Stop(
            { refusal: { code: 'DECLINED', message: 'Nothing was deleted.' } },
            FAILED_EXIT,
          );
        }
        const outcome = await destroyEnvironment(stepDeps(prepared, deps, say), {
          plan,
          resolved: prepared.resolved,
          target: prepared.target,
          state: prepared.state,
          includeChanged: args.includeChanged,
          sweep: args.sweep,
          acceptAutomation: args.acceptAutomation,
        });
        for (const line of runResultLines(outcome.result, 'destroy')) say(line);
        answerJson(outcome.result);
        endWith(outcome.exitCode);
        return;
      }
    }
  } catch (err: unknown) {
    const stop =
      err instanceof Stop
        ? err
        : new Stop(
            {
              refusal: {
                code: 'FAILED',
                message: err instanceof Error ? err.message : String(err),
              },
            },
            FAILED_EXIT,
          );
    process.stderr.write(`${stop.message}\n`);
    answerJson(stop.answer);
    endWith(stop.code);
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-env')) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
