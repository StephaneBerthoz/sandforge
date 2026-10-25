import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EnvActionKind, EnvPlan, EnvState } from '@sandforge/shared';

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

import { EnvWorld, dryRunsIn, previewsIn } from '../testing/envWorld.js';
import { applyPlan, type EnvStepDeps } from './envApply.js';
import { readEnvFile, type EnvFileResolved } from './envFile.js';
import {
  classifyResources,
  dependencyOrder,
  destructionPlan,
  envPlan,
  planChanges,
  planDrifts,
  planLines,
  removalOrder,
  type EnvBudget,
  type EnvDryRun,
  type EnvPlanInput,
  type EnvRefreshed,
  type EnvRunPreview,
} from './envPlan.js';
import { newEnvState, openEnvStore, runStarted, stepEnded, type EnvStore } from './envState.js';
import type { SeedDryRunAnswer } from './kinds/seed.js';

/*
 * The plan, on the memory org: every action a plan gives, each from what the
 * seed itself prints — its dry run, and the preview of each run's removal —
 * after an apply wrote the records there and the org changed as each case
 * says. The plan is a pure function of what it is given: what is read here
 * through the seed is what the command line reads through it.
 */

const ORG_ID = '00D000000000009AAA';
const OTHER_USER = '005000000000009AAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

/** Accounts, then contacts drawn from them: two resources, one depending on the other. */
function document(over: { accounts?: number; contacts?: false; checkpoint?: unknown } = {}) {
  return {
    version: 1,
    name: 'case-flow',
    ...(over.checkpoint !== undefined ? { checkpoint: over.checkpoint } : {}),
    resources: {
      accounts: {
        kind: 'seed',
        seed: 1,
        objects: [
          {
            object: 'Account',
            count: over.accounts ?? 2,
            fields: [
              {
                fieldApiName: 'Name',
                ruleType: 'static',
                config: { staticValue: 'SFENV account' },
              },
            ],
          },
        ],
      },
      ...(over.contacts === false
        ? {}
        : {
            contacts: {
              kind: 'seed',
              seed: 2,
              dependsOn: ['accounts'],
              objects: [
                {
                  object: 'Contact',
                  count: 2,
                  fields: [
                    {
                      fieldApiName: 'LastName',
                      ruleType: 'static',
                      config: { staticValue: 'SFENV contact' },
                    },
                  ],
                },
              ],
              relations: [
                {
                  lookup: 'Contact.AccountId',
                  parents: {
                    object: 'Account',
                    existing: { where: "Name = 'SFENV account'", limit: 2 },
                  },
                  distribution: { mode: 'perParent', count: 1 },
                },
              ],
            },
          }),
    },
  };
}

let dir: string;
let journalDir: string;
let fileFolder: string;
let journalBefore: string | undefined;
let world: EnvWorld;
let store: EnvStore;

/** A Developer Edition's day, as `/limits` said it: what the plan's gates are held to. */
const BUDGET: EnvBudget = {
  apiRequests: { remaining: 14_000, max: 15_000 },
  storage: { remainingMB: 5, maxMB: 5 },
  emails: { SingleEmail: { remaining: 15, max: 15 } },
};

const ORG = { organizationId: ORG_ID, kind: 'developer' as const, alias: 'TGT' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-plan-'));
  journalDir = join(dir, 'journal');
  fileFolder = join(dir, 'project');
  mkdirSync(join(fileFolder, '.git'), { recursive: true });
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  // Each script runs half a minute after the one before, by the org's clock:
  // what an apply wrote is dated before anything a case changes after it, past
  // the ten seconds of leeway a removal gives a run's end.
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: false,
    edition: 'Developer Edition',
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  const opened = openEnvStore({ journalDir, fileFolder });
  if (!('store' in opened)) throw new Error(opened.refusal);
  store = opened.store;
});

afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function resolvedOf(doc: unknown): EnvFileResolved {
  const read = readEnvFile(doc, fileFolder, {});
  if ('refusals' in read) throw new Error(JSON.stringify(read.refusals));
  return read.resolved;
}

const place = () => ({ store, journalDir, dir, alias: 'TGT' });

/** Each named resource dry-run through the seed, as the command line does. */
const dryRunsOf = (
  resolved: EnvFileResolved,
  names: readonly string[],
): Promise<Record<string, EnvDryRun>> => dryRunsIn(world, place(), resolved, names);

/** Each run of each resource the state holds, previewed through the seed. */
const previewsOf = (state: EnvState | undefined): Promise<Record<string, EnvRunPreview[]>> =>
  previewsIn(world, place(), state);

/** The whole plan, read as the command line reads it. */
async function planOf(
  resolved: EnvFileResolved,
  state: EnvState | undefined,
  over: Partial<EnvPlanInput> = {},
): Promise<EnvPlan> {
  const previews = over.previews ?? (await previewsOf(state));
  const drafts = classifyResources({ resolved, state, previews, ...over });
  const dryRuns =
    over.dryRuns ??
    (await dryRunsOf(
      resolved,
      drafts.filter((d) => d.action === 'create' || d.action === 'replace').map((d) => d.resource),
    ));
  return envPlan({ resolved, org: ORG, state, previews, dryRuns, budget: BUDGET, ...over });
}

const deps = (): EnvStepDeps => ({
  runner: world.runner,
  store,
  locksDir: join(dir, 'locks'),
  journalDir,
  orgNow: async () => new Date().toISOString(),
  say: () => undefined,
  sandforgeVersion: '1.68.0',
  onStop: () => () => undefined,
});

