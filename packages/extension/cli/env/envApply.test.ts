import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvState } from '@sandforge/shared';

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

import { acquireOrgLock } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import type { CommandRunner } from '../scriptRunner.js';
import { EnvWorld, dryRunsIn, previewsIn } from '../testing/envWorld.js';
import { applyPlan, applySteps, runResultLines, type EnvStepDeps } from './envApply.js';
import { readEnvFile, type EnvFileResolved } from './envFile.js';
import type { EnvTarget } from './envGuards.js';
import { acquireEnvLock } from './envLock.js';
import { classifyResources, envPlan, type EnvDryRun, type EnvPlanInput } from './envPlan.js';
import { openEnvStore, type EnvStore } from './envState.js';

/*
 * Applying a plan on the memory org: each step runs `sandforge-seed`'s own
 * `main` in this process, its records written there, its summary kept beside
 * the state, its exit code read by the table the apply ends each step by.
 */

const ORG_ID = '00D000000000009AAA';
const OTHER_USER = '005000000000009AAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const TARGET: EnvTarget = {
  alias: 'TGT',
  organizationId: ORG_ID,
  kind: 'developer',
  username: 'test-user@example.com',
};
const BUDGET = {
  apiRequests: { remaining: 14_000, max: 15_000 },
  storage: { remainingMB: 5, maxMB: 5 },
  emails: {},
};

interface Over {
  accounts?: number;
  /** Records each REST call of the contacts sends: 1 lets a test stop between two. */
  contactsBatch?: number;
  assets?: { recordTypes?: string[] };
}

/** Assets alone, then accounts, then contacts drawn from them. */
function document(over: Over = {}) {
  const named = (field: string, value: string) => [
    { fieldApiName: field, ruleType: 'static', config: { staticValue: value } },
  ];
  return {
    version: 1,
    name: 'case-flow',
    resources: {
      assets: {
        kind: 'seed',
        seed: 3,
        objects: [
          {
            object: 'Asset',
            count: 1,
            fields: named('Name', 'SFENV asset'),
            ...(over.assets?.recordTypes !== undefined
              ? { recordTypes: over.assets.recordTypes }
              : {}),
          },
        ],
      },
      accounts: {
        kind: 'seed',
        seed: 1,
        objects: [
          { object: 'Account', count: over.accounts ?? 2, fields: named('Name', 'SFENV account') },
        ],
      },
      contacts: {
        kind: 'seed',
        seed: 2,
        dependsOn: ['accounts'],
        objects: [
          {
            object: 'Contact',
            count: 2,
            fields: named('LastName', 'SFENV contact'),
            ...(over.contactsBatch !== undefined ? { batchSize: over.contactsBatch } : {}),
          },
        ],
        relations: [
          {
            lookup: 'Contact.AccountId',
            parents: { object: 'Account', existing: { where: "Name = 'SFENV account'", limit: 2 } },
            distribution: { mode: 'perParent', count: 1 },
          },
        ],
      },
    },
  };
}

let dir: string;
let journalDir: string;
let fileFolder: string;
let locksDir: string;
let journalBefore: string | undefined;
let world: EnvWorld;
let store: EnvStore;
let said: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-apply-'));
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  fileFolder = join(dir, 'project');
  mkdirSync(join(fileFolder, '.git'), { recursive: true });
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  // Half a minute between two scripts, by the org's clock: past the leeway a
  // removal gives a run's end, so a change made after an apply reads as one.
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: false,
    edition: 'Developer Edition',
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  const opened = openEnvStore({ journalDir, fileFolder });
  if (!('store' in opened)) throw new Error(opened.refusal);
  store = opened.store;
  said = [];
});

afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function resolvedOf(doc: unknown = document()): EnvFileResolved {
  const read = readEnvFile(doc, fileFolder, {});
  if ('refusals' in read) throw new Error(JSON.stringify(read.refusals));
  return read.resolved;
}

const place = () => ({ store, journalDir, dir, alias: 'TGT' });

function deps(over: Partial<EnvStepDeps> = {}): EnvStepDeps {
  return {
    runner: world.runner,
    store,
    locksDir,
    journalDir,
    orgNow: async () => new Date().toISOString(),
    say: (line) => said.push(line),
    sandforgeVersion: '1.68.0',
    onStop: () => () => undefined,
    ...over,
  };
}

