/**
 * The checkpoint a command line's run takes of what it writes before its
 * first write (`--checkpoint-first`): the options every command that writes
 * reads, the take in this process over the engine's own functions
 * (`modules/checkpoint/beforeRunCheckpoint.ts`), and what the command says of
 * it — on a dry run what it would hold and cost, before the first write the
 * checkpoint and the command that rewinds to it, at the end whether it was
 * kept.
 *
 * A command line has nobody to ask: the option is its answer. Asked first, the
 * checkpoint's cost — the target's tables, not the run's rows — is said, and
 * the run goes on its flags or is refused, never asked.
 *
 * The take runs in the command's own process, not through
 * `sandforge-checkpoint`: a command spawned for it would be refused by the
 * run's own mark, and an option of that command to look past a run would be
 * an option any caller could give. It keeps the checkpoint in the store the
 * Checkpoints page and `sandforge-checkpoint` list, under `checkpoints/` of
 * `SANDFORGE_JOURNAL_DIR` or of `~/.sandforge`, and reads the org through a
 * connection of its own, so the run's count of its calls holds its own.
 *
 * What refuses it, beside the take's own guards and the store's lock: a Sync
 * or Seed run's file with no end of another live process, or of this one
 * under another run id, writing to the org, and an apply, a destroy or a reset
 * of an environment of the org under way on this machine. The run's own file
 * alone does not. The editor's runs keep their files in its own storage, and
 * are not seen here, as `sandforge-checkpoint take` does not see them.
 */

