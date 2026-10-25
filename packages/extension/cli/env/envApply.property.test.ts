/**
 * Properties of an environment on the memory org, over random files and
 * random histories: files of one to four seed resources, some drawing their
 * contacts from the accounts another writes, and what a team does to them
 * over weeks — a count edited, a resource added to the file or taken out of
 * it, apply, apply with --replace or --replace-drifted, a colleague deleting
 * or changing records by id, a validation rule refusing a record, a CI job
 * stopped while the verb plans, or before, during or after one of the
 * scripts an apply or a destroy spawns, destroy.
 *
 * Each history runs the command line's own `main`, as a terminal or a CI
 * step runs it, its scripts `sandforge-seed`'s own `main` in this process.
 * The records are counted by the ids each run kept, through the run the state
 * names, and by what the org took as each script ran: never by what a script
 * said it wrote.
 *
 * What holds, whatever the history:
 * - after an apply that ended 0, a plan finds nothing to change, and an
 *   apply again spawns no script that writes, and leaves the state's serial
 *   and every record as they were;
 * - after an apply that ended 0, the org holds what the file describes, per
 *   resource and object, minus what others deleted; of the environment's
 *   records nothing else is left but what others changed, and the records
 *   those hang from; a plan says drift exactly when others touched records
 *   the state still holds; and an apply no stop, no refusal and no one
 *   else's change got in the way of ends 0;
 * - an apply stopped part way, applied again, ends where one never stopped
 *   ends: no record written twice;
 * - destroy leaves no record of the environment, and every record of the
 *   org's own as it was, and deletes the state; or it exits 3, naming per
 *   object exactly what it left;
 * - a run a removal took back whole is never taken back, or read, again;
 * - what a plan says a resource would write is what the apply then writes.
 *
 * A fixed seed keeps the histories the same from run to run; fast-check
 * prints it, with the history, when a property fails.
 * `SANDFORGE_PROPERTY_SEED` and `SANDFORGE_PROPERTY_RUNS` run other ones.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  envPlanSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
  type EnvPlan,
  type EnvRunResult,
} from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../sfSession.js', () => ({ loadOrg: vi.fn(), makeConn: vi.fn() }));
vi.mock('../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { nodeSeedRunCreations } from '../../src/modules/seed/SeedRunCreations.js';
import { orgStamp } from '../../src/test/memoryRemovalOrg.js';
import { paced } from '../../src/test/runnerPace.js';
import { main as envMain } from '../sandforge-env.js';
import type { CommandRunner } from '../scriptRunner.js';
import type { StopSignal } from '../stopSignals.js';
import { EnvWorld, runInProcess } from '../testing/envWorld.js';
import { isStopCode } from './envApply.js';
import { openEnvStore, type EnvStore } from './envState.js';
import { readSeedRun } from './envSteps.js';

const ORG_ID = '00D000000000007AAA';
const OTHER_USER = '005000000000009AAA';
const ALIAS = 'TGT';
const ENV = 'props';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const DAY = 86_400_000;

/** A whole number from the environment, or the default. */
function fromEnv(name: string, otherwise: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : otherwise;
}

/** A fixed seed: the same histories on every run, and in every property that shares an arbitrary. */
const SEED = fromEnv('SANDFORGE_PROPERTY_SEED', 1_418_030_377);

/**
 * Histories each property runs. Fewer on a Windows runner, whose disk takes
 * the state and the run files several times slower: the other runners try
 * the histories, it tries the platform.
 */
const RUNS = fromEnv('SANDFORGE_PROPERTY_RUNS', process.platform === 'win32' ? 4 : 25);

// ─── The file ────────────────────────────────────────────────────────────────

type ObjectName = 'Account' | 'Contact' | 'Asset';
const OBJECTS: readonly ObjectName[] = ['Account', 'Contact', 'Asset'];

/** The field each object's records are named by: `SFENV <resource>`, so a relation can find them. */
const NAME_FIELD: Readonly<Record<ObjectName, string>> = {
  Account: 'Name',
  Contact: 'LastName',
  Asset: 'Name',
};

/** The most accounts a relation reads from the org: more than any resource writes. */
const PARENTS_LIMIT = 6;

interface ObjectSpec {
  object: ObjectName;
  /** 0 is a file the schema refuses: an edit to it is refused, and changes nothing. */
  count: number;
  /** Records each REST call sends: 1 lets a stop fall between two records. */
  batchSize?: number;
}

interface ResourceSpec {
  name: string;
  seed?: number;
  dependsOn: string[];
  objects: ObjectSpec[];
  /** Its contacts, placed under accounts: its own (`from` is its name), or those another writes. */
  parents?: { from: string; perParent: number };
}

const markOf = (resource: string): string => `SFENV ${resource}`;

/** The file a history writes, as `sandforge.yaml`: JSON, which YAML 1.2 reads. */
function documentOf(spec: readonly ResourceSpec[]): Record<string, unknown> {
  return {
    version: 1,
    name: ENV,
    resources: Object.fromEntries(
      spec.map((resource) => [
        resource.name,
        {
          kind: 'seed',
          ...(resource.seed !== undefined ? { seed: resource.seed } : {}),
          ...(resource.dependsOn.length > 0 ? { dependsOn: resource.dependsOn } : {}),
          objects: resource.objects.map((object) => ({
            object: object.object,
            count: object.count,
            fields: [
              {
                fieldApiName: NAME_FIELD[object.object],
                ruleType: 'static',
                config: { staticValue: markOf(resource.name) },
              },
            ],
            ...(object.batchSize !== undefined ? { batchSize: object.batchSize } : {}),
          })),
          ...(resource.parents !== undefined
            ? {
                relations: [
                  {
                    lookup: 'Contact.AccountId',
                    parents:
                      resource.parents.from === resource.name
                        ? { object: 'Account' }
                        : {
                            object: 'Account',
                            existing: {
                              where: `Name = '${markOf(resource.parents.from)}'`,
                              limit: PARENTS_LIMIT,
                            },
                          },
                    distribution: { mode: 'perParent', count: resource.parents.perParent },
                  },
                ],
              }
            : {}),
        },
      ]),
    ),
  };
}