/** The plan as the command line reads it, with the dry runs it read. */
async function planned(
  resolved: EnvFileResolved,
  over: Partial<EnvPlanInput> = {},
): Promise<{
  plan: ReturnType<typeof envPlan>;
  dryRuns: Record<string, EnvDryRun>;
  state?: EnvState;
}> {
  const state = await store.read(ORG_ID, 'case-flow');
  const previews = await previewsIn(world, place(), state);
  const drafts = classifyResources({ resolved, state, previews, ...over });
  const dryRuns =
    over.dryRuns ??
    (await dryRunsIn(
      world,
      place(),
      resolved,
      drafts.filter((d) => d.action === 'create' || d.action === 'replace').map((d) => d.resource),
    ));
  const plan = envPlan({
    resolved,
    org: { organizationId: ORG_ID, kind: 'developer', alias: 'TGT' },
    state,
    previews,
    dryRuns,
    budget: BUDGET,
    ...over,
  });
  return { plan, dryRuns, ...(state !== undefined ? { state } : {}) };
}

/** Plan, then apply, as `apply --yes` does. */
async function apply(
  resolved: EnvFileResolved = resolvedOf(),
  over: Partial<EnvPlanInput> = {},
  stepDeps: Partial<EnvStepDeps> = {},
) {
  const { plan, dryRuns, state } = await planned(resolved, over);
  return applyPlan(deps(stepDeps), {
    plan,
    resolved,
    target: TARGET,
    state,
    dryRuns: over.dryRuns ?? dryRuns,
    acceptAutomation: false,
  });
}

/** The scripts' lines since `from`: runs, previews and removals as `run`, `preview`, `remove`. */
function linesSince(from: number): string[] {
  return world.calls.slice(from).map((call) => {
    const file = call.args[call.args.indexOf('--template-file') + 1] ?? '';
    const named = /templates\/([a-z-]+)\.\d+\.json$/.exec(file)?.[1];
    if (call.args.includes('--preview')) return 'preview';
    if (call.args.includes('--remove')) {
      const subject = call.args[call.args.indexOf('--remove') + 1] ?? '';
      return `remove ${/runs\/([a-z-]+)\//.exec(subject)?.[1] ?? /env-case-flow-([a-z]+)-/.exec(subject)?.[1] ?? subject}`;
    }
    if (call.args.includes('--dry-run')) return 'dry-run';
    return `run ${named ?? '?'}`;
  });
}

const runsSince = (from: number) =>
  linesSince(from).filter((line) => line.startsWith('run ') || line.startsWith('remove '));

