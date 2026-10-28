import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECOVERED_FINGERPRINT,
  envPlanSchema,
  envRecoverResultSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
  type EnvPlan,
  type EnvRecoverResult,
  type EnvState,
} from '@sandforge/shared';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../sfSession.js', async (original) => ({
  ...(await original<typeof import('../sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../../src/modules/forge/RunVerifier.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/RunVerifier.js')>()),
  verifiedOrg: vi.fn(),
}));
vi.mock('../../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { organizationKey } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import { frozenDatasetDigest } from '../../src/modules/frozendataset/datasetDigest.js';
import { main, type EnvCliDeps } from '../sandforge-env.js';
import type { CommandRunner } from '../scriptRunner.js';
import { runnerWithCheckpoints } from '../testing/envCheckpointWorld.js';
import { EnvWorld, type EnvWorldOptions } from '../testing/envWorld.js';
import { freezeDataset } from '../testing/frozenDataset.js';
import { acquireEnvLock } from './envLock.js';
import { RECOVERED_WHY } from './envPlan.js';
import { openEnvStore } from './envState.js';

/*
 * `state recover` on the command line, on the memory org: each verb run as a
 * terminal or a CI step runs it, its scripts' own `main` in this process, so
 * every run file, summary, sidecar, sas and store a recover reads is the one
 * the scripts themselves wrote. What the org holds is read from the memory
 * org, by the records each run created, never from what a command said.
 */

const ORG_ID = '00D000000000006RAA';
const OTHER_ORG = '00D000000000005RAA';
const SOURCE_ID = '00D000000000004RAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const ENV = 'case-flow';

const named = (field: string, value: string) => [
  { fieldApiName: field, ruleType: 'static', config: { staticValue: value } },
];

/** Accounts, then contacts under them, found by their name. */
function seedFile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: ENV,
    resources: {
      accounts: {
        kind: 'seed',
        seed: 1,
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
    ...over,
  };
}

let dir: string;
let project: string;
let fileOf: string;
let journalDir: string;
let locksDir: string;
let journalBefore: string | undefined;
let world: EnvWorld;
let runner: CommandRunner;
let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;

/** A world of `options`, its runner running the checkpoint script too. */
function worldOf(options: EnvWorldOptions): void {
  world = new EnvWorld({
    organizationId: ORG_ID,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
    ...options,
  });
  runner = runnerWithCheckpoints(world, {
    locksDir,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
}

function writeFile(document: unknown): void {
  writeFileSync(fileOf, JSON.stringify(document, null, 2));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-recover-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  fileOf = join(project, 'sandforge.yaml');
  writeFile(seedFile());
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  // A Developer Edition org: where a lost state refuses the next apply.
  worldOf({ sandbox: false, edition: 'Developer Edition' });
  stdout = [];
  stderr = [];
  exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const deps = (over: Partial<EnvCliDeps> = {}): EnvCliDeps => ({
  runner,
  journalDir,
  locksDir,
  onStop: () => () => undefined,
  cwd: project,
  ...over,
});

/** Run the command, and give back its exit code, its answer read as JSON, and what it said. */
async function run(args: string[]): Promise<{ code: number; answer: unknown; said: string }> {
  stdout.length = 0;
  stderr.length = 0;
  process.exitCode = undefined;
  exitCode = undefined;
  try {
    await main(['node', 'sandforge-env.ts', ...args], deps());
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
  }
  const code = exitCode ?? Number(process.exitCode ?? 0);
  const out = stdout.join('');
  return {
    code,
    answer: args.includes('--json') && out.trim() !== '' ? (JSON.parse(out) as unknown) : undefined,
    said: `${args.includes('--json') ? '' : out}${stderr.join('')}`,
  };
}

const line = (...verb: string[]): string[] => [...verb, '--file', fileOf, '--org', 'TGT'];

/** The folder of the environment's state on the org, filed under its Organization Id's 18-character form. */
const folder = (env = ENV): string => join(journalDir, 'env', organizationKey(ORG_ID), env);

/** The state as the store reads it. */
async function stateNow(env = ENV): Promise<EnvState | undefined> {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if ('refusal' in opened) throw new Error(opened.refusal);
  return opened.store.read(ORG_ID, env);
}

/** Lose the state: `state.json` alone, the run files left where they are. */
async function lose(env = ENV): Promise<EnvState> {
  const lost = await stateNow(env);
  if (lost === undefined) throw new Error('no state to lose');
  rmSync(join(folder(env), 'state.json'));
  return lost;
}

/** Every file under a folder, by its path from it, with its content: what a refusal must leave as it was. */
function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path, `${key}/`);
      else out[key] = readFileSync(path, 'latin1');
    }
  };
  walk(root, '');
  return out;
}