/** The file applied to the memory org, as an apply does it: the state it left. */
async function applied(resolved: EnvFileResolved = resolvedOf(document())): Promise<EnvState> {
  const plan = await planOf(resolved, undefined);
  const dryRuns = await dryRunsOf(resolved, ['accounts', 'contacts']);
  const outcome = await applyPlan(deps(), {
    plan,
    resolved,
    target: { alias: 'TGT', organizationId: ORG_ID, kind: 'developer', username: 'u' },
    state: undefined,
    dryRuns,
    acceptAutomation: false,
  });
  if (outcome.exitCode !== 0) throw new Error(JSON.stringify(outcome.result));
  const state = await store.read(ORG_ID, 'case-flow');
  if (state === undefined) throw new Error('no state');
  return state;
}

/** The state with a resource's status set, as a step that ended so would leave it. */
async function withStatus(
  state: EnvState,
  resource: string,
  status: EnvState['resources'][string]['status'],
): Promise<EnvState> {
  return store.update(state, (s) => stepEnded(s, { resource, status }));
}

type Expected = Array<[resource: string, action: EnvActionKind, why: string | RegExp]>;

/** What a plan says of each resource: its action, and why. */
function actionsOf(plan: EnvPlan): Array<[string, EnvActionKind, string]> {
  return plan.actions.map((action) => [
    action.resource,
    action.action,
    `${action.why}${action.refusal !== undefined ? ` | ${action.refusal}` : ''}`,
  ]);
}

function expectActions(plan: EnvPlan, expected: Expected): void {
  expect(plan.actions.map((a) => [a.resource, a.action])).toEqual(
    expected.map(([resource, action]) => [resource, action]),
  );
  for (const [index, [, , why]] of expected.entries()) {
    const said = actionsOf(plan)[index]?.[2] ?? '';
    if (typeof why === 'string') expect(said).toContain(why);
    else expect(said).toMatch(why);
  }
}

/** A dry run's answer with the emails it counts set to `emails` for SingleEmail. */
function sending(answer: SeedDryRunAnswer, emails: number): SeedDryRunAnswer {
  return {
    ...answer,
    emails: {
      checks: [{ limit: 'SingleEmail', emails, verdict: 'fits', remaining: 15, max: 15 }],
    },
  };
}

/** One case of the table: the org and the state as it arranges them, and what the plan says. */
interface PlanCase {
  name: string;
  arrange: () => Promise<{
    resolved: EnvFileResolved;
    state?: EnvState;
    over?: Partial<EnvPlanInput>;
  }>;
  expected: Expected;
}