describe('applying a plan', () => {
  it('writes ahead: before the seed is spawned, the state names its run, applying, on disk', async () => {
    const seen: Array<{ status?: string; runId?: string; spawned?: string }> = [];
    const watching: CommandRunner = async (script, args, signal) => {
      const runId = args[args.indexOf('--run-id') + 1];
      if (!args.includes('--dry-run') && !args.includes('--remove')) {
        const onDisk = JSON.parse(
          readFileSync(join(store.folderOf(ORG_ID, 'case-flow'), 'state.json'), 'utf8'),
        ) as EnvState;
        const name = Object.entries(onDisk.resources).find(([, r]) =>
          r.runs.some((run) => run.runId === runId),
        );
        seen.push({
          status: name?.[1].status,
          runId: name?.[1].runs.at(-1)?.runId,
          spawned: runId,
        });
      }
      return world.runner(script, args, signal);
    };

    const outcome = await apply(resolvedOf(), {}, { runner: watching });

    expect(outcome.exitCode).toBe(0);
    expect(seen).toHaveLength(3);
    for (const step of seen) {
      expect(step.status).toBe('applying');
      expect(step.runId).toBe(step.spawned);
    }
  });

  it('runs each resource after what it depends on, holds it to its dry run, and keeps each summary', async () => {
    const from = world.calls.length;

    const outcome = await apply();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.status).toBe('success');
    expect(runsSince(from)).toEqual(['run assets', 'run accounts', 'run contacts']);
    expect(
      outcome.result.steps.map((s) => [s.resource, s.phase, s.run, s.exitCode, s.status]),
    ).toEqual([
      ['assets', 'run', 1, 0, 'applied'],
      ['accounts', 'run', 1, 0, 'applied'],
      ['contacts', 'run', 1, 0, 'applied'],
    ]);
    const state = await store.read(ORG_ID, 'case-flow');
    expect(state?.resources['accounts']).toMatchObject({
      status: 'applied',
      runs: [
        {
          n: 1,
          runId: expect.stringMatching(/^env-case-flow-accounts-1-/),
          summary: 'runs/accounts/1.summary.json',
          seed: 1,
          exitCode: 0,
          objects: [{ objectApiName: 'Account', created: 2, refused: 0 }],
        },
      ],
    });
    expect(existsSync(store.fileOf(ORG_ID, 'case-flow', 'runs/accounts/1.summary.json'))).toBe(
      true,
    );
    expect(
      world
        .records('Contact')
        .map((c) => c['AccountId'])
        .sort(),
    ).toEqual(
      world
        .records('Account')
        .map((a) => a['Id'])
        .sort(),
    );
  });

  it('applied twice is applied once: the second spawns no script that writes, and leaves the serial', async () => {
    await apply();
    const serial = (await store.read(ORG_ID, 'case-flow'))?.serial;
    const counts = ['Asset', 'Account', 'Contact'].map((o) => world.records(o).length);
    const from = world.calls.length;

    const again = await apply();

    expect(again.exitCode).toBe(0);
    expect(again.result.steps).toEqual([]);
    expect(again.result.plan.actions.map((a) => a.action)).toEqual(['keep', 'keep', 'keep']);
    expect(linesSince(from).every((line) => line === 'preview')).toBe(true);
    expect((await store.read(ORG_ID, 'case-flow'))?.serial).toBe(serial);
    expect(['Asset', 'Account', 'Contact'].map((o) => world.records(o).length)).toEqual(counts);
    expect(said).toContain('nothing to do: the org holds the environment as the file describes it');
  });

  it('gives each record type of a resource to the seed through --record-type, by DeveloperName', async () => {
    const outcome = await apply(resolvedOf(document({ assets: { recordTypes: ['Hardware'] } })));

    expect(outcome.exitCode).toBe(0);
    const run = world.calls.find(
      (call) => call.args.includes('--record-type') && !call.args.includes('--dry-run'),
    );
    expect(
      run?.args.slice(run.args.indexOf('--record-type'), run.args.indexOf('--record-type') + 2),
    ).toEqual(['--record-type', 'Asset=Hardware']);
    expect(world.records('Asset').map((a) => a['RecordTypeId'])).toEqual(['012000000000010AAA']);
  });
});