/** What the journal directory keeps: every file but the checkpoint locks. */
const journalNow = (): Record<string, string> => filesOf(journalDir);

/** A recover's answer, read with the contract's own schema. */
async function recovered(): Promise<EnvRecoverResult> {
  const done = await run(line('state', 'recover', '--json'));
  expect(done.code, done.said).toBe(0);
  return envRecoverResultSchema.parse(done.answer) as EnvRecoverResult;
}

/** A recover refused: its exit code, its code, its words, and the journal left as it was. */
async function refusedRecover(code: string): Promise<string> {
  const before = journalNow();
  const done = await run(line('state', 'recover', '--json'));
  expect(done.code, done.said).toBe(1);
  const answer = envRefusalAnswerSchema.parse(done.answer);
  expect(answer.refusal.code, answer.refusal.message).toBe(code);
  expect(journalNow()).toEqual(before);
  return answer.refusal.message;
}

/** The records of the environment the org holds, by the mark the file writes. */
function marked(): { accounts: number; contacts: number } {
  return {
    accounts: world.records('Account').filter((r) => r['Name'] === 'SFENV account').length,
    contacts: world.records('Contact').filter((r) => r['LastName'] === 'SFENV contact').length,
  };
}

/** A run as the property compares it: what it points at, and whether it was taken back. */
const pointers = (state: EnvState | undefined, resource: string) =>
  (state?.resources[resource]?.runs ?? []).map((r) => ({
    n: r.n,
    runId: r.runId,
    summary: r.summary,
    seed: r.seed,
    takenBack: r.takenBack,
  }));

/** Apply, then replace contacts: run 1 of contacts taken back by the replace, run 2 written. */
async function applyThenReplace(): Promise<void> {
  const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
  expect(applied.code, applied.said).toBe(0);
  const replaced = await run(line('apply', '--yes', '--replace', 'contacts', '--json'));
  expect(replaced.code, replaced.said).toBe(0);
}