const CASES: PlanCase[] = [
  {
    name: 'creates what the state holds none of',
    arrange: async () => ({ resolved: resolvedOf(document()) }),
    expected: [
      ['accounts', 'create', 'not applied to this org yet'],
      ['contacts', 'create', 'not applied to this org yet'],
    ],
  },
  {
    name: 'keeps what the org holds as written, from the same fingerprint',
    arrange: async () => ({ resolved: resolvedOf(document()), state: await applied() }),
    expected: [
      ['accounts', 'keep', 'applied, and the org holds its 2 record(s) as written'],
      ['contacts', 'keep', 'applied, and the org holds its 2 record(s) as written'],
    ],
  },
  {
    name: 'replaces what the file changed, and what depends on it',
    arrange: async () => {
      const state = await applied();
      return { resolved: resolvedOf(document({ accounts: 3 })), state };
    },
    expected: [
      ['accounts', 'replace', 'replaced: what it writes changed in the file since it was applied'],
      ['contacts', 'replace', 'the resources it depends on run again, with new records: accounts'],
    ],
  },
  {
    name: 'replaces a resource whose run was stopped part way, from its run file',
    arrange: async () => {
      const state = await withStatus(await applied(), 'contacts', 'applying');
      return { resolved: resolvedOf(document()), state };
    },
    expected: [
      ['accounts', 'keep', 'as written'],
      ['contacts', 'replace', 'its last run was stopped part way'],
    ],
  },
  {
    name: 'replaces a resource whose last run was partial, or failed',
    arrange: async () => {
      let state = await withStatus(await applied(), 'accounts', 'partial');
      state = await withStatus(state, 'contacts', 'failed');
      return { resolved: resolvedOf(document()), state };
    },
    expected: [
      ['accounts', 'replace', 'its last run was partial'],
      ['contacts', 'replace', /its last run failed; the resources it depends on run again/],
    ],
  },
  {
    name: 'replaces what --replace names, and leaves the rest',
    arrange: async () => ({
      resolved: resolvedOf(document()),
      state: await applied(),
      over: { replace: ['contacts'] },
    }),
    expected: [
      ['accounts', 'keep', 'as written'],
      ['contacts', 'replace', 'replaced: --replace asks it'],
    ],
  },
  {
    name: 'calls drifted a resource whose records are gone since, and leaves it',
    arrange: async () => {
      const state = await applied();
      const [contact] = world.records('Contact');
      world.org.trash('Contact', String(contact?.['Id']), OTHER_USER);
      return { resolved: resolvedOf(document()), state };
    },
    expected: [
      ['accounts', 'keep', 'as written'],
      [
        'contacts',
        'drifted',
        /its records changed since it was applied: Contact 1 gone.*--replace contacts or --replace-drifted replaces it/,
      ],
    ],
  },
  {
    name: 'calls drifted a resource whose records someone changed since, naming who',
    arrange: async () => {
      const state = await applied();
      const [account] = world.records('Account');
      world.org.edit('Account', String(account?.['Id']), { Name: 'Renamed' }, OTHER_USER);
      return { resolved: resolvedOf(document()), state };
    },
    expected: [
      ['accounts', 'drifted', `Account 1 changed (last changed by ${OTHER_USER} 1)`],
      ['contacts', 'keep', 'as written'],
    ],
  },
  {
    name: 'replaces a drifted resource when --replace-drifted asks, and what depends on it',
    arrange: async () => {
      const state = await applied();
      const [account] = world.records('Account');
      world.org.edit('Account', String(account?.['Id']), { Name: 'Renamed' }, OTHER_USER);
      return { resolved: resolvedOf(document()), state, over: { replaceDrifted: true } };
    },
    expected: [
      ['accounts', 'replace', 'its records drifted (Account 1 changed'],
      ['contacts', 'replace', 'the resources it depends on run again'],
    ],
  },
  {
    name: 'deletes what the state holds and the file no longer names, listed first',
    arrange: async () => ({
      resolved: resolvedOf(document({ contacts: false })),
      state: await applied(),
    }),
    expected: [
      ['contacts', 'delete', 'in the state, gone from the file: its records are taken back'],
      ['accounts', 'keep', 'as written'],
    ],
  },
  {
    name: 'creates again what a destroy took back',
    arrange: async () => {
      let state = await withStatus(await applied(), 'contacts', 'destroyed');
      state = await withStatus(state, 'accounts', 'destroyed');
      return { resolved: resolvedOf(document()), state };
    },
    expected: [
      ['accounts', 'create', 'taken back by an earlier destroy: applied again'],
      ['contacts', 'create', 'taken back by an earlier destroy: applied again'],
    ],
  },
  {
    name: 'blocks a replace whose removal a preview says would be refused now',
    arrange: async () => {
      const state = await applied();
      const previews = await previewsOf(state);
      const run = previews['accounts']?.[0];
      if (run === undefined || !('preview' in run)) throw new Error('no preview');
      run.preview.refusals.push('TGT runs a flow as accounts are deleted: --accept-automation.');
      return {
        resolved: resolvedOf(document({ accounts: 3 })),
        state,
        over: { previews },
      };
    },
    expected: [
      [
        'accounts',
        'blocked',
        'a removal of its runs would be refused now: TGT runs a flow as accounts are deleted',
      ],
      ['contacts', 'replace', 'the resources it depends on run again'],
    ],
  },
  {
    name: 'blocks a resource its own dry run says a real run would be refused for',
    arrange: async () => {
      const resolved = resolvedOf(document());
      world = new EnvWorld({
        organizationId: ORG_ID,
        limits: { DataStorageMB: { Max: 5, Remaining: 0 } },
      });
      return { resolved };
    },
    expected: [
      ['accounts', 'blocked', /its own dry run says a real run would be refused: .*data storage/],
      ['contacts', 'blocked', /its own dry run says a real run would be refused/],
    ],
  },
  {
    name: 'blocks every write when the API requests summed pass what the org has left, each alone fitting',
    arrange: async () => ({
      resolved: resolvedOf(document()),
      over: { budget: { ...BUDGET, apiRequests: { remaining: 1, max: 15_000 } } },
    }),
    expected: [
      ['accounts', 'blocked', /take about 2 API requests, and TGT has 1 left today/],
      ['contacts', 'blocked', /take about 2 API requests/],
    ],
  },
  {
    name: 'blocks every write when the storage summed passes what the org has left, each alone fitting',
    arrange: async () => ({
      resolved: resolvedOf(document()),
      // 6 KB left: each resource's 4 KB fits, the two do not.
      over: { budget: { ...BUDGET, storage: { remainingMB: 6 / 1024, maxMB: 5 } } },
    }),
    expected: [
      ['accounts', 'blocked', /take about 0\.01 MB of data storage, and TGT has 0\.01 MB left/],
      ['contacts', 'blocked', /of data storage/],
    ],
  },
  {
    name: 'blocks every write when the emails summed pass the day’s, each alone fitting',
    arrange: async () => {
      const resolved = resolvedOf(document());
      const dry = await dryRunsOf(resolved, ['accounts', 'contacts']);
      const dryRuns = Object.fromEntries(
        Object.entries(dry).map(([name, run]) => [
          name,
          'answer' in run && run.answer.tool === 'sandforge-seed'
            ? { answer: sending(run.answer, 10) }
            : run,
        ]),
      );
      return { resolved, over: { dryRuns } };
    },
    expected: [
      ['accounts', 'blocked', /make TGT send 20 SingleEmail emails, and it has 15 left today/],
      ['contacts', 'blocked', /SingleEmail/],
    ],
  },
];