const countOf = (resource: ResourceSpec, object: ObjectName): number =>
  resource.objects.find((each) => each.object === object)?.count ?? 0;

/**
 * The records a resource's run writes of an object, the file read as the seed
 * reads it: contacts under accounts stop at the accounts' share of them.
 */
function expectedCount(
  spec: readonly ResourceSpec[],
  resource: ResourceSpec,
  object: ObjectSpec,
): number {
  if (object.object !== 'Contact' || resource.parents === undefined) return object.count;
  const from = spec.find((each) => each.name === resource.parents?.from);
  const accounts = from === undefined ? 0 : countOf(from, 'Account');
  const parents = from === resource ? accounts : Math.min(PARENTS_LIMIT, accounts);
  return Math.min(object.count, resource.parents.perParent * parents);
}

/** What a resource of a generated file is made of, before its name and place are known. */
interface Draft {
  shape: 'accounts' | 'assets' | 'family' | 'contacts' | 'under';
  counts: [number, number];
  perParent: number;
  /** Which earlier resource writing accounts an `under` resource draws from. */
  from: number;
  /** Whether it also depends on the resource before it. */
  chain: boolean;
  seed: number | undefined;
  batchSize: number | undefined;
}

const RESOURCE_NAMES = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
const MAX_RESOURCES = 4;

function resourceOf(draft: Draft, name: string, earlier: readonly ResourceSpec[]): ResourceSpec {
  const sources = earlier.filter((each) => countOf(each, 'Account') > 0);
  // Contacts drawn from accounts no resource before writes: the accounts, then.
  const shape = draft.shape === 'under' && sources.length === 0 ? 'accounts' : draft.shape;
  const [first, second] = draft.counts;
  const batch = draft.batchSize !== undefined ? { batchSize: draft.batchSize } : {};
  const dependsOn = new Set<string>();
  const previous = earlier.at(-1);
  if (draft.chain && previous !== undefined) dependsOn.add(previous.name);
  let objects: ObjectSpec[];
  let parents: ResourceSpec['parents'];
  switch (shape) {
    case 'accounts':
      objects = [{ object: 'Account', count: first, ...batch }];
      break;
    case 'assets':
      objects = [{ object: 'Asset', count: first, ...batch }];
      break;
    case 'contacts':
      objects = [{ object: 'Contact', count: first, ...batch }];
      break;
    case 'family':
      objects = [
        { object: 'Account', count: first },
        { object: 'Contact', count: second, ...batch },
      ];
      parents = { from: name, perParent: draft.perParent };
      break;
    case 'under': {
      const source = sources[draft.from % sources.length];
      if (source === undefined) throw new Error('no source');
      objects = [{ object: 'Contact', count: first, ...batch }];
      parents = { from: source.name, perParent: draft.perParent };
      dependsOn.add(source.name);
      break;
    }
  }
  return {
    name,
    ...(draft.seed !== undefined ? { seed: draft.seed } : {}),
    dependsOn: [...dependsOn],
    objects,
    ...(parents !== undefined ? { parents } : {}),
  };
}

/** The file without a resource: what depended on it, or drew from it, no longer does. */
function without(spec: readonly ResourceSpec[], name: string): ResourceSpec[] {
  return spec
    .filter((resource) => resource.name !== name)
    .map((resource) => {
      const { parents, ...rest } = resource;
      return {
        ...rest,
        dependsOn: resource.dependsOn.filter((dep) => dep !== name),
        ...(parents !== undefined && parents.from !== name ? { parents } : {}),
      };
    });
}

const draftArb: fc.Arbitrary<Draft> = fc.record({
  // Accounts, and contacts drawn from them, more than the rest: what an
  // environment's order and its removals have to get right.
  shape: fc.oneof(
    { weight: 2, arbitrary: fc.constant('accounts' as const) },
    { weight: 2, arbitrary: fc.constant('family' as const) },
    { weight: 4, arbitrary: fc.constant('under' as const) },
    { weight: 1, arbitrary: fc.constant('contacts' as const) },
    { weight: 1, arbitrary: fc.constant('assets' as const) },
  ),
  counts: fc.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 6 })),
  perParent: fc.integer({ min: 1, max: 2 }),
  from: fc.nat({ max: 3 }),
  chain: fc.boolean(),
  seed: fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }),
  batchSize: fc.option(fc.constantFrom(1, 2), { nil: undefined }),
});

/** A file of one to four resources, each drawn from those before it. */
const fileArb: fc.Arbitrary<ResourceSpec[]> = fc
  .tuple(
    fc.constantFrom(1, 2, 3, MAX_RESOURCES),
    fc.array(draftArb, { minLength: MAX_RESOURCES, maxLength: MAX_RESOURCES }),
  )
  .map(([length, drafts]) =>
    drafts
      .slice(0, length)
      .reduce<ResourceSpec[]>(
        (spec, draft, i) => [...spec, resourceOf(draft, RESOURCE_NAMES[i] ?? `r${i}`, spec)],
        [],
      ),
  );

// ─── The history ─────────────────────────────────────────────────────────────

/**
 * Where a stop falls: the k-th script of the verb that writes, before it, at
 * its j-th record or delete, or after it; or, `planning`, before the k-th
 * preview or dry run of the plan the verb makes first.
 */
interface StopPlan {
  at: number;
  when: 'before' | 'during' | 'after' | 'planning';
  record: number;
}