describe('how a step ends, and what the apply then does', () => {
  it('0 short of what its dry run counted: partial, the others go on, what depends on it is skipped, exit 3', async () => {
    const resolved = resolvedOf();
    const { dryRuns } = await planned(resolved);
    const accounts = dryRuns['accounts'];
    if (accounts === undefined || !('answer' in accounts)) throw new Error('no dry run');
    accounts.answer.result.totalRecordsCreated = 5;

    const outcome = await apply(resolved, { dryRuns });

    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.status).toBe('partial');
    expect(outcome.result.steps.map((s) => [s.resource, s.status])).toEqual([
      ['assets', 'applied'],
      ['accounts', 'partial'],
    ]);
    expect(outcome.result.steps[1]?.objects[0]?.reason).toBe(
      'it created 2 record(s) of the 5 its dry run counted',
    );
    expect(outcome.result.skipped).toEqual([
      { resource: 'contacts', why: 'it depends on accounts (partial)' },
    ]);
    expect(world.records('Contact')).toEqual([]);
  });

  it('3, records refused: partial, its run kept, what depends on it skipped, exit 3', async () => {
    let sent = 0;
    // The first account the run sends is refused, the second taken.
    world.refuseCreate = (object) =>
      object === 'Account' && sent++ === 0 ? 'A validation rule refused it' : undefined;

    const outcome = await apply();

    expect(outcome.exitCode).toBe(3);
    const accounts = outcome.result.steps.find((s) => s.resource === 'accounts');
    expect(accounts).toMatchObject({ exitCode: 3, status: 'partial' });
    expect(accounts?.objects[0]).toMatchObject({ created: 1, refused: 1 });
    expect(outcome.result.skipped?.map((s) => s.resource)).toEqual(['contacts']);
    expect((await store.read(ORG_ID, 'case-flow'))?.resources['accounts']?.status).toBe('partial');
  });

  it('1 before anything was written: failed, the apply stops there, exit 1', async () => {
    world.refuseCreate = () => 'A validation rule refused it';
    const from = world.calls.length;

    const outcome = await apply();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.status).toBe('failure');
    expect(outcome.result.steps.map((s) => [s.resource, s.exitCode, s.status])).toEqual([
      ['assets', 1, 'failed'],
    ]);
    expect(runsSince(from)).toEqual(['run assets']);
  });

  it('1 once another step wrote: failed, the apply stops, and is partial, exit 3', async () => {
    world.refuseCreate = (object) => (object === 'Account' ? 'Refused' : undefined);

    const outcome = await apply();

    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.steps.map((s) => [s.resource, s.exitCode, s.status])).toEqual([
      ['assets', 0, 'applied'],
      ['accounts', 1, 'failed'],
    ]);
    expect(world.records('Contact')).toEqual([]);
  });

  it('2, a line the seed refuses: failed, the apply stops before writing, exit 1', async () => {
    // What a run refuses its line for, its dry run refuses first: the plan
    // blocks it. A run refusing a line its dry run took stops the apply.
    const refusing: CommandRunner = async (script, args, signal) =>
      !args.includes('--dry-run') && !args.includes('--remove')
        ? {
            code: 2,
            stdout: '',
            stderr: '--record-type Asset=Nope: Asset has no record type Nope.\n',
          }
        : world.runner(script, args, signal);

    const outcome = await apply(resolvedOf(), {}, { runner: refusing });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.steps.map((s) => [s.resource, s.exitCode, s.status])).toEqual([
      ['assets', 2, 'failed'],
    ]);
    expect(world.records('Asset')).toEqual([]);
  });

  it('blocks a resource whose dry run did not answer, and the apply with it, before any write', async () => {
    const resolved = resolvedOf(document({ assets: { recordTypes: ['Nope'] } }));
    const from = world.calls.length;

    const outcome = await apply(resolved);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.plan.actions[0]).toMatchObject({
      resource: 'assets',
      action: 'blocked',
      refusal: expect.stringContaining(
        'its dry run did not answer: exit 2: --record-type Asset=Nope: Asset has no record type Nope',
      ),
    });
    expect(runsSince(from)).toEqual([]);
    expect(world.records('Asset')).toEqual([]);
  });

  it('a script that cannot be started once another wrote: the apply stops, partial, naming what it did not run', async () => {
    const failing: CommandRunner = async (script, args, signal) => {
      const real = !args.includes('--dry-run') && !args.includes('--remove');
      if (real && args.join(' ').includes('templates/accounts')) throw new Error('spawn EAGAIN');
      return world.runner(script, args, signal);
    };

    const outcome = await apply(resolvedOf(), {}, { runner: failing });

    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.steps.map((s) => [s.resource, s.status])).toEqual([
      ['assets', 'applied'],
    ]);
    expect(outcome.result.skipped).toEqual([
      { resource: 'contacts', why: 'the apply stopped on an error: spawn EAGAIN' },
    ]);
    expect((await store.read(ORG_ID, 'case-flow'))?.resources['accounts']?.status).toBe('applying');
  });

  it('4, unstable: partial, the apply stops, exit 4', async () => {
    const unstable: CommandRunner = async (script, args, signal) => {
      const ran = await world.runner(script, args, signal);
      const real = !args.includes('--dry-run') && !args.includes('--remove');
      return real && args.join(' ').includes('accounts') ? { ...ran, code: 4 } : ran;
    };

    const outcome = await apply(resolvedOf(), {}, { runner: unstable });

    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.steps.map((s) => [s.resource, s.status])).toEqual([
      ['assets', 'applied'],
      ['accounts', 'partial'],
    ]);
  });
});