describe('the plan, on the memory org', () => {
  // One test per row of the table, each named in full.
  for (const { name, arrange, expected } of CASES) {
    it(name, async () => {
      const { resolved, state, over } = await arrange();

      const plan = await planOf(resolved, state, over);

      expectActions(plan, expected);
      expect(plan.totals[expected[0]?.[1] ?? 'keep']).toBeGreaterThan(0);
    });
  }

  it('says a resource replaced because what it depends on runs again changed nothing of its own in the file', async () => {
    // A fingerprint is chained through what it depends on: the contacts read
    // "what it writes changed in the file" when only the accounts' count had.
    const state = await applied();
    const plan = await planOf(resolvedOf(document({ accounts: 3 })), state);
    const contacts = plan.actions.find((action) => action.resource === 'contacts');

    expect(contacts?.action).toBe('replace');
    expect(contacts?.why).toContain(
      'the resources it depends on run again, with new records: accounts',
    );
    expect(contacts?.why).not.toContain('what it writes changed in the file');

    // Its own count changed as well: both are said.
    const both = document({ accounts: 3 }) as {
      resources: { contacts: { objects: Array<{ count: number }> } };
    };
    const firstObject = both.resources.contacts.objects[0];
    if (firstObject) firstObject.count = 3;
    const again = await planOf(resolvedOf(both), state);
    const changed = again.actions.find((action) => action.resource === 'contacts');
    expect(changed?.why).toContain('what it writes changed in the file since it was applied');
    expect(changed?.why).toContain('the resources it depends on run again');
  });

  it('counts per object what a create would write, what the org holds of a kept resource, and the gates', async () => {
    const created = await planOf(resolvedOf(document()), undefined);
    expect(created.actions[0]).toMatchObject({
      objects: [{ object: 'Account', wouldCreate: 2 }],
      gates: { apiRequests: 1, storageBytes: 4_096, emails: [] },
    });
    // The contacts draw their accounts from what the accounts resource writes
    // first: their dry run, which read the org before, counted none of them,
    // and the plan said "Contact 0 to write" of a run that writes two. The
    // file's count stands in, as the most the run writes.
    expect(created.actions[1]).toMatchObject({
      objects: [{ object: 'Contact', wouldCreate: 2, atMost: true }],
      why:
        'not applied to this org yet; its dry run read the org before accounts writes: what it ' +
        'draws from those records is counted at most as the file gives it',
    });
    expect(created.gates).toEqual({
      apiRequests: {
        estimate: 2,
        leftToday: 14_000,
        partial: true,
        notCounted: ['what contacts draws from the records accounts writes first'],
      },
      storage: { bytes: 8_192, left: 5 * 1_048_576 },
      emails: [],
    });
    expect(created.refusal).toBeUndefined();

    const kept = await planOf(resolvedOf(document()), await applied());
    expect(kept.actions[1]).toMatchObject({
      objects: [{ object: 'Contact', present: 2, gone: 0, changed: 0 }],
    });
    expect(kept.state).toEqual({ found: true, serial: expect.any(Number) });
    expect(planChanges(kept)).toBe(false);
    expect(planDrifts(kept)).toBe(false);
  });

  /** The plan of a file, then its apply: what each resource's run created, object by object. */
  async function plannedThenWritten(doc: unknown) {
    const resolved = resolvedOf(doc);
    const plan = await planOf(resolved, undefined);
    const outcome = await applyPlan(deps(), {
      plan,
      resolved,
      target: { alias: 'TGT', organizationId: ORG_ID, kind: 'developer', username: 'u' },
      state: undefined,
      dryRuns: await dryRunsOf(
        resolved,
        resolved.resources.map((resource) => resource.name),
      ),
      acceptAutomation: false,
    });
    const written = (resource: string) =>
      outcome.result.steps
        .find((step) => step.resource === resource && step.phase === 'run')
        ?.objects.map((object) => [object.object, object.created]);
    return { plan, outcome, written };
  }

  it('counts by its dry run what a resource writes under its own records, though it runs after what it depends on', async () => {
    // A resource that depends on another running first had every object
    // counted as the file gave it: six contacts said, of which the seed
    // writes two, one under each of the two accounts the resource writes.
    const doc = document({ contacts: false }) as { resources: Record<string, unknown> };
    const named = (field: string) => [
      { fieldApiName: field, ruleType: 'static', config: { staticValue: 'SFENV family' } },
    ];
    doc.resources['family'] = {
      kind: 'seed',
      seed: 3,
      dependsOn: ['accounts'],
      objects: [
        { object: 'Account', count: 2, fields: named('Name') },
        { object: 'Contact', count: 6, fields: named('LastName') },
      ],
      relations: [
        {
          lookup: 'Contact.AccountId',
          parents: { object: 'Account' },
          distribution: { mode: 'perParent', count: 1 },
        },
      ],
    };

    const { plan, outcome, written } = await plannedThenWritten(doc);

    const family = plan.actions.find((action) => action.resource === 'family');
    expect(family?.objects).toEqual([
      { object: 'Account', wouldCreate: 2 },
      { object: 'Contact', wouldCreate: 2 },
    ]);
    expect(family?.why).toBe('not applied to this org yet');
    expect(outcome.exitCode).toBe(0);
    expect(written('family')).toEqual([
      ['Account', 2],
      ['Contact', 2],
    ]);
  });

  it('counts at most as the file gives them the records a resource draws from what runs before it, and says so', async () => {
    // Six contacts, one per account, drawn from the two accounts the other
    // resource writes first: the plan said "Contact 6 to write" of a run that
    // wrote two. What the dry run could not read, the plan cannot count: the
    // file's count is the most the run writes.
    const doc = document() as {
      resources: { contacts: { objects: Array<{ count: number }>; relations: unknown[] } };
    };
    const contacts = doc.resources.contacts;
    const first = contacts.objects[0];
    if (first) first.count = 6;
    contacts.relations = [
      {
        lookup: 'Contact.AccountId',
        parents: { object: 'Account', existing: { where: "Name = 'SFENV account'", limit: 6 } },
        distribution: { mode: 'perParent', count: 1 },
      },
    ];

    const { plan, outcome, written } = await plannedThenWritten(doc);

    const action = plan.actions.find((each) => each.resource === 'contacts');
    expect(action?.objects).toEqual([{ object: 'Contact', wouldCreate: 6, atMost: true }]);
    expect(action?.why).toBe(
      'not applied to this org yet; its dry run read the org before accounts writes: what it ' +
        'draws from those records is counted at most as the file gives it',
    );
    expect(planLines(plan)).toContain('  create   contacts  Contact at most 6 to write');
    expect(outcome.exitCode).toBe(0);
    expect(written('contacts')).toEqual([['Contact', 2]]);
  });

  it('with --quick, reads no preview and no dry run, keeps from the state alone and says so', async () => {
    const state = await applied();
    const calls = world.calls.length;

    const plan = envPlan({ resolved: resolvedOf(document({ accounts: 3 })), org: ORG, state });

    expect(world.calls.length).toBe(calls);
    expect(plan.quick).toBe(true);
    expect(plan.actions.map((a) => [a.resource, a.action])).toEqual([
      ['accounts', 'replace'],
      ['contacts', 'replace'],
    ]);
    const unchanged = envPlan({ resolved: resolvedOf(document()), org: ORG, state });
    expect(unchanged.actions[0]?.why).toBe(
      'applied from the same file; what the org holds of it was not read (--quick)',
    );
    expect(plan.gates.apiRequests).toMatchObject({
      estimate: 0,
      partial: true,
      unread: 'not read: --quick',
    });
    expect(plan.gates.apiRequests.notCounted).toContain('the run of accounts, not dry-run');
  });

  it('refuses the whole apply for what a guard says, and for a checkpoint the checkpoint script refuses', async () => {
    const guarded = await planOf(resolvedOf(document()), undefined, {
      refusal: 'This machine keeps no state of case-flow on TGT.',
    });
    expect(guarded.refusal).toBe('This machine keeps no state of case-flow on TGT.');

    const refusal = { code: 'PERMISSIONS', message: 'Modify All Data is missing.' };
    const checkpointed = await planOf(
      resolvedOf(document({ checkpoint: { before: true } })),
      undefined,
      { checkpointEstimate: { refusal } },
    );
    expect(checkpointed.checkpoints).toEqual([
      { step: 'before', name: 'case-flow before', refusal },
    ]);
    expect(checkpointed.refusal).toBe(
      "The checkpoint the file asks before the first write, 'case-flow before', would be " +
        'refused: Modify All Data is missing. Take checkpoint.before or checkpoint.after out of ' +
        'the file, or fix what refuses it.',
    );
    // Its actions stay what they are: the apply refuses before its first write.
    expect(checkpointed.actions.map((a) => a.action)).toEqual(['create', 'create']);
  });

  it('adds each checkpoint’s estimate to the day’s requests, and says one it could not estimate', async () => {
    const estimate = { records: 40, apiRequests: 12, seconds: 3, bytes: 2_048 };
    const resolved = resolvedOf(document({ checkpoint: { before: true, after: 'baseline' } }));
    const plain = await planOf(resolvedOf(document()), undefined);
    const both = await planOf(resolved, undefined, { checkpointEstimate: { estimate } });

    expect(both.checkpoints?.map((c) => [c.step, c.name])).toEqual([
      ['before', 'case-flow before'],
      ['after', 'baseline'],
    ]);
    expect(both.gates.apiRequests.estimate).toBe(plain.gates.apiRequests.estimate + 24);
    expect(planLines(both)).toContain(
      "checkpoint before the first write: 'case-flow before', about 40 records, 12 API requests, 3 s, 0.01 MB on this machine",
    );
    const unread = await planOf(resolved, undefined, {
      checkpointEstimate: { unread: 'exit 1: no answer' },
    });
    expect(unread.gates.apiRequests.notCounted).toEqual(
      expect.arrayContaining([
        'the checkpoint before the first write, not estimated',
        'the checkpoint once applied, not estimated',
      ]),
    );
    // A plan made with --quick reads no estimate, and says so.
    const quick = envPlan({ resolved, org: ORG, state: undefined });
    expect(quick.checkpoints?.[0]?.unread).toBe('not read: --quick');
  });

  it('holds the whole org to the checkpoint after the last apply for --fail-on-drift, an unread comparison included', async () => {
    const state = await applied();
    const kept = await planOf(resolvedOf(document()), state, {
      drift: { checkpoint: 'ck-20261025-090000-a1b2', differs: false },
    });
    const differs = await planOf(resolvedOf(document()), state, {
      drift: { checkpoint: 'ck-20261025-090000-a1b2', differs: true, toDelete: 1 },
    });
    const unread = await planOf(resolvedOf(document()), state, {
      drift: { checkpoint: 'ck-20261025-090000-a1b2', differs: false, unread: 'PERMISSIONS' },
    });

    expect(planDrifts(kept)).toBe(false);
    expect(planDrifts(differs)).toBe(true);
    expect(planDrifts(unread)).toBe(true);
    expect(planLines(unread)).toContain(
      'the whole org against the checkpoint after the last apply (ck-20261025-090000-a1b2): not compared, PERMISSIONS',
    );
  });

  it('says drift and changes for --fail-on-drift and --fail-on-change', async () => {
    const state = await applied();
    const [contact] = world.records('Contact');
    world.org.trash('Contact', String(contact?.['Id']), OTHER_USER);

    const plan = await planOf(resolvedOf(document()), state);

    expect(planDrifts(plan)).toBe(true);
    expect(planChanges(plan)).toBe(false);
    const changed = await planOf(resolvedOf(document({ accounts: 3 })), state);
    expect(planChanges(changed)).toBe(true);
  });

  it('prints each action with why, the totals, the gates and the refusal a real apply would meet', async () => {
    const plan = await planOf(resolvedOf(document()), undefined, {
      budget: { ...BUDGET, apiRequests: { remaining: 1, max: 15_000 } },
    });

    const lines = planLines(plan);

    expect(lines[0]).toBe(`plan of case-flow on TGT (developer, ${ORG_ID})`);
    expect(lines).toContain('state: none on this machine');
    expect(lines).toContain('  blocked  accounts  Account 2 to write');
    expect(lines).toContain(
      'totals: 0 to create, 0 to replace, 0 to delete, 0 kept, 0 drifted, 2 blocked',
    );
    expect(lines).toContain(
      'API requests: about 2, 1 left; not counted: what contacts draws from the records ' +
        'accounts writes first',
    );
    expect(lines.at(-1)).toMatch(/^an apply now would be refused: The resources the plan writes/);
  });
});