describe('state recover: a state lost, rebuilt from its run files', () => {
  it('rebuilds the state an apply and a replace left: the run the replace took back marked, the next plan replacing each resource with no --accept-no-state, and a destroy then leaves no record of the environment', async () => {
    await applyThenReplace();
    expect(marked()).toEqual({ accounts: 2, contacts: 2 });
    const lost = await lose();

    // With the state lost, the plan refuses the apply, and says what rebuilds it.
    const blind = await run(line('plan', '--json'));
    expect(blind.code).toBe(0);
    expect(envPlanSchema.parse(blind.answer).refusal).toContain(
      'it keeps runs of case-flow on TGT, and sandforge-env state recover rebuilds the state from them',
    );

    const result = await recovered();
    expect(result.resources).toEqual({
      accounts: { kind: 'seed', status: 'applied', runs: [1], takenBack: [], inFile: true },
      contacts: { kind: 'seed', status: 'applied', runs: [1, 2], takenBack: [1], inFile: true },
    });
    expect(result.state.serial).toBe(1);

    const state = await stateNow();
    expect(state?.serial).toBe(1);
    expect(state?.lineage).not.toBe(lost.lineage);
    expect(Object.keys(state?.resources ?? {})).toEqual(['accounts', 'contacts']);
    for (const resource of ['accounts', 'contacts']) {
      // Every run the lost state named, pointing at the same files, taken back as it was.
      expect(pointers(state, resource), resource).toEqual(pointers(lost, resource));
      expect(state?.resources[resource]).toMatchObject({
        recovered: true,
        fingerprint: RECOVERED_FINGERPRINT,
        dependsOn: lost.resources[resource]?.dependsOn,
      });
    }

    const planned = await run(line('plan', '--json'));
    const plan = envPlanSchema.parse(planned.answer) as EnvPlan;
    expect(plan.refusal).toBeUndefined();
    expect(plan.actions.map((a) => [a.resource, a.action])).toEqual([
      ['accounts', 'replace'],
      ['contacts', 'replace'],
    ]);
    for (const action of plan.actions) {
      expect(action.why).toContain(RECOVERED_WHY);
      expect(action.why).not.toContain('what it writes changed');
    }

    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(envRunResultSchema.parse(destroyed.answer).status).toBe('success');
    expect(marked()).toEqual({ accounts: 0, contacts: 0 });
  });

  it('marks a run taken back only on the removal’s own record: its sidecar gone, the run stays the org’s, and taking it back again finds its records gone', async () => {
    await applyThenReplace();
    const lost = await lose();
    const runId = lost.resources['contacts']?.runs[0]?.runId ?? '';
    rmSync(join(folder(), 'runs', 'contacts', '1.summary.removals.json'), { force: true });
    rmSync(join(journalDir, 'seed-runs', `${runId}.removal.json`), { force: true });

    const result = await recovered();
    expect(result.resources['contacts']).toMatchObject({ runs: [1, 2], takenBack: [] });

    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(marked()).toEqual({ accounts: 0, contacts: 0 });
  });

  it('rebuilds a run stopped before it printed its summary from its seed run file, applying, which the next plan takes back and runs again', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose();
    // A run killed before it answered leaves its run file alone.
    rmSync(join(folder(), 'runs', 'contacts', '1.summary.json'));

    const result = await recovered();
    expect(result.resources['contacts']).toMatchObject({ status: 'applying', runs: [1] });
    const contacts = (await stateNow())?.resources['contacts']?.runs[0];
    expect(contacts?.runId).toBe(lost.resources['contacts']?.runs[0]?.runId);
    expect(contacts?.summary).toBeUndefined();

    const planned = envPlanSchema.parse((await run(line('plan', '--json'))).answer) as EnvPlan;
    const why = planned.actions.find((a) => a.resource === 'contacts')?.why ?? '';
    expect(why).toContain('its last run was stopped part way');
    expect(why).toContain(RECOVERED_WHY);

    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(marked()).toEqual({ accounts: 0, contacts: 0 });
  });

  it('rebuilds a destroy that took everything back as every run taken back, each resource destroyed, which the next plan creates again; without the sidecars, the runs stay the org’s', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    await lose();
    const kept = journalNow();

    const result = await recovered();
    expect(result.resources['accounts']).toMatchObject({ status: 'destroyed', takenBack: [1] });
    expect(result.resources['contacts']).toMatchObject({ status: 'destroyed', takenBack: [1] });
    const planned = envPlanSchema.parse((await run(line('plan', '--json'))).answer) as EnvPlan;
    expect(planned.actions.map((a) => a.action)).toEqual(['create', 'create']);
    expect(planned.refusal).toBeUndefined();

    // Control: the same runs, no removal's record of them.
    rmSync(join(folder(), 'state.json'));
    for (const [path] of Object.entries(kept)) {
      if (path.endsWith('.removals.json') || path.endsWith('.removal.json')) {
        rmSync(join(journalDir, path));
      }
    }
    const again = await recovered();
    expect(again.resources['accounts']).toMatchObject({ status: 'applied', takenBack: [] });
    expect(again.resources['contacts']).toMatchObject({ status: 'applied', takenBack: [] });
  });

  it('sets a damaged state aside as it was, never deleted, and rebuilds the state beside it; the damaged state’s refusal now names state recover', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const damaged = '{"version": 1, "env": "case-flow", "cut short';
    writeFileSync(join(folder(), 'state.json'), damaged);

    const refused = await run(line('plan', '--json'));
    expect(refused.code).toBe(1);
    expect(envRefusalAnswerSchema.parse(refused.answer).refusal.message).toContain(
      'Run sandforge-env state recover: it sets this file aside and rebuilds the state from the run files beside it.',
    );

    const result = await recovered();
    expect(result.setAside).toMatch(/state\.json\.damaged-\d{8}-\d{6}$/);
    expect(readFileSync(result.setAside ?? '', 'utf8')).toBe(damaged);
    expect((await stateNow())?.serial).toBe(1);
  });

  it('keeps the resource the file no longer has, with no dependency, for the next plan to delete', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose();
    const shorter = seedFile();
    delete (shorter['resources'] as Record<string, unknown>)['contacts'];
    writeFile(shorter);

    const result = await recovered();
    expect(result.resources['contacts']).toMatchObject({ inFile: false, status: 'applied' });
    expect((await stateNow())?.resources['contacts']?.dependsOn).toEqual([]);
    const planned = envPlanSchema.parse((await run(line('plan', '--json'))).answer) as EnvPlan;
    expect(planned.actions.map((a) => [a.resource, a.action])).toEqual([
      ['contacts', 'delete'],
      ['accounts', 'replace'],
    ]);
  });
});

