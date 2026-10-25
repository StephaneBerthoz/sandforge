import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvState, ForgeTargetAutomation } from '@sandforge/shared';

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
import { applyPlan, removeResource, type EnvStepDeps } from './envApply.js';
import { destroyEnvironment, destroyOrder } from './envDestroy.js';
import { readEnvFile, type EnvFileResolved } from './envFile.js';
import type { EnvTarget } from './envGuards.js';
import { acquireEnvLock } from './envLock.js';
import { destructionPlan, envPlan } from './envPlan.js';
import { openEnvStore, type EnvStore } from './envState.js';

/*
 * Taking an environment back from the memory org: each resource through the
 * seed's own removal, the last applied first, what it cannot take back named.
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
const ORG = { organizationId: ORG_ID, kind: 'developer' as const, alias: 'TGT' };

/** Accounts, then contacts drawn from them, the second depending on the first. */
function document(accept?: { automation: boolean }) {
  const named = (field: string, value: string) => [
    { fieldApiName: field, ruleType: 'static', config: { staticValue: value } },
  ];
  return {
    version: 1,
    name: 'case-flow',
    resources: {
      accounts: {
        kind: 'seed',
        seed: 1,
        ...(accept !== undefined ? { accept } : {}),
        objects: [{ object: 'Account', count: 2, fields: named('Name', 'SFENV account') }],
      },
      contacts: {
        kind: 'seed',
        seed: 2,
        dependsOn: ['accounts'],
        objects: [{ object: 'Contact', count: 2, fields: named('LastName', 'SFENV contact') }],
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

/** A trigger on accounts as they are deleted, which a removal asks to be accepted. */
const FIRING: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [],
      triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 1,
} as unknown as ForgeTargetAutomation;

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
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-destroy-'));
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  fileFolder = join(dir, 'project');
  mkdirSync(join(fileFolder, '.git'), { recursive: true });
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
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

/** The file applied to the memory org: the state it left. */
async function applied(resolved: EnvFileResolved = resolvedOf()): Promise<EnvState> {
  const dryRuns = await dryRunsIn(world, place(), resolved, ['accounts', 'contacts']);
  const plan = envPlan({
    resolved,
    org: ORG,
    state: undefined,
    previews: {},
    dryRuns,
    budget: {
      apiRequests: { remaining: 14_000, max: 15_000 },
      storage: { remainingMB: 5, maxMB: 5 },
      emails: {},
    },
  });
  const outcome = await applyPlan(deps(), {
    plan,
    resolved,
    target: TARGET,
    state: undefined,
    dryRuns,
    acceptAutomation: false,
  });
  if (outcome.exitCode !== 0) throw new Error(JSON.stringify(outcome.result));
  const state = await store.read(ORG_ID, 'case-flow');
  if (state === undefined) throw new Error('no state');
  return state;
}

interface Switches {
  includeChanged?: boolean;
  sweep?: boolean;
  acceptAutomation?: boolean;
}

/** Plan the destruction as the command line does, then destroy. */
async function destroy(
  resolved: EnvFileResolved = resolvedOf(),
  switches: Switches = {},
  stepDeps: Partial<EnvStepDeps> = {},
) {
  const state = await store.read(ORG_ID, 'case-flow');
  const previews = await previewsIn(world, place(), state, {
    ...(switches.includeChanged === true ? { includeChanged: true } : {}),
    ...(switches.acceptAutomation === true ? { acceptAutomation: true } : {}),
  });
  const plan = destructionPlan({ resolved, org: ORG, state, previews });
  return destroyEnvironment(deps(stepDeps), {
    plan,
    resolved,
    target: TARGET,
    state,
    includeChanged: switches.includeChanged === true,
    sweep: switches.sweep === true,
    acceptAutomation: switches.acceptAutomation === true,
  });
}

/** The removals the seed ran since `from`, by resource. */
function removalsSince(from: number): string[] {
  return world.calls
    .slice(from)
    .filter((call) => call.args.includes('--remove') && !call.args.includes('--preview'))
    .map((call) => {
      // Read with `/` whatever the platform wrote: Windows's paths have `\`.
      const subject = (call.args[call.args.indexOf('--remove') + 1] ?? '').replace(/\\/g, '/');
      return /runs\/([a-z-]+)\//.exec(subject)?.[1] ?? subject;
    });
}

/** The status of each resource the state keeps. */
async function statusesKept(): Promise<Record<string, string>> {
  const state = await store.read(ORG_ID, 'case-flow');
  return Object.fromEntries(
    Object.entries(state?.resources ?? {}).map(([name, resource]) => [name, resource.status]),
  );
}

describe('destroy', () => {
  it('takes every resource back, the last applied first, and keeps the state with each destroyed, exit 0', async () => {
    await applied();
    const from = world.calls.length;

    const outcome = await destroy();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.status).toBe('success');
    expect(removalsSince(from)).toEqual(['contacts', 'accounts']);
    expect(outcome.result.steps.map((s) => [s.resource, s.phase, s.exitCode, s.status])).toEqual([
      ['contacts', 'remove', 0, 'destroyed'],
      ['accounts', 'remove', 0, 'destroyed'],
    ]);
    expect(outcome.result.steps[1]?.objects).toEqual([
      { object: 'Account', created: 0, refused: 0, deleted: 2, kept: 0 },
    ]);
    expect(world.records('Account')).toEqual([]);
    expect(world.records('Contact')).toEqual([]);
    // Deleted, the state left the next apply to a Developer Edition or a
    // sandbox refused for want of one, as if a cache had been lost.
    expect(await statusesKept()).toEqual({ accounts: 'destroyed', contacts: 'destroyed' });
  });

  it('runs backwards because the forward order keeps every parent: the accounts first keep theirs, exit 3', async () => {
    const state = await applied();

    const forward = await removeResource(
      deps(),
      state,
      {
        resource: 'accounts',
        action: 'delete',
        target: TARGET,
        includeChanged: false,
        sweep: false,
        acceptAutomation: false,
        ends: { whole: 'destroyed', left: 'partial' },
      },
      new AbortController().signal,
    );

    expect(forward.code).toBe(3);
    expect(forward.steps[0]?.objects[0]).toMatchObject({ object: 'Account', deleted: 0, kept: 2 });
    expect(forward.steps[0]?.objects[0]?.reason).toContain('kept for records that stay (Contact)');
    expect(world.records('Account')).toHaveLength(2);
    expect(destroyOrder(state)).toEqual(['contacts', 'accounts']);
  });

  it('keeps what others changed since, names it, keeps the state for the next destroy, exit 3', async () => {
    await applied();
    const [contact] = world.records('Contact');
    world.org.edit('Contact', String(contact?.['Id']), { LastName: 'Edited' }, OTHER_USER);

    const outcome = await destroy();

    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.status).toBe('partial');
    const contacts = outcome.result.steps.find((s) => s.resource === 'contacts');
    expect(contacts).toMatchObject({ exitCode: 3, status: 'partial' });
    expect(contacts?.objects[0]?.reason).toContain('1 changed since the run, kept');
    const state = await store.read(ORG_ID, 'case-flow');
    expect(state?.resources['contacts']?.status).toBe('partial');
    expect(world.records('Contact').map((c) => c['LastName'])).toEqual(['Edited']);
  });

  it('takes what changed since too with --include-changed, then keeps the state with each destroyed', async () => {
    await applied();
    const [contact] = world.records('Contact');
    world.org.edit('Contact', String(contact?.['Id']), { LastName: 'Edited' }, OTHER_USER);
    await destroy();

    const outcome = await destroy(resolvedOf(), { includeChanged: true });

    expect(outcome.exitCode).toBe(0);
    expect(world.records('Contact')).toEqual([]);
    expect(world.records('Account')).toEqual([]);
    expect(await statusesKept()).toEqual({ accounts: 'destroyed', contacts: 'destroyed' });
  });

  it('refuses before its first delete when a removal would be refused for the org’s automation, and goes with the acceptance', async () => {
    await applied();
    world.automation = FIRING;
    const from = world.calls.length;

    const refused = await destroy();

    expect(refused.exitCode).toBe(1);
    expect(refused.result.refusal).toContain(
      'accounts: a removal of its runs would be refused now: TGT runs automation on the records',
    );
    expect(removalsSince(from)).toEqual([]);
    expect(world.records('Contact')).toHaveLength(2);

    const accepted = await destroy(resolvedOf(), { acceptAutomation: true });
    expect(accepted.exitCode).toBe(0);
    expect(world.records('Account')).toEqual([]);
  });

  it('reads a resource’s accept: { automation: true } as its acceptance', async () => {
    const resolved = resolvedOf(document({ automation: true }));
    await applied(resolved);
    world.automation = FIRING;
    const state = await store.read(ORG_ID, 'case-flow');
    // Previewed as the command line previews a resource that accepts it.
    const previews = await previewsIn(world, place(), state, { acceptAutomation: true });

    const outcome = await destroyEnvironment(deps(), {
      plan: destructionPlan({ resolved, org: ORG, state, previews }),
      resolved,
      target: TARGET,
      state,
      includeChanged: false,
      sweep: false,
      acceptAutomation: false,
    });

    expect(outcome.exitCode).toBe(0);
    const removal = world.calls.find(
      (call) =>
        call.args.includes('--remove') &&
        call.args.join(' ').replace(/\\/g, '/').includes('runs/accounts/'),
    );
    expect(removal?.args).toContain('--accept-automation');
  });

  it('passes --include-changed and --sweep on to each removal only when given', async () => {
    await applied();
    const lines: string[][] = [];
    const recording: EnvStepDeps['runner'] = async (script, args, signal) => {
      if (args.includes('--remove') && !args.includes('--preview')) lines.push([...args]);
      return world.runner(
        script,
        args.filter((arg) => arg !== '--sweep'),
        signal,
      );
    };

    await destroy(resolvedOf(), { includeChanged: true, sweep: true }, { runner: recording });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain('--include-changed');
      expect(line).toContain('--sweep');
    }
  });

  it('stopped, keeps the resource under way destroying, and destroy again takes up', async () => {
    await applied();
    let stop: ((signal: 'SIGTERM') => void) | undefined;
    const stopping: EnvStepDeps['runner'] = async (script, args, signal) => {
      const ran = await world.runner(script, args, signal);
      if (
        args.includes('--remove') &&
        args.join(' ').replace(/\\/g, '/').includes('runs/contacts/')
      ) {
        stop?.('SIGTERM');
        return { ...ran, code: 143 };
      }
      return ran;
    };

    const outcome = await destroy(
      resolvedOf(),
      {},
      {
        runner: stopping,
        onStop: (hear) => {
          stop = hear;
          return () => undefined;
        },
      },
    );

    expect(outcome.exitCode).toBe(143);
    expect(outcome.result.status).toBe('cancelled');
    expect(outcome.result.skipped).toEqual([
      { resource: 'accounts', why: 'the destroy was stopped before it' },
    ]);
    expect((await store.read(ORG_ID, 'case-flow'))?.resources['contacts']?.status).toBe(
      'destroying',
    );

    const again = await destroy();
    expect(again.exitCode).toBe(0);
    expect(world.records('Account')).toEqual([]);
    expect(await statusesKept()).toEqual({ accounts: 'destroyed', contacts: 'destroyed' });
  });

  it('with no state, takes nothing back and reaches nothing, exit 0', async () => {
    const from = world.calls.length;

    const outcome = await destroy();

    expect(outcome.exitCode).toBe(0);
    expect(world.calls.length).toBe(from);
    expect(said).toContain(
      'this machine keeps no state of case-flow on TGT: there is nothing to take back',
    );
  });

  it('refuses while another apply holds the org', async () => {
    await applied();
    const held = acquireEnvLock(locksDir, ORG_ID, { operation: 'apply', env: 'case-flow' });
    if (!('lock' in held)) throw new Error('not taken');
    try {
      const outcome = await destroy();

      expect(outcome.exitCode).toBe(1);
      expect(outcome.result.refusal).toContain('an apply of case-flow is under way');
      expect(world.records('Account')).toHaveLength(2);
    } finally {
      held.lock.release();
    }
  });
});