describe('the order', () => {
  it('runs each resource after what it depends on, ties in the order given', () => {
    const deps: Record<string, string[]> = { contacts: ['accounts'], cases: ['contacts'] };

    // At each turn, the first given whose dependencies are placed.
    expect(
      dependencyOrder(['cases', 'contacts', 'accounts', 'assets'], (n) => deps[n] ?? []),
    ).toEqual(['accounts', 'contacts', 'cases', 'assets']);
    expect(dependencyOrder(['assets', 'contacts', 'accounts'], (n) => deps[n] ?? [])).toEqual([
      'assets',
      'accounts',
      'contacts',
    ]);
  });

  it('takes runs back the last applied first, by what each depended on when it was applied', async () => {
    const state = await applied();

    expect(removalOrder(state, ['accounts', 'contacts'])).toEqual(['contacts', 'accounts']);
    expect(removalOrder(state, ['contacts', 'accounts'])).toEqual(['contacts', 'accounts']);
  });
});

describe('the plan of a destroy', () => {
  it('takes back every resource the state holds, the last applied first, each with what the org holds', async () => {
    const state = await applied();

    const plan = destructionPlan({
      resolved: resolvedOf(document()),
      org: ORG,
      state,
      previews: await previewsOf(state),
    });

    expect(plan.actions.map((a) => [a.resource, a.action])).toEqual([
      ['contacts', 'delete'],
      ['accounts', 'delete'],
    ]);
    expect(plan.actions[0]?.objects).toEqual([
      { object: 'Contact', present: 2, gone: 0, changed: 0 },
    ]);
    expect(plan.totals.delete).toBe(2);
    expect(plan.refusal).toBeUndefined();
  });

  it('is refused as a whole when a removal would be refused now, before its first delete', async () => {
    const state = await applied();
    const previews = await previewsOf(state);
    const run = previews['accounts']?.[0];
    if (run === undefined || !('preview' in run)) throw new Error('no preview');
    run.preview.refusals.push('TGT runs a flow as accounts are deleted.');

    const plan = destructionPlan({ resolved: resolvedOf(document()), org: ORG, state, previews });

    expect(plan.actions.map((a) => a.action)).toEqual(['delete', 'blocked']);
    expect(plan.refusal).toBe(
      'accounts: a removal of its runs would be refused now: TGT runs a flow as accounts are ' +
        'deleted. Nothing was deleted.',
    );
  });
});