describe('state recover: what it refuses, writing nothing', () => {
  it('refuses a state that reads: it never writes over one', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const message = await refusedRecover('STATE_KEPT');
    expect(message).toContain('state recover never writes over one, and plan reads it');
  });

  it('refuses a state a later SandForge wrote: update it', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const state = await stateNow();
    // A key this SandForge does not read, as a later one may add.
    writeFileSync(
      join(folder(), 'state.json'),
      JSON.stringify({ ...state, sandforgeVersion: '99.0.0', later: {} }),
    );
    const message = await refusedRecover('STATE_NEWER');
    expect(message).toContain('was written by a later SandForge (99.0.0');
    expect(message).toContain('update it, and plan again');

    // Control: the same state written by this SandForge is set aside.
    writeFileSync(join(folder(), 'state.json'), JSON.stringify({ ...state, later: {} }));
    expect((await recovered()).setAside).toBeDefined();
  });

  it('refuses a state of another org put in this org’s folder: put it back', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const state = await stateNow();
    writeFileSync(
      join(folder(), 'state.json'),
      JSON.stringify({ ...state, org: { ...state?.org, organizationId: OTHER_ORG } }),
    );
    const message = await refusedRecover('OTHER_ORG');
    expect(message).toContain('Put it back where it came from');
  });

  it('refuses a summary of a run that wrote to another org, naming it', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose();
    const file = join(folder(), 'runs', 'accounts', '1.summary.json');
    const summary = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(summary['targetOrgId']).toBe(ORG_ID);
    writeFileSync(file, JSON.stringify({ ...summary, targetOrgId: OTHER_ORG }));
    const message = await refusedRecover('RUN_OTHER_ORG');
    expect(message).toContain(file);
    expect(message).toContain(`wrote to ${OTHER_ORG}, not to TGT`);
  });

  it('refuses a summary that does not read, naming it', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose();
    const file = join(folder(), 'runs', 'contacts', '1.summary.json');
    writeFileSync(file, '{"tool": "sandforge-seed", "cut');
    const message = await refusedRecover('RUN_UNREAD');
    expect(message).toContain(`The summary ${file} does not read (not JSON)`);
  });

  it('refuses two seed runs kept for one rank: the state they come from cannot be told', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose();
    const runId = lost.resources['accounts']?.runs[0]?.runId ?? '';
    const other = `env-${ENV}-accounts-1-00000000-0000-4000-8000-000000000001`;
    const text = readFileSync(join(journalDir, 'seed-runs', `${runId}.ndjson`), 'utf8');
    writeFileSync(join(journalDir, 'seed-runs', `${other}.ndjson`), text.replaceAll(runId, other));
    const message = await refusedRecover('RUNS_CONFLICT');
    expect(message).toContain('Two seed runs are kept for run 1 of accounts');
  });

  it('passes over the seed runs of another org, which share the folder', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose();
    const runId = lost.resources['accounts']?.runs[0]?.runId ?? '';
    const other = `env-${ENV}-accounts-1-00000000-0000-4000-8000-000000000002`;
    const text = readFileSync(join(journalDir, 'seed-runs', `${runId}.ndjson`), 'utf8');
    writeFileSync(
      join(journalDir, 'seed-runs', `${other}.ndjson`),
      text.replaceAll(runId, other).replaceAll(ORG_ID, OTHER_ORG),
    );
    const result = await recovered();
    expect(result.resources['accounts']?.runs).toEqual([1]);
    expect((await stateNow())?.resources['accounts']?.runs[0]?.runId).toBe(runId);
  });

  it('tells its seed runs from those of an environment whose name begins as its own, and refuses one either could own, or one nothing claims', async () => {
    // case-flow applied, then case, on the same org: their run ids share `env-case-`.
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const short = seedFile({ name: 'case' });
    writeFile(short);
    const again = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(again.code, again.said).toBe(0);
    const lostCase = await lose('case');

    const result = await recovered();
    expect(Object.keys(result.resources)).toEqual(['accounts', 'contacts']);
    for (const resource of ['accounts', 'contacts']) {
      expect(pointers(await stateNow('case'), resource)).toEqual(pointers(lostCase, resource));
    }

    // A resource of case named as case-flow's runs read: either could own them.
    rmSync(join(folder('case'), 'state.json'));
    writeFile(
      seedFile({
        name: 'case',
        resources: {
          ...(short['resources'] as Record<string, unknown>),
          'flow-accounts': (short['resources'] as Record<string, unknown>)['accounts'],
        },
      }),
    );
    const both = await refusedRecover('RUN_UNCLAIMED');
    expect(both).toContain('may be run 1 of flow-accounts of case, or a run of case-flow');

    // case-flow's folder gone, its runs left: nothing claims them, and they are not taken back.
    writeFile(short);
    rmSync(folder(), { recursive: true });
    const none = await refusedRecover('RUN_UNCLAIMED');
    expect(none).toContain('is of a resource flow-accounts that neither the file nor');
  });

  it('refuses a journal that keeps no run of the environment: nothing to rebuild from', async () => {
    const before = journalNow();
    const done = await run(line('state', 'recover', '--json'));
    expect(done.code).toBe(1);
    const answer = envRefusalAnswerSchema.parse(done.answer);
    expect(answer.refusal.code).toBe('NO_RUNS');
    expect(answer.refusal.message).toBe(
      'This machine keeps no run of case-flow on TGT: there is nothing to rebuild a state from. ' +
        'If the org holds nothing of the environment, apply it with --accept-no-state. Nothing ' +
        'was written.',
    );
    expect(existsSync(folder())).toBe(false);
    expect(filesOf(join(journalDir, 'seed-runs'))).toEqual(before['seed-runs'] ?? {});
  });

  it('refuses while another apply of the org holds it on this machine', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose();
    const held = acquireEnvLock(locksDir, ORG_ID, { operation: 'apply', env: ENV, alias: 'TGT' });
    if (!('lock' in held)) throw new Error('not taken');
    try {
      const message = await refusedRecover('LOCKED');
      expect(message).toContain('an apply of case-flow to TGT is under way on this machine');
    } finally {
      held.lock.release();
    }
  });

  it('refuses a production org before anything is read, and a line without --org', async () => {
    worldOf({ sandbox: false, edition: 'Enterprise Edition' });
    const done = await run(line('state', 'recover', '--json'));
    expect(done.code).toBe(1);
    expect(envRefusalAnswerSchema.parse(done.answer).refusal.code).toBe('PRODUCTION');

    const bare = await run(['state', 'recover', '--file', fileOf]);
    expect(bare.code).toBe(2);
    expect(bare.said).toContain('state recover needs --org, the sf CLI alias of the org.');
    const flag = await run([...line('state', 'recover'), '--yes']);
    expect(flag.code).toBe(2);
    expect(flag.said).toContain('"--yes" is not a flag this command reads');
  });

  it('refuses, exit 2, a file that does not validate and a journal directory inside the file’s repository', async () => {
    writeFile({ ...seedFile(), version: 2 });
    const invalid = await run(line('state', 'recover', '--json'));
    expect(invalid.code).toBe(2);
    expect(envRefusalAnswerSchema.parse(invalid.answer).refusal.code).toBe('INVALID_FILE');

    writeFile(seedFile());
    journalDir = join(project, '.sandforge');
    const inside = await run(line('state', 'recover', '--json'));
    expect(inside.code).toBe(2);
    expect(envRefusalAnswerSchema.parse(inside.answer).refusal.code).toBe('STORE_IN_REPOSITORY');
  });
});