type Op =
  | { op: 'edit'; at: number; object: number; count: number }
  | { op: 'add'; draft: Draft }
  | { op: 'remove'; at: number }
  | {
      op: 'apply';
      replace: number | undefined;
      replaceDrifted: boolean;
      planFirst: boolean;
      stop: StopPlan | undefined;
    }
  | { op: 'drift'; how: 'delete' | 'change'; pick: number; two: boolean }
  /** The org refuses the n-th record of an object the next apply sends, as a validation rule would. */
  | { op: 'refuse'; object: ObjectName; nth: number }
  | { op: 'destroy'; stop: StopPlan | undefined };

const stopArb: fc.Arbitrary<StopPlan> = fc.record({
  at: fc.nat({ max: 4 }),
  when: fc.constantFrom('before', 'during', 'after', 'planning'),
  record: fc.nat({ max: 3 }),
});

const applyArb = (stop: fc.Arbitrary<StopPlan | undefined>): fc.Arbitrary<Op> =>
  fc.record({
    op: fc.constant('apply' as const),
    // A replace runs again what a stop left half-written, and hides it:
    // rarer than a plain apply.
    replace: fc.oneof(
      { weight: 2, arbitrary: fc.constant(undefined) },
      { weight: 1, arbitrary: fc.nat({ max: 3 }) },
    ),
    replaceDrifted: fc.oneof(
      { weight: 2, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
    planFirst: fc.boolean(),
    stop,
  });

const opArb = (stop: fc.Arbitrary<StopPlan | undefined>): fc.Arbitrary<Op> =>
  fc.oneof(
    { weight: 5, arbitrary: applyArb(stop) },
    {
      weight: 3,
      arbitrary: fc.record({
        op: fc.constant('edit' as const),
        at: fc.nat({ max: 3 }),
        object: fc.nat({ max: 1 }),
        count: fc.integer({ min: 0, max: 6 }),
      }),
    },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('add' as const), draft: draftArb }) },
    {
      weight: 1,
      arbitrary: fc.record({ op: fc.constant('remove' as const), at: fc.nat({ max: 3 }) }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        op: fc.constant('drift' as const),
        how: fc.constantFrom('delete', 'change'),
        pick: fc.nat({ max: 40 }),
        two: fc.boolean(),
      }),
    },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('destroy' as const), stop }) },
    {
      weight: 1,
      arbitrary: fc.record({
        op: fc.constant('refuse' as const),
        object: fc.constantFrom(...OBJECTS),
        nth: fc.nat({ max: 3 }),
      }),
    },
  );

const maybeStop = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: stopArb },
);
const historyArb = fc.array(opArb(maybeStop), { minLength: 2, maxLength: 9 });
const quietHistoryArb = fc.array(opArb(fc.constant(undefined)), { minLength: 0, maxLength: 5 });

/** What a script was run for, read off its line. */
interface Call {
  kind: 'run' | 'dry-run' | 'preview' | 'remove';
  /**
   * The run it ran, previewed or took back: `<lineage>:<resource>:<n>`, the
   * ranks starting again from 1 in a state made again after a destroy.
   */
  run: string;
  code: number;
}

/** What a command answered, and how it ended. */
interface Answered {
  code: number;
  answer: unknown;
  said: string;
}

/** Whether a verb was stopped as it planned, before its first step: refused, `STOPPED`. */
function isStoppedPlanning(ran: Answered): boolean {
  const parsed = envRefusalAnswerSchema.safeParse(ran.answer);
  return parsed.success && parsed.data.refusal.code === 'STOPPED';
}

const isWriting = (call: Pick<Call, 'kind'>): boolean =>
  call.kind === 'run' || call.kind === 'remove';

function kindOf(args: readonly string[]): Call['kind'] {
  if (args.includes('--preview')) return 'preview';
  if (args.includes('--remove')) return 'remove';
  if (args.includes('--dry-run')) return 'dry-run';
  return 'run';
}

const valueAfter = (args: readonly string[], flag: string): string =>
  args[args.indexOf(flag) + 1] ?? '';

/** The resource and rank a line names, by its run id or by the summary it takes back. */
function resourceRunOf(args: readonly string[]): { resource: string; n: number; runId?: string } {
  const subject = args.includes('--remove')
    ? valueAfter(args, '--remove')
    : valueAfter(args, '--run-id');
  const byId = new RegExp(`^env-${ENV}-([a-z][a-z0-9]*)-(\\d+)-`).exec(subject);
  if (byId !== null) {
    return { resource: byId[1] ?? '', n: Number(byId[2]), runId: subject };
  }
  const bySummary = /runs[\\/]([a-z][a-z0-9]*)[\\/](\d+)\.summary\.json$/.exec(subject);
  if (bySummary !== null) return { resource: bySummary[1] ?? '', n: Number(bySummary[2]) };
  throw new Error(`No run named by ${args.join(' ')}`);
}

/** Every record of an object, live and in the recycle bin, every field: what "unchanged" is held to. */
function snapshotOf(world: EnvWorld): string {
  const byId = (a: { Id: string }, b: { Id: string }) => a.Id.localeCompare(b.Id);
  return JSON.stringify(
    OBJECTS.map((object) => [
      object,
      [...world.org.all(object)].sort(byId),
      [...world.org.inBin(object)].sort(byId),
    ]),
  );
}

/** The org's own records: two accounts with a contact each, and an asset, made a day before. */
function ownRecords(world: EnvWorld): string[] {
  const own = (prefix: string, n: number) => `${prefix}${String(900_000 + n).padStart(12, '0')}AAA`;
  const at = orgStamp(T0 - DAY);
  const by = { CreatedById: OTHER_USER, LastModifiedById: OTHER_USER };
  const ids: string[] = [];
  for (const n of [1, 2]) {
    world.org.add('Account', { Id: own('001', n), Name: `Own account ${n}`, ...by }, at);
    world.org.add(
      'Contact',
      { Id: own('003', n), LastName: `Own contact ${n}`, AccountId: own('001', n), ...by },
      at,
    );
    ids.push(own('001', n), own('003', n));
  }
  world.org.add('Asset', { Id: own('02i', 1), Name: 'Own asset', ...by }, at);
  ids.push(own('02i', 1));
  return ids;
}