import type { Connection } from 'jsforce';
import type {
  CheckpointBeforeRunModule,
  CheckpointRefusal,
  CheckpointRefusalCode,
  OrgType,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointRequest,
  RunCheckpointTaken,
  StillRunning,
} from '@sandforge/shared';
import { orgTypeOf } from '@sandforge/shared';
import {
  BEFORE_RUN_DELETED_WORDS,
  beforeRunKeepDaysOf,
  beforeRunProgressWords,
  type BeforeRunDeps,
  type BeforeRunOrg,
  type BeforeRunOwn,
  type BeforeRunRequest,
  type BeforeRunTake,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { checkpointQuestionLines } from '../src/core/precheck/ProductionGuard.js';
import {
  CHECKPOINT_REFUSED,
  CHECKPOINT_STOPPED_WORDS,
  type CheckpointFirstStop,
} from '../src/modules/forge/ForgeRunGate.js';
import { THIS_HOST, writtenElsewhere, type RunWriterHost } from '../src/modules/sync/runWriter.js';
import type { SyncRunKept } from '../src/modules/sync/SyncRunCreations.js';
import type { TypedTarget } from './targetKind.js';
import type { SfOrg } from './sfSession.js';
import { commandOf } from './invocation.js';

// ─── The options ─────────────────────────────────────────────────────────────

/** The switch that asks for it. */
export const CHECKPOINT_FIRST = '--checkpoint-first';

/** The flags of the option, as a command's flags list them. */
export const CHECKPOINT_FIRST_FLAGS = {
  switches: [CHECKPOINT_FIRST],
  values: ['--checkpoint-keep-days', '--checkpoint-exclude-object'],
} as const;

/** An object's API name, as `--checkpoint-exclude-object` takes one. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * The option's lines of a command's `--help`, in its column: `run` is what
 * the command writes ("the run", "the load"), `simulation` the flag that
 * writes nothing (`--dry-run`, `--plan-only`), `step` the words a command of
 * steps puts first ("with load: "), `note` what the command says of the
 * option beside, under it.
 */
export function checkpointFirstHelp(words: {
  run: string;
  simulation: string;
  step?: string;
  note?: readonly string[];
}): string {
  const step = words.step ?? '';
  return [
    `  --checkpoint-first     ${step}take a checkpoint of what ${words.run} writes before its`,
    '                         first write: each object it writes, and each the',
    "                         target's flows that still run create as it writes",
    '                         them, held whole, as every checkpoint holds an object.',
    '                         Its cost is that of the tables, not of the records',
    `                         written, and is said first. A rewind to it takes ${words.run}`,
    '                         back (sandforge checkpoint rewind), and the work of',
    '                         anyone else on those objects since with it. Refused',
    `                         — another run writing, a limit, the disk — ${words.run}`,
    '                         writes nothing, exit 1; deleted again when it writes',
    `                         nothing; with ${words.simulation}, says what it would hold and`,
    '                         cost, and takes nothing                (default: off)',
    ...(words.note ?? []).map((line) => `                         ${line}`),
    '  --checkpoint-keep-days <n>',
    '                         the days that checkpoint is kept on this machine,',
    '                         0 to 3650, 0 until it is deleted          (default: 7)',
    '  --checkpoint-exclude-object <ApiName>',
    '                         leave an object out of that checkpoint, named; a',
    '                         rewind leaves its records as they are; repeat for more',
  ].join('\n');
}

/** Say why the line cannot be read, and exit 2: nothing was reached. */
function refuseLine(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * What the line asks of the checkpoint before its run, or undefined when it
 * asks none; exits 2 on a line that cannot be read: a number of days that is
 * none, an object that is no API name, either without `--checkpoint-first`,
 * or the option beside a flag of `refusedWith` — one under which the run
 * writes nothing to take back, or takes up a run that wrote already.
 *
 * @param refusedWith - The flags the option does not go with, each with why.
 */
export function checkpointFirstArgs(
  args: readonly string[],
  refusedWith: ReadonlyArray<{ flag: string; why: string }> = [],
): RunCheckpointRequest | undefined {
  const values = (flag: string): string[] => {
    const out: string[] = [];
    for (let at = 0; at < args.length; at++) {
      if (args[at] === flag && at + 1 < args.length) out.push(args[at + 1]);
    }
    return out;
  };
  const days = values('--checkpoint-keep-days');
  const excluded = values('--checkpoint-exclude-object');
  if (!args.includes(CHECKPOINT_FIRST)) {
    const given = [
      ...(days.length > 0 ? ['--checkpoint-keep-days'] : []),
      ...(excluded.length > 0 ? ['--checkpoint-exclude-object'] : []),
    ];
    if (given.length > 0) {
      refuseLine(
        `${given.join(' and ')} ${given.length === 1 ? 'goes' : 'go'} with ${CHECKPOINT_FIRST}, ` +
          'which takes the checkpoint they set. Run with --help.',
      );
    }
    return undefined;
  }
  for (const { flag, why } of refusedWith) {
    if (args.includes(flag)) refuseLine(`${CHECKPOINT_FIRST} does not go with ${flag}: ${why}`);
  }
  if (days.length > 1) {
    refuseLine(`--checkpoint-keep-days is given ${days.length} times: give it once.`);
  }
  let keepDays: number | undefined;
  if (days.length === 1) {
    const raw = days[0];
    keepDays = /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
    try {
      beforeRunKeepDaysOf(keepDays, undefined);
    } catch {
      refuseLine(
        `--checkpoint-keep-days takes a whole number of days from 0 to 3650, not "${raw}".`,
      );
    }
  }
  const names: string[] = [];
  for (const name of excluded) {
    if (!API_NAME.test(name)) {
      refuseLine(`--checkpoint-exclude-object takes an object's API name, not "${name}".`);
    }
    if (!names.some((known) => known.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return {
    ...(keepDays !== undefined ? { keepDays } : {}),
    ...(names.length > 0 ? { excluded: names } : {}),
  };
}

// ─── What refuses the take, beside its own guards ────────────────────────────

/** What the take is held to beside the org's lock: the runs and the applies of this machine. */
export interface CommandRunWritingInput {
  /** The org as the refusal names it: the alias the command was given. */
  orgName: string;
  /** The alias, as a run's file of a command line names its target. */
  alias: string;
  /** The Sync and Seed runs' files of this machine, each of their own folder. */
  runs: ReadonlyArray<{ list(): Promise<SyncRunKept[]> }>;
  /** Who holds the org's environment lock, said as a refusal says it; undefined when nobody does. */
  envLock?: (organizationId: string) => string | undefined;
  own?: BeforeRunOwn;
  /** This process, as a run's file names its writer. */
  self?: RunWriterHost;
  /** Whether another process writes a run, as {@link writtenElsewhere} tells it. */
  elsewhere?: (run: SyncRunKept) => boolean;
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string | undefined, b: string): boolean {
  return a !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/**
 * What else of this machine writes to the org, said as a refusal says it, or
 * nothing: the `runWriting` of a take before a command line's run. A Sync or
 * Seed run with no end writing to it — named by the org's Organization Id, or
 * by the alias a command line was given — refuses it when another live
 * process writes it, or this process under another run id; the run's own
 * file (`own.runId`, of this process) does not. An apply, a destroy or a reset
 * of an environment of the org refuses it too. A run of another machine, or of
 * another user of this one, is not seen.
 */
export function commandRunWriting(
  input: CommandRunWritingInput,
): (organizationId: string) => Promise<string | undefined> {
  const self = input.self ?? THIS_HOST;
  const elsewhere = input.elsewhere ?? ((run: SyncRunKept) => writtenElsewhere(run, self));
  const words =
    `A SandForge run is writing to ${input.orgName}: start this run once it has ended. ` +
    'No record was read.';
  const writtenHere = (run: SyncRunKept): boolean =>
    run.writer !== undefined &&
    run.writer.pid === self.pid &&
    Date.parse(run.writer.hostStartedAt) === Date.parse(self.startedAt);
  return async (organizationId) => {
    const applying = input.envLock?.(organizationId);
    if (applying !== undefined) {
      return `${applying}: start this run once it has ended. No record was read.`;
    }
    for (const files of input.runs) {
      for (const run of await files.list()) {
        if (run.end !== undefined) continue;
        const toTheOrg =
          sameOrganization(run.targetOrganizationId, organizationId) ||
          sameOrganization(run.targetOrgId, organizationId) ||
          run.targetOrgId === input.alias;
        if (!toTheOrg) continue;
        const own = input.own?.runId !== undefined && run.runId === input.own.runId;
        if (writtenHere(run) ? !own : elsewhere(run)) return words;
      }
    }
    return undefined;
  };
}

// ─── The take, in this process ───────────────────────────────────────────────

/** The org a command line's run writes to, typed as the panel types an org it connects. */
export interface CommandCheckpointOrg {
  /** `Organization.Id`: what the take's own snapshot connects through. */
  id: string;
  orgType: OrgType;
  edition?: string;
}

/** The org a command typed from its `Organization` record, as a checkpoint is asked it. */
export function checkpointOrgOf(
  session: Pick<SfOrg, 'scratch'>,
  typed: TypedTarget,
): CommandCheckpointOrg {
  return {
    id: typed.id,
    orgType: orgTypeOf({
      isScratch: session.scratch === true,
      isSandbox: typed.sandbox,
      edition: typed.edition,
    }),
    ...(typed.edition !== undefined ? { edition: typed.edition } : {}),
  };
}

/** What the checkpoint before a command line's run is taken of, and by whom. */
export interface CommandCheckpointsInput {
  module: CheckpointBeforeRunModule;
  /** The run, as the checkpoint's file names it. */
  operationId: string;
  request: RunCheckpointRequest;
  /** The target's session: the take reads the org through a connection of its own. */
  session: SfOrg;
  org: CommandCheckpointOrg;
  /** A connection over `session`: the command's own `makeConn`. */
  connect: (session: SfOrg) => Connection;
  /** Where the command keeps the journals of its runs (`SANDFORGE_JOURNAL_DIR`, or `~/.sandforge`). */
  journalDir: string;
  /** Where the command prints a line: the take's warnings and its progress. */
  say: (line: string) => void;
  own?: BeforeRunOwn;
  /** The store's folder; `checkpoints/` of `journalDir` unless a test says. */
  storeRoot?: string;
  /** The org's lock folder; `~/.sandforge/locks` unless a test says. */
  locksDir?: string;
  /** What the store's disk has free, unless the system's answer. */
  freeBytes?: BeforeRunDeps['freeBytes'];
}

/** What a run asks the checkpoint to hold: the objects it writes, and what still runs as it writes them. */
export interface CommandCheckpointAsk {
  written: readonly string[];
  running: Pick<StillRunning<unknown>, 'firing'>;
}

/** How a take before a command line's run is run. */
export interface CommandTakeOptions {
  /** The run's Stop: it stops the take between two reads, keeping nothing. */
  signal?: AbortSignal;
}

/** The checkpoint before a command line's run, at its gate, at its take and once it ended. */
export interface CommandCheckpoints {
  /** At the run's gate: what it would hold and cost, and the refusal a real run would meet. */
  scope(ask: CommandCheckpointAsk): Promise<RunCheckpointEstimate>;
  /** Once the run's flags let it write, before the lease and the first write. */
  take(
    ask: CommandCheckpointAsk,
    planned: Pick<RunCheckpointEstimate, 'estimate'>,
    options?: CommandTakeOptions,
  ): Promise<BeforeRunTake>;
  /** Once the run ended: kept when it wrote a record, deleted when it wrote none. */
  settle(taken: RunCheckpointTaken, wrote: boolean): Promise<RunCheckpointInfo>;
}

/** The store's refusal, in words: the folder cannot hold checkpoints. */
function storeRefusalWords(refusal: { path: string; reason: string; detail?: string }): string {
  const why =
    refusal.reason === 'notAFolder'
      ? 'it is a file, not a folder'
      : refusal.reason === 'otherOwner'
        ? 'another user of this machine owns it, and could read and replace the checkpoints in it'
        : `it could not be made${refusal.detail !== undefined ? ` (${refusal.detail})` : ''}`;
  return `the checkpoints cannot be kept in ${refusal.path}: ${why}`;
}

/** The take's progress, said each tenth of the way. */
function progressPrinter(say: (line: string) => void): (progress: { percentage: number }) => void {
  let said = -1;
  return ({ percentage }) => {
    const tenth = Math.floor(percentage / 10);
    if (tenth <= said) return;
    said = tenth;
    say(`  ${beforeRunProgressWords(percentage)}`);
  };
}

/**
 * The checkpoint before a command line's run, over the engine's own scope,
 * take and settle: the org the command typed, the store everyone lists, kept
 * the days the line asks or 7, its origin the command (`tool: 'cli'`). The
 * engine's modules and the store load on the first call: a run that asks for
 * none never loads them.
 */
export function commandCheckpoints(input: CommandCheckpointsInput): CommandCheckpoints {
  let deps: Promise<{ deps: BeforeRunDeps; org: BeforeRunOrg }> | undefined;
  const depsOf = (): Promise<{ deps: BeforeRunDeps; org: BeforeRunOrg }> =>
    (deps ??= (async () => {
      const { join } = await import('node:path');
      const { takeOrgOf } = await import('../src/modules/checkpoint/takeCheckpoint.js');
      const { openCheckpointStore } =
        await import('../src/modules/checkpoint/OrgCheckpointStore.js');
      const { nodeSyncRunCreations } = await import('../src/modules/sync/SyncRunCreations.js');
      const { nodeSeedRunCreations } = await import('../src/modules/seed/SeedRunCreations.js');
      const { envLockHolder, envLockLine } = await import('./env/envLock.js');
      const opened = openCheckpointStore({
        root: input.storeRoot ?? join(input.journalDir, 'checkpoints'),
        ...(input.locksDir !== undefined ? { locksDir: input.locksDir } : {}),
      });
      if ('refusal' in opened) throw new Error(storeRefusalWords(opened.refusal));
      const { store } = opened;
      const { session } = input;
      const conn = input.connect(session);
      // The org as the take's own snapshot reaches it: by its Organization
      // Id, through these credentials, and no other org.
      const known = {
        id: input.org.id,
        alias: session.alias,
        username: session.username,
        instanceUrl: session.instanceUrl,
        orgType: input.org.orgType,
        metadata: {
          apiVersion: conn.version,
          ...(input.org.edition !== undefined ? { edition: input.org.edition } : {}),
        },
      };
      const handler = {
        log: (line: string) => {
          if (line.startsWith('[WARN] ')) input.say(`warning: ${line.slice('[WARN] '.length)}`);
        },
        orgManager: { getOrg: (id: string) => (id === known.id ? known : undefined) },
        orgRegistry: {
          getCredentials: async (id: string) =>
            id === known.id
              ? { accessToken: session.accessToken, instanceUrl: session.instanceUrl }
              : undefined,
        },
      } as unknown as BeforeRunDeps['handler'];
      return {
        deps: {
          org: takeOrgOf(conn),
          store,
          handler,
          runWriting: commandRunWriting({
            orgName: session.alias,
            alias: session.alias,
            runs: [nodeSyncRunCreations(input.journalDir), nodeSeedRunCreations(input.journalDir)],
            envLock: (organizationId) => {
              const holder = envLockHolder(store.locksDir, organizationId);
              return holder !== undefined ? envLockLine(holder) : undefined;
            },
            ...(input.own ? { own: input.own } : {}),
          }),
          ...(input.freeBytes ? { freeBytes: input.freeBytes } : {}),
        },
        org: {
          orgId: input.org.id,
          orgName: session.alias,
          alias: session.alias,
          username: session.username,
          instanceUrl: session.instanceUrl,
          registered: {
            orgType: input.org.orgType,
            ...(input.org.edition !== undefined
              ? { metadata: { edition: input.org.edition } }
              : {}),
          },
        },
      };
    })());
  const requestOf = (ask: CommandCheckpointAsk): BeforeRunRequest => ({
    module: input.module,
    written: ask.written,
    running: ask.running,
    request: input.request,
    operationId: input.operationId,
    tool: 'cli',
    keepDays: beforeRunKeepDaysOf(input.request.keepDays, undefined),
  });
  return {
    async scope(ask) {
      const engine = await import('../src/modules/checkpoint/beforeRunCheckpoint.js');
      const { deps: made, org } = await depsOf();
      return engine.scopeBeforeRun(made, org, requestOf(ask));
    },
    async take(ask, planned, options = {}) {
      const engine = await import('../src/modules/checkpoint/beforeRunCheckpoint.js');
      const { deps: made, org } = await depsOf();
      return engine.takeBeforeRun(
        {
          ...made,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress: progressPrinter(input.say),
        },
        org,
        requestOf(ask),
        planned,
      );
    },
    async settle(taken, wrote) {
      const engine = await import('../src/modules/checkpoint/beforeRunCheckpoint.js');
      const { deps: made } = await depsOf();
      const settled = await engine.settleBeforeRun(made.store, taken, wrote);
      if (settled.notDeleted !== undefined) input.say(`warning: ${settled.notDeleted}`);
      return settled.info;
    },
  };
}

// ─── What the command says of it ─────────────────────────────────────────────

/**
 * What the run's lines say of the checkpoint it takes first before it
 * writes, as its question would: its cost, what it adds and why, what it
 * leaves out, and what no read tells. A dry run says the same of the one a
 * real run would take.
 */
export function checkpointEstimateLines(estimate: RunCheckpointEstimate): string[] {
  return checkpointQuestionLines(estimate).map((line) => `  ${line}`);
}

/** The refusals a checkpoint with fewer objects could pass: its limits, the day's requests, the disk. */
const LEFT_OUT_HELPS: ReadonlySet<CheckpointRefusalCode> = new Set([
  'TOO_MANY_RECORDS',
  'API_BUDGET',
  'DISK',
]);

/**
 * A run's refusal for its checkpoint's, as a command line says it: the
 * take's own words, without what it did not read, and what to do — the
 * option to drop, an object to leave out where fewer would pass. The panel's
 * words name its box; a command line has a flag. The caller closes on
 * "Nothing was written.", as every refusal of its gate does.
 */
export function checkpointRefusedWords(
  refusal: Pick<CheckpointRefusal, 'code' | 'message'>,
): string {
  const said = refusal.message.replace(/\s*No record was read\.$/, '');
  const leaveOut = LEFT_OUT_HELPS.has(refusal.code)
    ? 'leave an object out of it (--checkpoint-exclude-object <ApiName>), '
    : '';
  return (
    `The checkpoint before the run was refused: ${said} Fix what refuses it, ${leaveOut}or run ` +
    `without ${CHECKPOINT_FIRST} to write without one.`
  );
}

/**
 * Why a run stops before its first write for the checkpoint it takes first,
 * as a command line says it, closing on "Nothing was written.": the take
 * refused, in the command's words; failed, in the take's; or stopped.
 */
export function checkpointStopWords(stop: CheckpointFirstStop): string {
  if (stop.code !== CHECKPOINT_REFUSED) return CHECKPOINT_STOPPED_WORDS;
  return stop.refusal !== undefined
    ? `${checkpointRefusedWords(stop.refusal)} Nothing was written.`
    : stop.message;
}

/** When a checkpoint goes from this machine, as a line says it: its day, or never on its own. */
function keptUntil(expiresAt: string | null): string {
  return expiresAt === null ? 'kept until it is deleted' : `kept until ${expiresAt.slice(0, 10)}`;
}

/**
 * What a run says once it took its checkpoint, before its first write: the
 * checkpoint, what it holds and until when, the command that rewinds the org
 * to it — muting as the run muted — and what it does not hold.
 *
 * @param target - The alias the run writes to.
 * @param muted - Whether the run mutes the target's automation.
 */
export function checkpointTakenLines(
  taken: RunCheckpointTaken,
  target: string,
  muted: boolean,
): string[] {
  return [
    `checkpoint before the run: ${taken.checkpointId} '${taken.name}', ` +
      `${taken.objects.length} object(s), ${taken.records} record(s), ${keptUntil(taken.expiresAt)}`,
    `  rewind to it: ${commandOf('checkpoint')} rewind --org ${target} --checkpoint ` +
      `${taken.checkpointId}${muted ? ' --mute-automation' : ''}`,
    ...taken.notHeld.map(
      ({ objectApiName, reason }) => `  not in the checkpoint: ${objectApiName} — ${reason}`,
    ),
  ];
}

/** What a run says last of its checkpoint: deleted, the run having written nothing; nothing when kept. */
export function checkpointSettledLines(info: RunCheckpointInfo): string[] {
  return info.state === 'deleted' ? [BEFORE_RUN_DELETED_WORDS] : [];
}

/**
 * What becomes of the checkpoint a run took first once it ended, whatever it
 * ended on: kept when it wrote, deleted when it wrote nothing, and said. Only
 * its deletion can fail: the checkpoint is then kept and said, with the
 * command that deletes it, and is never the run's failure.
 *
 * @param target - The alias the run writes to.
 * @param say - Where the command prints a line.
 */
export async function settleCommandCheckpoint(
  checkpoints: Pick<CommandCheckpoints, 'settle'>,
  taken: RunCheckpointTaken,
  wrote: boolean,
  target: string,
  say: (line: string) => void,
): Promise<RunCheckpointInfo> {
  try {
    const info = await checkpoints.settle(taken, wrote);
    for (const line of checkpointSettledLines(info)) say(line);
    return info;
  } catch (err: unknown) {
    say(
      `warning: the checkpoint '${taken.name}' taken before the run, which wrote nothing, could ` +
        `not be deleted (${err instanceof Error ? err.message : String(err)}): delete it with ` +
        `${commandOf('checkpoint')} delete --org ${target} --checkpoint ${taken.checkpointId}`,
    );
    return taken;
  }
}