describe('state recover: the checkpoints, linked only on proof', () => {
  beforeEach(() => {
    worldOf({ sandbox: true, scratch: true });
  });

  it('links the checkpoint taken before the first run and the one taken once applied, each the one of its name', async () => {
    writeFile(seedFile({ checkpoint: { before: true, after: 'baseline' } }));
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose();
    expect(lost.checkpoints?.before).toMatch(/^ck-/);
    expect(lost.checkpoints?.after).toMatch(/^ck-/);

    const result = await recovered();
    expect(result.checkpoints).toEqual(lost.checkpoints);
    expect(result.notLinked).toEqual([]);
    expect((await stateNow())?.checkpoints).toEqual(lost.checkpoints);
  });

  it('links neither of two checkpoints of the name before the first run, and no checkpoint of the after’s name taken before the last run', async () => {
    writeFile(seedFile({ checkpoint: { before: true, after: 'baseline' } }));
    // Taken by hand before the apply, under the names the environment takes its own.
    for (const name of [`${ENV} before`, 'baseline']) {
      const taken = await runner(
        'sandforge-checkpoint',
        [
          'take',
          '--org',
          'TGT',
          '--store',
          join(journalDir, 'checkpoints'),
          '--name',
          name,
          '--keep-days',
          '30',
          '--json',
        ],
        new AbortController().signal,
      );
      expect(taken.code, taken.stderr).toBe(0);
    }
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose();

    const result = await recovered();
    expect(result.checkpoints.before).toBeUndefined();
    expect(result.notLinked).toContainEqual(
      expect.stringContaining(
        "checkpoint.before: 2 checkpoint(s) of this org named 'case-flow before' taken before the first run: none is linked",
      ),
    );
    // The one taken once applied is the one after the last run: the other, older, is not.
    expect(result.checkpoints.after).toBe(lost.checkpoints?.after);
  });

  it('says a file that asks no checkpoint asks none', async () => {
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose();
    const result = await recovered();
    expect(result.checkpoints).toEqual({});
    expect(result.notLinked).toEqual([
      'checkpoint.before: the file asks none',
      'checkpoint.after: the file asks none',
    ]);
  });
});