describe('the plan of a forge resource', () => {
  /** A file cloning marked accounts from the uat role. */
  const forgeDocument = {
    version: 1,
    name: 'case-flow',
    orgs: { uat: { alias: 'SRC' } },
    resources: {
      cloned: {
        kind: 'forge',
        source: 'uat',
        tables: [{ object: 'Account', where: "Name = 'SFENV'" }],
      },
    },
  };

  /** The file, its source read as `read` says, or not read at all. */
  function forgeResolved(read?: { organizationId: string } | { refusal: string }): EnvFileResolved {
    const result = readEnvFile(
      forgeDocument,
      fileFolder,
      {},
      read !== undefined ? { sources: { cloned: read } } : {},
    );
    if ('refusals' in result) throw new Error(JSON.stringify(result.refusals));
    return result.resolved;
  }

  /** A clone's dry run that counts two accounts, `wouldBeRefused` what it says a real run would meet. */
  function dryRunOf(wouldBeRefused?: string[]): EnvDryRun {
    return {
      answer: {
        tool: 'sandforge-clone',
        version: 1,
        dryRun: true,
        result: { wouldInsertCount: 2, failedCount: 0 },
        writePlan: {
          totalRows: 2,
          storageBytes: 4096,
          objects: [{ objectApiName: 'Account', rows: 2, storageBytes: 4096 }],
        },
        ...(wouldBeRefused !== undefined ? { wouldBeRefused } : {}),
      },
    };
  }

  const planWith = (resolved: EnvFileResolved, dryRuns: Record<string, EnvDryRun> = {}) =>
    envPlan({ resolved, org: ORG, state: undefined, previews: {}, dryRuns, budget: BUDGET });

  it('blocks a resource whose source the plan did not read, or could not, before any dry run', () => {
    const unread = planWith(forgeResolved());
    const refused = planWith(
      forgeResolved({ refusal: 'the uat org (SRC) could not be reached: expired' }),
    );

    expect(unread.actions[0]).toMatchObject({
      kind: 'forge',
      action: 'blocked',
      refusal: 'its source, the uat org, was not read: plan again',
    });
    expect(refused.actions[0]?.refusal).toBe('the uat org (SRC) could not be reached: expired');
  });

  it('counts what its dry run’s gate counts, and leaves its requests out of the sum, saying so', () => {
    const plan = planWith(forgeResolved({ organizationId: '00D000000000008AAA' }), {
      cloned: dryRunOf(),
    });

    expect(plan.actions[0]).toMatchObject({
      action: 'create',
      objects: [{ object: 'Account', wouldCreate: 2 }],
      gates: { storageBytes: 4096, emails: [] },
    });
    expect(plan.actions[0]?.gates).not.toHaveProperty('apiRequests');
    expect(plan.gates.apiRequests).toMatchObject({
      estimate: 0,
      partial: true,
      notCounted: ['the requests of the run of cloned, which its script does not estimate'],
    });
    expect(plan.gates.storage.bytes).toBe(4096);
  });

  it('blocks a resource its own dry run says a real run would be refused, in the clone’s words', () => {
    const plan = planWith(forgeResolved({ organizationId: '00D000000000008AAA' }), {
      cloned: dryRunOf(['The run would write 2 records, more than --max-total 1.']),
    });

    expect(plan.actions[0]).toMatchObject({
      action: 'blocked',
      refusal:
        'its own dry run says a real run would be refused: The run would write 2 records, more than --max-total 1.',
    });
  });
});