/** What a history holds itself to as it goes: each property its own. */
type Check = 'idempotent' | 'holds' | 'destroy' | 'once' | 'counts';

/** A history on its own memory org, with its own journal, state and project. */
class History {
  readonly world: EnvWorld;
  readonly store: EnvStore;
  spec: ResourceSpec[];
  readonly calls: Call[] = [];
  /** Each record a run wrote, by its id: the run, by its id, the resource, and the object. */
  readonly wrote = new Map<string, { runId: string; resource: string; object: ObjectName }>();
  /** Records others changed since a run wrote them. */
  readonly changed = new Set<string>();
  /** Records others deleted, with what their deletes took along. */
  readonly deleted = new Set<string>();
  /** Whether anyone but the environment touched its records. */
  drifted = false;
  /** What the org refuses of the next apply, until it has run. */
  refusing: { object: ObjectName; nth: number } | undefined;
  /** What the history did so far, for a failure to say. */
  readonly said: string[] = [];
  private readonly project: string;
  private readonly journalDir: string;
  private readonly locksDir: string;
  private readonly own: readonly string[];
  private readonly ownBefore: string;
  private hear: ((signal: StopSignal) => void) | undefined;
  private stop: StopPlan | undefined;
  private writing = 0;
  private reading = 0;
  /** Whether a stop fell during the verb last run. */
  stopped = false;

  constructor(
    root: string,
    spec: readonly ResourceSpec[],
    private readonly checks: ReadonlySet<Check>,
  ) {
    vi.setSystemTime(T0);
    this.spec = structuredClone([...spec]);
    this.project = join(root, 'project');
    this.journalDir = join(root, 'journal');
    this.locksDir = join(root, 'locks');
    mkdirSync(join(this.project, '.git'), { recursive: true });
    // Half a minute between two scripts, by the org's clock: past the leeway
    // a removal gives a run's end, so a change made after it reads as one.
    this.world = new EnvWorld({
      organizationId: ORG_ID,
      sandbox: true,
      scratch: true,
      tick: () => vi.setSystemTime(Date.now() + 30_000),
    });
    this.own = ownRecords(this.world);
    this.ownBefore = this.ownSnapshot();
    const opened = openEnvStore({ journalDir: this.journalDir, fileFolder: this.project });
    if (!('store' in opened)) throw new Error(opened.refusal);
    this.store = opened.store;
  }

  /** What the history did, as a failure says it. */
  message(): string {
    return `${JSON.stringify(this.spec)}\n${this.said.join('\n')}`;
  }

  private ownSnapshot(): string {
    return JSON.stringify(
      OBJECTS.flatMap((object) =>
        this.world.org.all(object).filter((row) => this.own.includes(row.Id)),
      ),
    );
  }

  isLive(id: string): boolean {
    const by = this.wrote.get(id);
    return by !== undefined && this.world.org.all(by.object).some((row) => row.Id === id);
  }

  /** The records of the environment the org holds. */
  liveRecords(): Array<[string, { runId: string; resource: string; object: ObjectName }]> {
    return [...this.wrote].filter(([id]) => this.isLive(id));
  }

  private liveIds(): Set<string> {
    return new Set(OBJECTS.flatMap((object) => this.world.org.all(object).map((row) => row.Id)));
  }

  /** The stop the line's verb is told of: SIGTERM, as a CI job is ended. */
  private fire(): void {
    if (this.hear === undefined) return;
    this.stopped = true;
    this.hear('SIGTERM');
  }

  /**
   * Whether what others did can keep an apply or a destroy from ending 0: a
   * record they changed is still there, which a removal keeps; or they
   * deleted an account, and a relation may find fewer parents, or none.
   */
  othersAtWork(): boolean {
    return (
      [...this.changed].some((id) => this.isLive(id)) ||
      [...this.deleted].some((id) => id.startsWith('001'))
    );
  }

  /** Runs each script as the command line's runner would, a stop falling where the history says. */
  private readonly runner: CommandRunner = async (script, args, signal) => {
    const kind = kindOf(args);
    const named = resourceRunOf(args);
    const run = `${(await this.state())?.lineage ?? 'none'}:${named.resource}:${named.n}`;
    const at = isWriting({ kind }) ? this.writing++ : -1;
    const readAt = isWriting({ kind }) ? -1 : this.reading++;
    const stop =
      this.stop !== undefined && this.stop.at === (this.stop.when === 'planning' ? readAt : at)
        ? this.stop
        : undefined;
    if (stop?.when === 'before' || stop?.when === 'planning') this.fire();
    if (signal.aborted) {
      // Spawned, then stopped at once: the script ends by the signal before
      // it reads the org, as the runner's SIGINT ends it.
      this.calls.push({ kind, run, code: 130 });
      return { code: 130, stdout: '', stderr: '' };
    }
    if (stop?.when === 'during') {
      let seen = 0;
      const firing = (): void => {
        if (seen++ === stop.record) this.fire();
      };
      if (kind === 'run') this.world.onCreate = firing;
      else this.world.org.beforeDelete = firing;
    }
    // What the runner sends the script once the verb is stopped: SIGINT,
    // which the script, in this process, hears as its own.
    const interrupt = (): void => {
      process.emit('SIGINT');
    };
    signal.addEventListener('abort', interrupt, { once: true });
    const before = this.liveIds();
    const snapshot = isWriting({ kind }) ? undefined : snapshotOf(this.world);
    let ran: Awaited<ReturnType<CommandRunner>>;
    try {
      ran = await this.world.runner(script, args, signal);
    } finally {
      signal.removeEventListener('abort', interrupt);
      this.world.onCreate = undefined;
      this.world.org.beforeDelete = undefined;
    }
    if (snapshot !== undefined) {
      expect(snapshotOf(this.world), `a ${kind} wrote to the org\n${this.message()}`).toBe(
        snapshot,
      );
    }
    if (kind === 'run') {
      for (const object of OBJECTS) {
        for (const row of this.world.org.all(object)) {
          if (!before.has(row.Id)) {
            this.wrote.set(row.Id, { runId: named.runId ?? '', resource: named.resource, object });
          }
        }
      }
    }
    this.calls.push({ kind, run, code: ran.code });
    if (stop?.when === 'after') this.fire();
    return ran;
  };