describe('state recover: a mask resource', () => {
  const RULES = [{ fieldPattern: 'Contact.Phone', ruleType: 'nullify' }];
  const maskFile = {
    version: 1,
    name: 'uat-masked',
    masking: { points: { rules: RULES } },
    resources: {
      customers: { kind: 'mask', rules: 'points', object: 'Contact', where: "LastName = 'Copied'" },
    },
  };

  beforeEach(() => {
    worldOf({ sandbox: true, scratch: true });
    world.copyIn('Contact', [
      { LastName: 'Copied', Email: 'one@example.com', Phone: '+33 1 00 00 00 01' },
      { LastName: 'Copied', Email: 'two@example.com', Phone: '+33 1 00 00 00 02' },
    ]);
    writeFile(maskFile);
  });

  it('keeps its masking applied, its snapshot named, while its store is there; once a destroy deleted the store, every run of it is taken back', async () => {
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose('uat-masked');

    const result = await recovered();
    expect(result.resources['customers']).toEqual({
      kind: 'mask',
      status: 'applied',
      runs: [1],
      takenBack: [],
      inFile: true,
    });
    const run1 = (await stateNow('uat-masked'))?.resources['customers']?.runs[0];
    expect(run1?.snapshotId).toBe(lost.resources['customers']?.runs[0]?.snapshotId);
    expect(run1?.objects).toEqual(lost.resources['customers']?.runs[0]?.objects);

    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(existsSync(join(folder('uat-masked'), 'dataops', 'customers'))).toBe(false);
    await lose('uat-masked');
    const after = await recovered();
    expect(after.resources['customers']).toMatchObject({ status: 'destroyed', takenBack: [1] });
  });
});