describe('the plan of a frozen resource', () => {
  const DIGEST = `sha256:${'c'.repeat(64)}`;
  /** A file loading the claims dataset, from a folder outside the project. */
  const frozenDocument = {
    version: 1,
    name: 'case-flow',
    resources: {
      claims: {
        kind: 'frozen',
        config: 'claims.frozen.json',
        dataset: { path: '/data/claims', version: '1.0.0', digest: DIGEST },
      },
    },
  };

  /** The file, its dataset read as `read` says, or not read at all. */
  function frozenResolved(
    read?: { digest: string; version: string } | { refusal: string },
  ): EnvFileResolved {
    writeFileSync(
      join(fileFolder, 'claims.frozen.json'),
      JSON.stringify({ rootObject: 'Account', axes: [], edgeCases: [] }),
    );
    const result = readEnvFile(
      frozenDocument,
      fileFolder,
      {},
      read !== undefined ? { datasets: { claims: read } } : {},
    );
    if ('refusals' in result) throw new Error(JSON.stringify(result.refusals));
    return result.resolved;
  }

  /** A load's dry run that would insert two accounts, `refused` the handler's refusal. */
  function dryRunOf(refused?: string, plan: Record<string, unknown> = {}): EnvDryRun {
    return {
      answer: {
        tool: 'sandforge-frozen',
        step: 'load',
        posted: refused
          ? [
              {
                type: 'frozen:load:preview:error',
                payload: { message: refused, code: 'GUARD_REFUSED' },
              },
            ]
          : [{ type: 'frozen:load:preview:response', payload: { plan } }],
        ...(refused
          ? {}
          : {
              objects: [
                {
                  objectApiName: 'Account',
                  fromFiles: 2,
                  toInsert: 2,
                  toLink: 0,
                  notSent: 0,
                  toPurge: 0,
                  toDeactivate: 0,
                },
              ],
            }),
      },
    };
  }

  /** A state holding the claims resource applied from `fingerprint`, its one load ended. */
  function appliedState(fingerprint: string): EnvState {
    const state = newEnvState({
      env: 'case-flow',
      org: { organizationId: ORG_ID, kind: 'developer', username: 'test-user@example.com' },
      fileDigest: 'a'.repeat(64),
      sandforgeVersion: '1.68.0',
    });
    const running = runStarted(state, {
      resource: 'claims',
      kind: 'frozen',
      fingerprint,
      dependsOn: [],
      run: {
        script: 'sandforge-frozen',
        sas: 'frozen/claims',
        startedAt: new Date(T0).toISOString(),
      },
    });
    return stepEnded(running, {
      resource: 'claims',
      status: 'applied',
      run: { endedAt: new Date(T0).toISOString(), exitCode: 0, objects: [] },
    });
  }

  /** What a preview of the load's removal says: two accounts in the org, as loaded. */
  const previewOf = (refreshed?: EnvRefreshed): EnvRunPreview => ({
    n: 1,
    preview: {
      tool: 'sandforge-frozen',
      preview: {
        planned: 2,
        objects: [
          {
            objectApiName: 'Account',
            planned: 2,
            toDelete: 2,
            alreadyGone: 0,
            changedSince: 0,
            keptChanged: 0,
            changedBy: {},
            undeletable: 0,
            notVisible: 0,
            unread: 0,
            reasons: [],
          },
        ],
        userNames: {},
      },
      refusals: [],
    },
    ...(refreshed !== undefined ? { refreshed } : {}),
  });

  const planWith = (resolved: EnvFileResolved, over: Partial<EnvPlanInput> = {}) =>
    envPlan({
      resolved,
      org: ORG,
      state: undefined,
      previews: {},
      dryRuns: {},
      budget: BUDGET,
      ...over,
    });

  it('blocks a resource whose dataset the plan did not read, or is not the one pinned, before any dry run', () => {
    const unread = planWith(frozenResolved());
    const moved = planWith(
      frozenResolved({ refusal: 'its dataset at /data/claims has the digest x' }),
    );

    expect(unread.actions[0]).toMatchObject({
      kind: 'frozen',
      action: 'blocked',
      // Resolved as the platform resolves it: under a drive on Windows.
      refusal: `its dataset at ${resolve('/data/claims')} was not read: plan again`,
    });
    expect(moved.actions[0]?.refusal).toBe('its dataset at /data/claims has the digest x');
  });

  it('counts exactly what its dry run would insert, says what the load would leave out, and leaves its requests out of the sum', () => {
    const plan = planWith(frozenResolved({ digest: DIGEST, version: '1.0.0' }), {
      dryRuns: {
        claims: dryRunOf(undefined, {
          removals: [
            {
              objectApiName: 'Account',
              field: 'Tax__c',
              reason: 'may-hold-masks',
              affectedRecords: 2,
            },
          ],
        }),
      },
    });

    expect(plan.actions[0]).toMatchObject({
      action: 'create',
      objects: [{ object: 'Account', wouldCreate: 2 }],
      gates: { storageBytes: 4096, emails: [] },
    });
    expect(plan.actions[0]?.why).toContain(
      'not applied to this org yet; it would leave out, encrypted in the target, Account.Tax__c (2)',
    );
    expect(plan.gates.apiRequests.notCounted).toEqual([
      'the requests of the run of claims, which its script does not estimate',
    ]);
  });

  it('blocks a resource its load refuses, in the handler’s own words', () => {
    const plan = planWith(frozenResolved({ digest: DIGEST, version: '1.0.0' }), {
      dryRuns: { claims: dryRunOf('Refusing frozen-dataset load on protected environment TGT') },
    });

    expect(plan.actions[0]).toMatchObject({
      action: 'blocked',
      refusal:
        'its own dry run says a real run would be refused: Refusing frozen-dataset load on protected environment TGT',
    });
  });

  it('keeps it while its verification passes, says it drifted, naming the object, when one FAILED, and blocks it when it could not say', () => {
    const resolved = frozenResolved({ digest: DIGEST, version: '1.0.0' });
    const state = appliedState(resolved.resources[0]?.fingerprint ?? '');
    const planned = (refreshed?: EnvRefreshed) =>
      planWith(resolved, { state, previews: { claims: [previewOf(refreshed)] } }).actions[0];

    expect(planned({ failed: [] })).toMatchObject({ action: 'keep' });
    expect(planned({ failed: ['Account FAILED (1 of 2 found)'] })).toMatchObject({
      action: 'drifted',
      why: expect.stringContaining('its verification: Account FAILED (1 of 2 found)'),
    });
    expect(planned({ unread: 'NO_LOAD' })).toMatchObject({
      action: 'blocked',
      refusal: expect.stringContaining('run 1: its verification did not say (NO_LOAD)'),
    });
    // Positive control: without a verification the preview alone keeps it.
    expect(planned()).toMatchObject({ action: 'keep' });
  });
});