  /** Run a verb of the command line, its answer read as JSON, a stop falling where `stop` says. */
  async env(words: readonly string[], stop?: StopPlan): Promise<Answered> {
    process.env['SANDFORGE_JOURNAL_DIR'] = this.journalDir;
    writeFileSync(join(this.project, 'sandforge.yaml'), JSON.stringify(documentOf(this.spec)));
    this.stop = stop;
    this.writing = 0;
    this.reading = 0;
    this.stopped = false;
    const refusing = words[0] === 'apply' ? this.refusing : undefined;
    if (refusing !== undefined) {
      let sent = 0;
      this.world.refuseCreate = (object) =>
        object === refusing.object && sent++ === refusing.nth
          ? 'A validation rule refused it'
          : undefined;
    }
    try {
      const ran = await runInProcess(() =>
        envMain(['node', 'sandforge-env.ts', ...words, '--org', ALIAS, '--json'], {
          runner: this.runner,
          journalDir: this.journalDir,
          locksDir: this.locksDir,
          cwd: this.project,
          onStop: (hear) => {
            this.hear = hear;
            return () => {
              if (this.hear === hear) this.hear = undefined;
            };
          },
        }),
      );
      const answer: unknown = ran.stdout.trim() === '' ? undefined : JSON.parse(ran.stdout);
      this.said.push(`  → exit ${ran.code}`);
      return { code: ran.code, answer, said: ran.stderr };
    } finally {
      this.stop = undefined;
      this.hear = undefined;
      if (refusing !== undefined) {
        this.world.refuseCreate = undefined;
        this.refusing = undefined;
      }
    }
  }

  async state() {
    return this.store.read(ORG_ID, ENV);
  }

  /** What a run of the state took, by its run file and by the summary kept beside the state. */
  async idsOfRun(runId: string, summary: string | undefined): Promise<Set<string>> {
    const ids = new Set<string>();
    const kept = await nodeSeedRunCreations(this.journalDir).get(runId);
    for (const object of kept?.created ?? []) for (const id of object.ids) ids.add(id.slice(0, 15));
    if (summary !== undefined) {
      const file = this.store.fileOf(ORG_ID, ENV, summary);
      if (existsSync(file)) {
        for (const object of readSeedRun(readFileSync(file, 'utf8')).result.objectResults) {
          for (const id of object.createdIds) ids.add(id.slice(0, 15));
        }
      }
    }
    return ids;
  }

  /** Apply, as a CI step does. */
  apply(flags: readonly string[] = [], stop?: StopPlan): Promise<Answered> {
    return this.env(['apply', '--yes', ...flags], stop);
  }

  destroy(flags: readonly string[] = [], stop?: StopPlan): Promise<Answered> {
    return this.env(['destroy', '--yes', ...flags], stop);
  }

  /** Records of an object the org holds, by their name and their account's: the org's shape, ids aside. */
  shape(): Record<string, string[]> {
    const names = new Map(this.world.org.all('Account').map((row) => [row.Id, String(row.Name)]));
    return Object.fromEntries(
      OBJECTS.map((object) => [
        object,
        this.world.org
          .all(object)
          .map((row) => {
            const parent = typeof row['AccountId'] === 'string' ? row['AccountId'] : undefined;
            const under =
              parent === undefined ? '' : ` under ${names.get(parent) ?? 'an account gone'}`;
            return `${String(row[NAME_FIELD[object]])}${under}`;
          })
          .sort(),
      ]),
    );
  }

  /** Live records a run of the state names, per resource of the file and object. */
  async heldByCurrentRuns(): Promise<Record<string, Record<string, number>>> {
    const state = await this.state();
    const held: Record<string, Record<string, number>> = {};
    for (const resource of this.spec) {
      const current = state?.resources[resource.name]?.runs.at(-1);
      const ids =
        current?.runId !== undefined
          ? await this.idsOfRun(current.runId, current.summary)
          : new Set<string>();
      held[resource.name] = Object.fromEntries(
        OBJECTS.map((object) => [
          object,
          this.world.org.all(object).filter((row) => ids.has(row.Id.slice(0, 15))).length,
        ]),
      );
    }
    return held;
  }

  // ─── The steps of a history ────────────────────────────────────────────────

  async play(op: Op): Promise<void> {
    this.said.push(JSON.stringify(op));
    switch (op.op) {
      case 'edit': {
        const resource = this.spec[op.at % this.spec.length];
        const object = resource?.objects[op.object % resource.objects.length];
        if (object === undefined) return;
        const before = object.count;
        object.count = op.count;
        if (op.count === 0) {
          await this.refusedFile();
          object.count = before;
        }
        return;
      }
      case 'add': {
        const name = RESOURCE_NAMES.find((each) => !this.spec.some((r) => r.name === each));
        if (this.spec.length >= MAX_RESOURCES || name === undefined) return;
        this.spec.push(resourceOf(op.draft, name, this.spec));
        return;
      }
      case 'remove': {
        const resource = this.spec[op.at % this.spec.length];
        if (this.spec.length > 1 && resource !== undefined) {
          this.spec = without(this.spec, resource.name);
        }
        return;
      }
      case 'apply':
        await this.applied(op);
        return;
      case 'refuse':
        this.refusing = { object: op.object, nth: op.nth };
        return;
      case 'drift':
        this.driftBy(op);
        return;
      case 'destroy':
        await this.destroyed(op.stop);
        return;
    }
  }