describe('state recover: a frozen resource', () => {
  beforeEach(async () => {
    worldOf({ sandbox: true, scratch: true });
    mkdirSync(join(project, 'frozen'));
    writeFileSync(
      join(project, 'frozen', 'claims.frozen.json'),
      JSON.stringify({ rootObject: 'Account', axes: [], edgeCases: [] }),
    );
    const dataset = await freezeDataset(join(dir, 'datasets', 'claims'), {
      accounts: 2,
      perAccount: 1,
      mark: 'claim',
    });
    process.env['SANDFORGE_RECOVER_DATASET'] = dataset;
    writeFile({
      version: 1,
      name: 'claims-flow',
      resources: {
        claims: {
          kind: 'frozen',
          config: 'frozen/claims.frozen.json',
          dataset: {
            path: { env: 'SANDFORGE_RECOVER_DATASET' },
            version: '1.0.0',
            digest: await frozenDatasetDigest(dataset),
          },
        },
      },
    });
  });
  afterEach(() => {
    delete process.env['SANDFORGE_RECOVER_DATASET'];
  });

  it('keeps a load the org still holds, its sas named; once a destroy removed every load of the sas, the run is taken back', async () => {
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const lost = await lose('claims-flow');
    expect(world.records('Account')).toHaveLength(2);

    const result = await recovered();
    expect(result.resources['claims']).toMatchObject({
      kind: 'frozen',
      status: 'applied',
      runs: [1],
      takenBack: [],
    });
    expect((await stateNow('claims-flow'))?.resources['claims']?.runs[0]).toMatchObject({
      sas: lost.resources['claims']?.runs[0]?.sas,
      summary: lost.resources['claims']?.runs[0]?.summary,
    });

    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(world.records('Account')).toHaveLength(0);
    await lose('claims-flow');
    const after = await recovered();
    expect(after.resources['claims']).toMatchObject({ status: 'destroyed', takenBack: [1] });
  });

  it('refuses a load whose payload is gone while the org holds what it created: its removal is run from it', async () => {
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose('claims-flow');
    const template = join(folder('claims-flow'), 'templates', 'claims.1.json');
    rmSync(template);
    const message = await refusedRecover('RUN_UNREAD');
    expect(message).toContain(`Run 1 of claims keeps its summary and not the payload its load`);
    expect(message).toContain(template);
  });
});

describe('state recover: a forge resource', () => {
  const MARK = 'SFENV forge';
  beforeEach(() => {
    worldOf({
      sandbox: false,
      edition: 'Developer Edition',
      source: { alias: 'SRC', organizationId: SOURCE_ID },
    });
    world.seedSource('Account', [{ Name: MARK }, { Name: MARK }]);
    writeFile({
      version: 1,
      name: 'clone-flow',
      orgs: { uat: { alias: 'SRC' } },
      resources: {
        cloned: {
          kind: 'forge',
          source: 'uat',
          tables: [{ object: 'Account', where: `Name = '${MARK}'` }],
        },
      },
    });
  });

  it('keeps a clone the org still holds; once its removal left nothing, by the sidecar beside its summary, the run is taken back, and without that sidecar it is not', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose('clone-flow');
    const result = await recovered();
    expect(result.resources['cloned']).toMatchObject({
      kind: 'forge',
      status: 'applied',
      runs: [1],
      takenBack: [],
    });
    const run1 = (await stateNow('clone-flow'))?.resources['cloned']?.runs[0];
    expect(Date.parse(run1?.startedAt ?? '')).toBeLessThanOrEqual(Date.parse(run1?.endedAt ?? ''));

    const destroyed = await run(line('destroy', '--yes', '--json'));
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(world.records('Account')).toHaveLength(0);
    await lose('clone-flow');
    const after = await recovered();
    expect(after.resources['cloned']).toMatchObject({ status: 'destroyed', takenBack: [1] });

    // Control: the sidecar gone, nothing proves the removal.
    rmSync(join(folder('clone-flow'), 'state.json'));
    rmSync(join(folder('clone-flow'), 'runs', 'cloned', '1.summary.removals.json'));
    const unproved = await recovered();
    expect(unproved.resources['cloned']).toMatchObject({ status: 'applied', takenBack: [] });
  });
});

describe('state recover: its files and its lines', () => {
  it('writes the state its owner’s alone, as every state is', async () => {
    const applied = await run(line('apply', '--yes', '--accept-no-state', '--json'));
    expect(applied.code, applied.said).toBe(0);
    await lose();
    await recovered();
    if (process.platform !== 'win32') {
      expect(statSync(join(folder(), 'state.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('says per resource its runs, those taken back and the next action, on a terminal', async () => {
    await applyThenReplace();
    await lose();
    const done = await run(line('state', 'recover'));
    expect(done.code, done.said).toBe(0);
    expect(done.said).toContain('state of case-flow on TGT rebuilt from its run files: serial 1');
    expect(done.said).toContain('  accounts  seed, applied: run 1\n');
    expect(done.said).toContain('  contacts  seed, applied: runs 1, 2; run 1 taken back\n');
    expect(done.said).toContain('next: plan replaces each resource still in the org');
  });
});