describe('the plan of a resource drawing its parents from another', () => {
  /** Accounts, then contacts drawn from the accounts it created. */
  const drawingDocument = {
    version: 1,
    name: 'case-flow',
    resources: {
      accounts: {
        kind: 'seed',
        objects: [
          {
            object: 'Account',
            count: 2,
            fields: [
              { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'SFENV a' } },
            ],
          },
        ],
      },
      contacts: {
        kind: 'seed',
        objects: [
          {
            object: 'Contact',
            count: 4,
            fields: [
              { fieldApiName: 'LastName', ruleType: 'static', config: { staticValue: 'SFENV c' } },
            ],
          },
        ],
        relations: [
          {
            lookup: 'Contact.AccountId',
            parents: { from: 'accounts.Account' },
            distribution: { mode: 'perParent', count: 1 },
          },
        ],
      },
    },
  };

  it('counts at most as the file gives it what it draws from a resource that runs first, and says so', async () => {
    const resolved = resolvedOf(drawingDocument);

    const plan = await planOf(resolved, undefined, {
      draws: {
        contacts: {
          draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account' }],
          refusals: [],
        },
      },
    });

    const contacts = plan.actions.find((action) => action.resource === 'contacts');
    expect(contacts).toMatchObject({
      action: 'create',
      objects: [{ object: 'Contact', wouldCreate: 4, atMost: true }],
      draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account' }],
    });
    expect(contacts?.why).toBe(
      'not applied to this org yet; it draws its parents from the records accounts creates in this apply, which nobody knows before it runs: counted at most as the file gives it',
    );
    expect(planLines(plan)).toContain(
      '           Contact.AccountId draws its parents from the Account records accounts creates first',
    );
  });

  it('says how many parents it draws from a resource that ran, and counts them as no more than at most', () => {
    const resolved = resolvedOf(drawingDocument);

    const plan = envPlan({
      resolved,
      org: ORG,
      state: undefined,
      previews: {},
      dryRuns: {},
      budget: BUDGET,
      draws: {
        contacts: {
          draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account', parents: 2 }],
          refusals: [],
        },
      },
    });

    expect(plan.actions.find((each) => each.resource === 'contacts')?.draws).toEqual([
      { lookup: 'Contact.AccountId', from: 'accounts', object: 'Account', parents: 2 },
    ]);
    expect(planLines(plan)).toContain(
      '           Contact.AccountId draws its parents from the 2 Account record(s) accounts created',
    );
  });

  it('blocks it, before the apply’s first write, when its draw cannot be handed its parents', () => {
    const resolved = resolvedOf(drawingDocument);

    const plan = envPlan({
      resolved,
      org: ORG,
      state: undefined,
      previews: {},
      dryRuns: {},
      budget: BUDGET,
      draws: {
        contacts: {
          draws: [{ lookup: 'Contact.AccountId', from: 'accounts', object: 'Account' }],
          refusals: [
            'the relation on Contact.AccountId draws its parents from the Account records accounts created, and it created none',
          ],
        },
      },
    });

    expect(plan.actions.find((action) => action.resource === 'contacts')).toMatchObject({
      action: 'blocked',
      refusal:
        'the relation on Contact.AccountId draws its parents from the Account records accounts created, and it created none',
    });
    expect(plan.refusal).toContain('contacts (the relation on Contact.AccountId');
  });
});