  /** A file the schema refuses: the apply exits 2 before it reaches the org, and nothing moves. */
  private async refusedFile(): Promise<void> {
    const serial = (await this.state())?.serial;
    const org = snapshotOf(this.world);
    const from = this.calls.length;
    const ran = await this.apply();
    const message = this.message();
    expect(ran.code, message).toBe(2);
    expect(this.calls.length, message).toBe(from);
    expect(snapshotOf(this.world), message).toBe(org);
    expect((await this.state())?.serial, message).toBe(serial);
  }

  flagsOf(op: Extract<Op, { op: 'apply' }>): string[] {
    const replaced =
      op.replace !== undefined ? this.spec[op.replace % this.spec.length] : undefined;
    return [
      ...(replaced !== undefined ? ['--replace', replaced.name] : []),
      ...(op.replaceDrifted ? ['--replace-drifted'] : []),
    ];
  }

  private async applied(op: Extract<Op, { op: 'apply' }>): Promise<void> {
    const flags = this.flagsOf(op);
    let planned: EnvPlan | undefined;
    if (op.planFirst) {
      const plan = await this.env(['plan', ...flags]);
      expect(plan.code, this.message()).toBe(0);
      planned = envPlanSchema.parse(plan.answer);
    }
    const serial = (await this.state())?.serial;
    const org = snapshotOf(this.world);
    const refused = this.refusing !== undefined;
    const ran = await this.apply(flags, op.stop);
    const message = this.message();
    if (isStoppedPlanning(ran)) {
      // Stopped while it planned: nothing written, to the org or the state.
      expect(ran.code, message).toBe(143);
      expect(snapshotOf(this.world), message).toBe(org);
      expect((await this.state())?.serial, message).toBe(serial);
      return;
    }
    const result = envRunResultSchema.parse(ran.answer);
    if (this.checks.has('counts')) await this.planCountsHold(result, planned);
    if (this.checks.has('holds')) {
      await this.everyRecordTakenBackable();
      if (!this.othersAtWork() && !this.stopped && !refused) {
        expect(ran.code, `${message}\n${ran.said}`).toBe(0);
      }
      if (ran.code === 0) {
        await this.holdsTheFile();
        await this.driftIsSaid();
      }
    }
    if (ran.code === 0 && this.checks.has('idempotent')) {
      await this.appliedAgainChangesNothing(op.replaceDrifted ? ['--replace-drifted'] : []);
    }
  }

  private driftBy(op: Extract<Op, { op: 'drift' }>): void {
    const live = this.liveRecords().sort(([a], [b]) => a.localeCompare(b));
    if (live.length === 0) return;
    const picked = [
      live[op.pick % live.length],
      ...(op.two ? [live[(op.pick + 1) % live.length]] : []),
    ];
    const before = this.liveIds();
    for (const entry of picked) {
      if (entry === undefined) continue;
      const [id, by] = entry;
      if (!this.isLive(id)) continue;
      if (op.how === 'delete') {
        this.world.org.trash(by.object, id, OTHER_USER);
      } else {
        this.world.org.edit(by.object, id, { [NAME_FIELD[by.object]]: 'SFENV edited' }, OTHER_USER);
        this.changed.add(id);
      }
    }
    const after = this.liveIds();
    for (const id of before) if (!after.has(id)) this.deleted.add(id);
    this.drifted = true;
  }

  private async destroyed(stop?: StopPlan): Promise<number> {
    const ran = await this.destroy([], stop);
    if (isStopCode(ran.code)) return ran.code;
    if (this.checks.has('destroy')) await this.destroyLeavesNothingUnsaid(ran);
    return ran.code;
  }

  /** The end of every history: destroy, and once more with --include-changed if it left records. */
  async tornDown(): Promise<void> {
    this.said.push('destroy at the end');
    const code = await this.destroyed();
    if (code === 3) {
      this.said.push('destroy --include-changed');
      const again = await this.destroy(['--include-changed']);
      expect(again.code, this.message()).toBe(0);
      if (this.checks.has('destroy')) await this.destroyLeavesNothingUnsaid(again);
    }
  }

  // ─── What holds ────────────────────────────────────────────────────────────

  /** Applied twice is applied once: no script that writes, the serial and every record unmoved. */
  private async appliedAgainChangesNothing(flags: readonly string[]): Promise<void> {
    const serial = (await this.state())?.serial;
    const org = snapshotOf(this.world);
    const from = this.calls.length;
    this.said.push(`plan --fail-on-change, then apply ${flags.join(' ')}`);
    const planned = await this.env(['plan', '--fail-on-change', ...flags]);
    const again = await this.apply(flags);
    const message = this.message();
    expect(planned.code, message).toBe(0);
    expect(again.code, message).toBe(0);
    expect(this.calls.slice(from).filter(isWriting), message).toEqual([]);
    expect((await this.state())?.serial, message).toBe(serial);
    expect(snapshotOf(this.world), message).toBe(org);
  }