describe('a stopped apply', () => {
  it('keeps the resource applying with its stopped run, says the stop, and exits as the signal', async () => {
    let stopped = false;
    world.onCreate = (object) => {
      if (object === 'Contact' && !stopped) {
        stopped = true;
        process.emit('SIGTERM');
      }
    };

    const outcome = await apply(
      resolvedOf(document({ contactsBatch: 1 })),
      {},
      { onStop: undefined },
    );

    expect(outcome.exitCode).toBe(143);
    expect(outcome.result.status).toBe('cancelled');
    expect(said.join('\n')).toContain('stopped by SIGTERM');
    const state = await store.read(ORG_ID, 'case-flow');
    expect(state?.resources['contacts']).toMatchObject({
      status: 'applying',
      runs: [{ n: 1, exitCode: 143 }],
    });
    expect(world.records('Contact')).toHaveLength(1);
  });

  it('replaces the stopped resource from what its run kept on the next apply, and ends as one apply would', async () => {
    let stopped = false;
    world.onCreate = (object) => {
      if (object === 'Contact' && !stopped) {
        stopped = true;
        process.emit('SIGTERM');
      }
    };
    const resolved = resolvedOf(document({ contactsBatch: 1 }));
    await apply(resolved, {}, { onStop: undefined });
    world.onCreate = undefined;
    const from = world.calls.length;

    const again = await apply(resolved);

    expect(again.exitCode).toBe(0);
    expect(again.result.plan.actions.map((a) => [a.resource, a.action])).toEqual([
      ['assets', 'keep'],
      ['accounts', 'keep'],
      ['contacts', 'replace'],
    ]);
    expect(runsSince(from)).toEqual(['remove contacts', 'run contacts']);
    expect(world.records('Contact')).toHaveLength(2);
    const state = await store.read(ORG_ID, 'case-flow');
    expect(state?.resources['contacts']).toMatchObject({
      status: 'applied',
      runs: [{ n: 1 }, { n: 2, exitCode: 0 }],
    });
  });

  it('a stop between two steps starts none after it', async () => {
    let stop: ((signal: 'SIGINT') => void) | undefined;
    const outcome = await apply(
      resolvedOf(),
      {},
      {
        onStop: (hear) => {
          stop = hear;
          return () => undefined;
        },
        orgNow: async () => {
          if (world.records('Asset').length > 0) stop?.('SIGINT');
          return new Date().toISOString();
        },
      },
    );

    expect(outcome.exitCode).toBe(130);
    expect(outcome.result.skipped?.map((s) => s.resource)).toEqual(['accounts', 'contacts']);
  });
});