  /**
   * After an apply that ended 0, the org holds what the file describes, per
   * resource and object, minus what others deleted; and of the environment's
   * records, nothing but what others changed, and what those hang from.
   */
  private async holdsTheFile(): Promise<void> {
    const message = this.message();
    const state = await this.state();
    expect(state, message).toBeDefined();
    if (state === undefined) return;
    const current = new Set<string>();
    for (const resource of this.spec) {
      const kept = state.resources[resource.name];
      expect(kept?.status, `${resource.name}\n${message}`).toBe('applied');
      const run = kept?.runs.at(-1);
      expect(run?.takenBack, message).toBeUndefined();
      if (run?.runId === undefined) throw new Error(`${resource.name} has no run id\n${message}`);
      current.add(run.runId);
      const ids = await this.idsOfRun(run.runId, run.summary);
      // A count read by the run's own ids: an object it should not have
      // written shows here, as a count the file does not give.
      for (const object of OBJECTS) {
        const ofRun = [...this.wrote].filter(
          ([id, by]) => by.object === object && ids.has(id.slice(0, 15)),
        );
        const live = ofRun.filter(([id]) => this.isLive(id)).length;
        const gone = ofRun.filter(([id]) => this.deleted.has(id)).length;
        const spec = resource.objects.find((each) => each.object === object);
        const expected = spec === undefined ? 0 : expectedCount(this.spec, resource, spec);
        // Contacts drawn from another resource's accounts count what that
        // one holds once others deleted or renamed some of it.
        const drawsFromAnother =
          resource.parents !== undefined && resource.parents.from !== resource.name;
        if (!(this.drifted && drawsFromAnother && object === 'Contact')) {
          expect(live + gone, `${resource.name} ${object}\n${message}`).toBe(expected);
        } else {
          expect(live, `${resource.name} ${object}\n${message}`).toBeLessThanOrEqual(
            spec?.count ?? 0,
          );
        }
      }
    }
    for (const [name, kept] of Object.entries(state.resources)) {
      if (!this.spec.some((resource) => resource.name === name)) {
        expect(kept.status, `${name}, out of the file\n${message}`).toBe('destroyed');
      }
    }
    const left = this.liveRecords().filter(([, by]) => !current.has(by.runId));
    const allowed = new Set([...this.changed].filter((id) => this.isLive(id)));
    for (const id of [...allowed]) {
      const row = this.world.org.all('Contact').find((each) => each.Id === id);
      if (typeof row?.['AccountId'] === 'string') allowed.add(row['AccountId']);
    }
    expect(
      left.filter(([id]) => !allowed.has(id)),
      `records of earlier runs left\n${message}`,
    ).toEqual([]);
  }

  /**
   * `plan --fail-on-drift` exits 3 exactly when records of a run the state
   * still holds, of a resource not taken back, were deleted or changed by
   * someone else.
   */
  private async driftIsSaid(): Promise<void> {
    const state = await this.state();
    const held = new Set(
      Object.values(state?.resources ?? {})
        .filter((resource) => resource.status !== 'destroyed')
        .flatMap((resource) =>
          resource.runs.filter((run) => run.takenBack !== true).map((run) => run.runId ?? ''),
        ),
    );
    const touched = [...this.wrote].filter(
      ([id, by]) => held.has(by.runId) && (this.deleted.has(id) || this.changed.has(id)),
    );
    this.said.push('plan --fail-on-drift');
    const planned = await this.env(['plan', '--fail-on-drift']);
    expect(planned.code, `others touched ${JSON.stringify(touched)}\n${this.message()}`).toBe(
      touched.length > 0 ? 3 : 0,
    );
  }

  /** Every record a run wrote is named by what the state takes the run back from. */
  private async everyRecordTakenBackable(): Promise<void> {
    const state = await this.state();
    const runs = new Map(
      Object.values(state?.resources ?? {}).flatMap((resource) =>
        resource.runs.map((run) => [run.runId ?? '', run] as const),
      ),
    );
    for (const [id, by] of this.liveRecords()) {
      const run = runs.get(by.runId);
      const message = `${id} of ${by.resource}, run ${by.runId}\n${this.message()}`;
      expect(run, `the state names no run that wrote ${message}`).toBeDefined();
      if (run === undefined) continue;
      const ids = await this.idsOfRun(by.runId, run.summary);
      expect(ids.has(id.slice(0, 15)), `no removal can reach ${message}`).toBe(true);
    }
  }

  /**
   * What a plan says each resource would write is what the apply wrote,
   * counted by the records the org took as its run went; the most it writes
   * where the plan says "at most".
   */
  private async planCountsHold(result: EnvRunResult, planned: EnvPlan | undefined): Promise<void> {
    const message = this.message();
    if (planned !== undefined && result.refusal === undefined) {
      const counts = (plan: EnvPlan) =>
        plan.actions.map((action) => ({
          resource: action.resource,
          action: action.action,
          wouldCreate: action.objects.map((o) => [o.object, o.wouldCreate, o.atMost === true]),
        }));
      expect(counts(result.plan), `the plan, then the apply's own\n${message}`).toEqual(
        counts(planned),
      );
    }
    const state = await this.state();
    for (const action of result.plan.actions) {
      if (action.action !== 'create' && action.action !== 'replace') continue;
      const step = result.steps.find((s) => s.resource === action.resource && s.phase === 'run');
      if (step === undefined || step.exitCode !== 0) continue;
      const runId = state?.resources[action.resource]?.runs.find((r) => r.n === step.run)?.runId;
      for (const object of OBJECTS) {
        const counted = action.objects.find((each) => each.object === object);
        const said = step.objects.find((each) => each.object === object)?.created ?? 0;
        const took = [...this.wrote.values()].filter(
          (by) => by.runId === runId && by.object === object,
        ).length;
        const where = `${action.resource} ${object}: planned ${JSON.stringify(counted)}, written ${took}\n${message}`;
        expect(said, `what the run said it wrote, and what the org took: ${where}`).toBe(took);
        if (counted?.atMost === true) {
          expect(took, where).toBeLessThanOrEqual(counted.wouldCreate ?? 0);
        } else {
          expect(took, where).toBe(counted?.wouldCreate ?? 0);
        }
      }
    }
  }

  /**
   * After destroy: the org's own records as they were; and either nothing of
   * the environment and no state, or exit 3, the state kept, and per object
   * exactly what is left named as kept.
   */
  private async destroyLeavesNothingUnsaid(ran: Answered): Promise<void> {
    const message = `${this.message()}\n${ran.said}`;
    expect(this.ownSnapshot(), `the org's own records\n${message}`).toBe(this.ownBefore);
    const left = this.liveRecords();
    if (![...this.changed].some((id) => this.isLive(id))) expect(ran.code, message).toBe(0);
    if (ran.code === 0) {
      expect(left, message).toEqual([]);
      expect(await this.state(), message).toBeUndefined();
      return;
    }
    expect(ran.code, message).toBe(3);
    expect(await this.state(), message).toBeDefined();
    const result = envRunResultSchema.parse(ran.answer);
    const named: Record<string, number> = {};
    for (const step of result.steps) {
      for (const object of step.objects) {
        if (object.kept > 0) named[object.object] = (named[object.object] ?? 0) + object.kept;
      }
    }
    const counted: Record<string, number> = {};
    for (const [, by] of left) counted[by.object] = (counted[by.object] ?? 0) + 1;
    expect(named, `what destroy said it left, and what it left\n${message}`).toEqual(counted);
  }

  /** No run a removal took back whole is taken back, or read, again. */
  takesEachRunBackOnce(): void {
    const whole = new Set<string>();
    for (const call of this.calls) {
      if (call.kind !== 'remove' && call.kind !== 'preview') continue;
      expect(
        whole.has(call.run),
        `${call.kind} of ${call.run} once taken back\n${this.message()}`,
      ).toBe(false);
      if (call.kind === 'remove' && call.code === 0) whole.add(call.run);
    }
  }
}

// ─── The properties ──────────────────────────────────────────────────────────

let root: string;
let journalBefore: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  root = mkdtempSync(join(tmpdir(), 'sandforge-env-props-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
});

afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A folder of its own for each history a property runs. */
let histories = 0;
const folder = (): string => {
  histories += 1;
  return join(root, String(histories));
};

/** Where an apply left a history: its exit, the org's shape, what each run holds, each status. */
async function endOf(history: History, ran: Answered) {
  return {
    code: ran.code,
    shape: history.shape(),
    held: await history.heldByCurrentRuns(),
    statuses: Object.fromEntries(
      Object.entries((await history.state())?.resources ?? {}).map(([name, resource]) => [
        name,
        resource.status,
      ]),
    ),
  };
}

/** The apply every history ends with: what was edited last is applied too. */
const LAST_APPLY: Op = {
  op: 'apply',
  replace: undefined,
  replaceDrifted: false,
  planFirst: false,
  stop: undefined,
};

/** Play a history from a file, then destroy, holding it to `checks` as it goes. */
async function played(
  file: readonly ResourceSpec[],
  ops: readonly Op[],
  checks: readonly Check[],
): Promise<History> {
  const history = new History(folder(), file, new Set(checks));
  for (const op of ops) await history.play(op);
  await history.play(LAST_APPLY);
  await history.tornDown();
  return history;
}

/** A property over random files and histories, each held to `checks`. */
async function overHistories(checks: readonly Check[], end?: (h: History) => void): Promise<void> {
  await fc.assert(
    fc.asyncProperty(fileArb, historyArb, async (file, ops) => {
      const history = await played(file, ops, checks);
      end?.(history);
    }),
    { numRuns: RUNS, seed: SEED, endOnFailure: true },
  );
}

describe('an environment on the memory org, over random files and histories', () => {
  it(
    'applied twice is applied once: after an apply that ends 0, plan --fail-on-change ends 0, and the second apply spawns no script that writes and leaves the serial and every record as they were',
    () => overHistories(['idempotent']),
    paced(60_000),
  );

  it(
    'after an apply that ends 0, the org holds what the file describes, per resource and object, counted by the ids of the runs the state names, nothing else of the environment but what others changed, and plan --fail-on-drift says exactly whether others touched it',
    () => overHistories(['holds']),
    paced(60_000),
  );

  it(
    'destroy leaves no record of the environment and the org’s own records as they were, and deletes the state, or exits 3 naming per object exactly what it left',
    () => overHistories(['destroy']),
    paced(60_000),
  );

  it(
    'takes back no run twice, and reads none again once a removal took it back whole',
    () => overHistories(['once'], (history) => history.takesEachRunBackOnce()),
    paced(60_000),
  );

  it(
    'writes what its plan counted: for each resource it runs, the records created are the plan’s, object by object',
    () => overHistories(['counts']),
    paced(60_000),
  );

  it(
    'stopped before, during or after any script it spawns, then applied again, ends where an apply never stopped ends',
    async () => {
      await fc.assert(
        fc.asyncProperty(fileArb, quietHistoryArb, applyArb(stopArb), async (file, ops, last) => {
          if (last.op !== 'apply' || last.stop === undefined) return;
          // One history at a time: the world a history runs its scripts
          // against is the last one made. The one never stopped first, to
          // place the stop among the scripts its apply spawns.
          const whole = new History(folder(), file, new Set());
          for (const op of ops) await whole.play(op);
          // A refusal the history left for the next apply would fall on the
          // stopped one alone, and on the whole one.
          whole.refusing = undefined;
          const flags = whole.flagsOf(last);
          const from = whole.calls.length;
          const once = await endOf(whole, await whole.apply(flags));
          const spawned = whole.calls.slice(from);
          await whole.tornDown();
          const writing = spawned.filter(isWriting).length;
          const among = last.stop.when === 'planning' ? spawned.length - writing : writing;
          if (among === 0) return;
          const stop = { ...last.stop, at: last.stop.at % among };

          const stopped = new History(folder(), file, new Set());
          for (const op of ops) await stopped.play(op);
          stopped.refusing = undefined;
          stopped.said.push(`${JSON.stringify({ ...last, stop })}, then applied again`);
          let ran = await stopped.apply(flags, stop);
          for (let again = 0; again < 3 && isStopCode(ran.code); again++) {
            ran = await stopped.apply(flags);
          }
          const ended = await endOf(stopped, ran);
          const message = stopped.message();
          await stopped.tornDown();

          expect(ended, message).toEqual(once);
        }),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
    },
    paced(60_000),
  );
});