describe('replacing', () => {
  it('takes back the last applied first, then runs in order, for a resource --replace names and what depends on it', async () => {
    await apply();
    const ids = world.records('Account').map((a) => a['Id']);
    const from = world.calls.length;

    const outcome = await apply(resolvedOf(), { replace: ['accounts'] });

    expect(outcome.exitCode).toBe(0);
    expect(applySteps(outcome.result.plan, undefined).length).toBeGreaterThan(0);
    expect(runsSince(from)).toEqual([
      'remove contacts',
      'remove accounts',
      'run accounts',
      'run contacts',
    ]);
    expect(world.records('Account')).toHaveLength(2);
    expect(world.records('Account').map((a) => a['Id'])).not.toEqual(ids);
    expect(world.records('Contact')).toHaveLength(2);
    expect(world.records('Asset')).toHaveLength(1);
  });

  it('takes a run back once: a later replace leaves alone the runs an earlier one took back whole', async () => {
    // Each replace took back every earlier run again, a script started and
    // the org read for each: four empty removals before the fifth run.
    await apply();
    await apply(resolvedOf(), { replace: ['accounts'] });
    const from = world.calls.length;

    const outcome = await apply(resolvedOf(), { replace: ['accounts'] });

    expect(outcome.exitCode).toBe(0);
    expect(runsSince(from)).toEqual([
      'remove contacts',
      'remove accounts',
      'run accounts',
      'run contacts',
    ]);
    const kept = (await store.read(ORG_ID, 'case-flow'))?.resources['accounts']?.runs ?? [];
    expect(kept.map((run) => [run.n, run.takenBack === true])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it('replaces what --replace-drifted asks, naming the changed records the removal keeps, exit 3', async () => {
    await apply();
    const [account] = world.records('Account');
    world.org.edit('Account', String(account?.['Id']), { Name: 'Renamed' }, OTHER_USER);

    const outcome = await apply(resolvedOf(), { replaceDrifted: true });

    expect(outcome.exitCode).toBe(3);
    const removal = outcome.result.steps.find(
      (s) => s.resource === 'accounts' && s.phase === 'remove',
    );
    expect(removal).toMatchObject({ exitCode: 3, status: 'partial' });
    expect(removal?.objects[0]).toMatchObject({ deleted: 1, kept: 1 });
    expect(removal?.objects[0]?.reason).toContain('1 changed since the run, kept');
    expect(
      world
        .records('Account')
        .map((a) => a['Name'])
        .sort(),
    ).toEqual(['Renamed', 'SFENV account', 'SFENV account']);
  });

  it('takes back what the file no longer names, and keeps the rest', async () => {
    await apply();
    const doc = document();
    delete (doc.resources as Record<string, unknown>)['assets'];

    const outcome = await apply(resolvedOf(doc));

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.steps.map((s) => [s.resource, s.phase, s.status])).toEqual([
      ['assets', 'remove', 'destroyed'],
    ]);
    expect(world.records('Asset')).toEqual([]);
    expect((await store.read(ORG_ID, 'case-flow'))?.resources['assets']?.status).toBe('destroyed');
  });
});

describe('refused before its first step', () => {
  it('writes nothing when the plan refuses', async () => {
    const resolved = resolvedOf();
    const { plan, dryRuns } = await planned(resolved, { refusal: 'No state, no flag.' });
    const from = world.calls.length;

    const outcome = await applyPlan(deps(), {
      plan,
      resolved,
      target: TARGET,
      state: undefined,
      dryRuns,
      acceptAutomation: false,
    });

    expect(outcome).toMatchObject({ exitCode: 1, result: { refusal: 'No state, no flag.' } });
    expect(world.calls.length).toBe(from);
    expect(await store.read(ORG_ID, 'case-flow')).toBeUndefined();
  });

  it('refuses while another apply holds the org, naming it', async () => {
    const held = acquireEnvLock(locksDir, ORG_ID, { operation: 'destroy', env: 'case-flow' });
    if (!('lock' in held)) throw new Error('not taken');
    try {
      const outcome = await apply();

      expect(outcome.exitCode).toBe(1);
      expect(outcome.result.refusal).toContain(
        'a destroy of case-flow is under way on this machine',
      );
      expect(world.records('Asset')).toEqual([]);
    } finally {
      held.lock.release();
    }
  });

  it('refuses a state that moved since the plan, another apply having run', async () => {
    const resolved = resolvedOf();
    const { plan, dryRuns } = await planned(resolved);
    await apply(resolved);

    const outcome = await applyPlan(deps(), {
      plan,
      resolved,
      target: TARGET,
      state: undefined,
      dryRuns,
      acceptAutomation: false,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.refusal).toContain('changed since the plan');
  });

  it('starts no step while a checkpoint act of the org runs', async () => {
    const held = acquireOrgLock(locksDir, ORG_ID, { operation: 'rewind' });
    if (!('lock' in held)) throw new Error('not taken');
    try {
      const outcome = await apply();

      expect(outcome.exitCode).toBe(1);
      expect(said.join('\n')).toContain('A checkpoint rewind of this org is under way');
      expect(world.records('Asset')).toEqual([]);
    } finally {
      held.lock.release();
    }
  });
});

describe('what an apply says', () => {
  it('names each step, what it created, and what it did not run', async () => {
    const resolved = resolvedOf();
    const { dryRuns } = await planned(resolved);
    const accounts = dryRuns['accounts'];
    if (accounts !== undefined && 'answer' in accounts)
      accounts.answer.result.totalRecordsCreated = 5;

    const outcome = await apply(resolved, { dryRuns });

    expect(runResultLines(outcome.result, 'apply')).toEqual([
      '',
      '  assets run 1: exit 0, applied  Asset 1 created',
      '  accounts run 1: exit 0, partial  Account 2 created',
      '      Account: it created 2 record(s) of the 5 its dry run counted',
      '  contacts: not run, it depends on accounts (partial)',
      `apply: partial; state serial ${outcome.result.state.serial}`,
    ]);
  });
});
