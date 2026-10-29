import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envPlanSchema,
  envRefusalAnswerSchema,
  envRewindResultSchema,
  envRunResultSchema,
  type EnvPlan,
  type EnvRewindResult,
  type EnvRunResult,
} from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({ loadOrg: vi.fn(), makeConn: vi.fn() }));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { openEnvStore } from './env/envState.js';
import { EnvWorld } from './testing/envWorld.js';
import { runnerWithCheckpoints } from './testing/envCheckpointWorld.js';
import { main, type EnvCliDeps } from './sandforge-env.js';
import type { CommandRunner } from './scriptRunner.js';

/*
 * The checkpoints of an environment on the command line, on the memory org:
 * each verb run as a terminal or a CI step runs it, its scripts
 * `sandforge-seed`'s and `sandforge-checkpoint`'s own `main` in this process,
 * the checkpoint script through the extension's own host. What the org holds
 * is read from the memory org itself, never from what a command said.
 */

const ORG_ID = '00D000000000009CAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const COLLEAGUE = '005000000000003AAA';

/** Accounts, then contacts drawn from them, the checkpoints the test gives. */
function file(checkpoint?: Record<string, unknown>): Record<string, unknown> {
  const named = (field: string, value: string) => [
    { fieldApiName: field, ruleType: 'static', config: { staticValue: value } },
  ];
  return {
    version: 1,
    name: 'pool',
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    resources: {
      accounts: {
        kind: 'seed',
        seed: 1,
        objects: [{ object: 'Account', count: 2, fields: named('Name', 'SFENV account') }],
      },
    },
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

/** A scratch org in memory, unless a test makes it another; its runner runs the checkpoint script too. */
function worldOf(
  options: { scratch?: boolean; permissions?: { modifyAllData?: boolean } } = {},
): EnvWorld {
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: true,
    scratch: options.scratch ?? true,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  runner = runnerWithCheckpoints(world, {
    locksDir,
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  return world;
}

function writeFile(content: Record<string, unknown>): void {
  writeFileSync(fileOf, JSON.stringify(content, null, 2));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-checkpoint-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  fileOf = join(project, 'sandforge.yaml');
  writeFile(file({ after: 'baseline' }));
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  worldOf();
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

/** Run the command, and give back its exit code and its answer, read as JSON. */
async function run(
  args: string[],
  over: Partial<EnvCliDeps> = {},
): Promise<{ code: number; answer: unknown; said: string }> {
  stdout.length = 0;
  stderr.length = 0;
  process.exitCode = undefined;
  exitCode = undefined;
  try {
    await main(['node', 'sandforge-env.ts', ...args], deps(over));
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
  }
  const code = exitCode ?? Number(process.exitCode ?? 0);
  const out = stdout.join('');
  return {
    code,
    answer:
      !args.includes('--json') || out.trim() === '' ? undefined : (JSON.parse(out) as unknown),
    said: stderr.join(''),
  };
}

const ON = ['--file', '', '--org', 'POOL'];
const line = (verb: string, ...more: string[]): string[] => {
  ON[1] = fileOf;
  return [verb, ...ON, ...more];
};

/** The state of the environment on the org, as the store reads it. */
async function stateNow() {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if ('refusal' in opened) throw new Error(opened.refusal);
  return opened.store.read(ORG_ID, 'pool');
}

/** The checkpoints kept on this machine, by their folders. */
function checkpointsKept(): string[] {
  const root = join(journalDir, 'checkpoints');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((org) =>
      readdirSync(join(root, org.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('ck-'))
        .map((entry) => entry.name),
    );
}

describe('checkpoint.after, and reset', () => {
  it('takes the checkpoint once applied, and reset rewinds the org to it: what a test created, changed and deleted is taken back', async () => {
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const result = envRunResultSchema.parse(applied.answer) as EnvRunResult;
    const after = result.checkpoints?.find((c) => c.step === 'after')?.checkpoint;
    expect(after).toMatch(/^ck-/);
    expect((await stateNow())?.checkpoints).toEqual({ after });
    const stateAfterApply = (await stateNow())?.serial;

    const accounts = world.records('Account');
    expect(accounts).toHaveLength(2);
    const [first, second] = accounts;
    world.org.edit('Account', String(first?.['Id']), { Name: 'Renamed by a test' }, COLLEAGUE);
    world.org.trash('Account', String(second?.['Id']), COLLEAGUE);
    world.org.add('Account', {
      Id: '001000000000777AAA',
      Name: 'Made by a test',
      CreatedById: COLLEAGUE,
      LastModifiedById: COLLEAGUE,
    });

    const reset = await run(line('reset', '--yes', '--json'));

    expect(reset.code, reset.said).toBe(0);
    const answer = envRewindResultSchema.parse(reset.answer) as EnvRewindResult;
    expect(answer).toMatchObject({
      verb: 'reset',
      checkpoint: { step: 'after', id: after },
      status: 'success',
      undo: { offered: true },
    });
    const names = world
      .records('Account')
      .map((record) => record['Name'])
      .sort();
    expect(names).toEqual(['SFENV account', 'SFENV account']);
    expect(world.records('Account').map((r) => r['Id'])).toEqual(
      expect.arrayContaining([first?.['Id'], second?.['Id']]),
    );
    // The state is the apply's: the same runs, and their records in the org again.
    expect((await stateNow())?.resources['accounts']?.status).toBe('applied');
    expect((await stateNow())?.serial).toBe(stateAfterApply);
  });

  it('says in the plan what the take costs, by the checkpoint script’s own estimate, and adds its requests to the day’s sum', async () => {
    const planned = await run(line('plan', '--json'));

    expect(planned.code, planned.said).toBe(0);
    const plan = envPlanSchema.parse(planned.answer) as EnvPlan;
    const [checkpoint] = plan.checkpoints ?? [];
    expect(checkpoint).toMatchObject({ step: 'after', name: 'baseline' });
    expect(checkpoint?.estimate?.apiRequests).toBeGreaterThan(0);
    const seed = plan.actions[0]?.gates?.apiRequests ?? 0;
    expect(plan.gates.apiRequests.estimate).toBe(seed + (checkpoint?.estimate?.apiRequests ?? 0));
    expect(planned.said).toMatch(
      /checkpoint once applied: 'baseline', about \d+ records, \d+ API requests, \d+ s, [\d.]+ MB on this machine/,
    );
    // Estimated, never taken: nothing is kept on this machine.
    expect(checkpointsKept()).toEqual([]);
  });

  it('takes no checkpoint again when an apply writes nothing, and takes a new one in place of the last when one writes', async () => {
    await run(line('apply', '--yes'));
    const first = (await stateNow())?.checkpoints?.after;
    const calls = world.calls.length;

    const again = await run(line('apply', '--yes', '--json'));
    expect(again.code, again.said).toBe(0);
    expect(world.calls.slice(calls).map((call) => call.args[0])).not.toContain('take');
    expect((await stateNow())?.checkpoints?.after).toBe(first);

    const edited = file({ after: 'baseline' }) as {
      resources: { accounts: { objects: Array<{ count: number }> } };
    };
    const [accounts] = edited.resources.accounts.objects;
    if (accounts) accounts.count = 3;
    writeFile(edited);
    const replaced = await run(line('apply', '--yes', '--json'));

    expect(replaced.code, replaced.said).toBe(0);
    const result = envRunResultSchema.parse(replaced.answer) as EnvRunResult;
    expect(result.checkpoints?.map((c) => [c.step, c.exitCode])).toEqual([
      ['delete', 0],
      ['after', 0],
    ]);
    const second = (await stateNow())?.checkpoints?.after;
    expect(second).toMatch(/^ck-/);
    expect(second).not.toBe(first);
    expect(checkpointsKept()).toEqual([second]);
  });

  it('compares the whole org with the checkpoint after the last apply: a record outside the environment makes --fail-on-drift exit 3', async () => {
    await run(line('apply', '--yes'));
    const quiet = await run(line('plan', '--fail-on-drift', '--json'));
    expect(quiet.code, quiet.said).toBe(0);
    expect((envPlanSchema.parse(quiet.answer) as EnvPlan).drift).toMatchObject({
      differs: false,
    });

    // Nothing of the environment's own records moved: its removal previews see nothing.
    world.org.add('Account', {
      Id: '001000000000777AAA',
      Name: 'Made by a test',
      CreatedById: COLLEAGUE,
      LastModifiedById: COLLEAGUE,
    });
    const drifted = await run(line('plan', '--fail-on-drift', '--json'));

    expect(drifted.code, drifted.said).toBe(3);
    const plan = envPlanSchema.parse(drifted.answer) as EnvPlan;
    expect(plan.actions.map((a) => a.action)).toEqual(['keep']);
    expect(plan.drift).toMatchObject({ differs: true, toDelete: 1 });
    expect(drifted.said).toContain(
      'the whole org against the checkpoint after the last apply (ck-',
    );
    expect(drifted.said).toContain('differs, 1 to delete · 0 to give back · 0 to bring back');
  });

  it('keeps, after a reset, the records it gave back their values: dated since, they hold what the checkpoint holds, and the org does not drift', async () => {
    await run(line('apply', '--yes'));
    const [first] = world.records('Account');
    world.org.edit('Account', String(first?.['Id']), { Name: 'Renamed by a test' }, COLLEAGUE);
    expect((await run(line('reset', '--yes'))).code).toBe(0);

    const planned = await run(line('plan', '--fail-on-drift', '--json'));

    expect(planned.code, planned.said).toBe(0);
    const plan = envPlanSchema.parse(planned.answer) as EnvPlan;
    // The removal preview reads the record's date alone: written by the reset, it counts it changed.
    expect(plan.actions[0]).toMatchObject({
      action: 'keep',
      objects: [{ object: 'Account', present: 2, changed: 1 }],
    });
    expect(plan.actions[0]?.why).toContain(
      'as the checkpoint taken after the apply holds them: 1 written since hold their values again, as a reset gives them back',
    );
    expect(plan.drift).toMatchObject({ differs: false });
  });

  it('refuses a reset with no checkpoint after the last apply, before the org is rewound: exit 1, nothing written', async () => {
    writeFile(file());
    await run(line('apply', '--yes'));
    const calls = world.calls.length;

    const reset = await run(line('reset', '--yes', '--json'));

    expect(reset.code).toBe(1);
    expect(envRefusalAnswerSchema.parse(reset.answer).refusal).toMatchObject({
      code: 'NO_CHECKPOINT',
    });
    expect(reset.said).toContain(
      'names no checkpoint taken after an apply: the file asks none (checkpoint.after)',
    );
    expect(world.calls.slice(calls).map((call) => call.script)).not.toContain(
      'sandforge-checkpoint',
    );
  });

  it('refuses a reset once an apply did not end whole: the checkpoint before it no longer holds the environment the state names', async () => {
    await run(line('apply', '--yes'));
    const opened = openEnvStore({ journalDir, fileFolder: project });
    if ('refusal' in opened) throw new Error(opened.refusal);
    const state = await opened.store.read(ORG_ID, 'pool');
    if (state === undefined) throw new Error('no state');
    const resource = state.resources['accounts'];
    if (resource === undefined) throw new Error('no accounts');
    await opened.store.update(state, (s) => ({
      ...s,
      resources: { ...s.resources, accounts: { ...resource, status: 'partial' } },
    }));

    const reset = await run(line('reset', '--yes'));

    expect(reset.code).toBe(1);
    expect(reset.said).toContain(
      'accounts is partial: the last apply did not end whole, and the checkpoint taken after the apply before it no longer holds the environment the state names. Apply again, then reset.',
    );
  });

  it('asks for the alias before it resets, naming what it takes back and who last changed it, and a wrong one writes nothing', async () => {
    worldOf();
    runner = runnerWithCheckpoints(world, {
      locksDir,
      users: { [COLLEAGUE]: 'Colleague' },
      tick: () => vi.setSystemTime(Date.now() + 30_000),
    });
    await run(line('apply', '--yes'));
    const [first] = world.records('Account');
    world.org.edit('Account', String(first?.['Id']), { Name: 'Renamed by a test' }, COLLEAGUE);
    const asked: string[] = [];

    const declined = await run(line('reset'), {
      ask: async (question) => {
        asked.push(question);
        return 'NOT-POOL';
      },
    });

    expect(declined.code).toBe(1);
    expect(asked[0]).toBe(
      "Type POOL to reset it to 'baseline', as pool was applied: it deletes 0 record(s) created " +
        'since, gives 1 their values back and brings 0 back from the recycle bin — whoever made ' +
        'these changes, last changed by Colleague 1:',
    );
    expect(world.records('Account').map((r) => r['Name'])).toContain('Renamed by a test');

    const reset = await run(line('reset'), { ask: async () => 'POOL' });
    expect(reset.code, reset.said).toBe(0);
    expect(world.records('Account').map((r) => r['Name'])).not.toContain('Renamed by a test');
    // With no terminal and no --yes, it stops at its question, having written nothing.
    world.org.edit('Account', String(first?.['Id']), { Name: 'Renamed again' }, COLLEAGUE);
    const noTerminal = await run(line('reset'), { ask: undefined });
    expect(noTerminal.code).toBe(2);
    expect(world.records('Account').map((r) => r['Name'])).toContain('Renamed again');
  });

  it('asks nothing of a reset with nothing to rewind, as the checkpoint script asks nothing of such a rewind', async () => {
    await run(line('apply', '--yes'));
    const asked: string[] = [];

    const reset = await run(line('reset'), {
      ask: async (question) => {
        asked.push(question);
        return 'POOL';
      },
    });

    expect(reset.code, reset.said).toBe(0);
    expect(asked).toEqual([]);
    // On a terminal, the lines go to stdout.
    expect(stdout.join('')).toContain(
      '0 to delete · 0 to give back · 0 to bring back — nothing differs',
    );
  });

  it('passes the acceptances the line gives to the rewind, and no other', async () => {
    await run(line('apply', '--yes'));

    await run(line('reset', '--yes', '--accept-automation', '--accept-no-undo', '--accept-unseen'));
    await run(line('reset', '--yes'));

    const rewinds = world.calls.filter(
      (call) => call.script === 'sandforge-checkpoint' && call.args[0] === 'rewind',
    );
    expect(rewinds[0]?.args).toEqual(
      expect.arrayContaining([
        '--yes',
        '--accept-automation',
        '--accept-no-undo',
        '--accept-unseen',
        '--json',
      ]),
    );
    expect(rewinds[1]?.args).not.toContain('--accept-automation');
    expect(rewinds[1]?.args).not.toContain('--accept-unseen');
    expect(rewinds.flatMap((call) => call.args)).not.toContain('--accept-recreate');
  });

  it('says the undo the checkpoint script offers, in a line that takes the reset back as it is written', async () => {
    await run(line('apply', '--yes'));
    const [first] = world.records('Account');
    world.org.edit('Account', String(first?.['Id']), { Name: 'Renamed by a test' }, COLLEAGUE);
    const reset = await run(line('reset', '--yes', '--json'));
    const answer = envRewindResultSchema.parse(reset.answer) as EnvRewindResult;
    if (!answer.undo.offered) throw new Error('no undo offered');
    expect(reset.said).toContain(
      `undo it until ${answer.undo.until}, sooner if the recycle bin fills: sandforge-checkpoint undo --org POOL --checkpoint ${answer.checkpoint.id} --store ${join(journalDir, 'checkpoints')}`,
    );

    const [script, ...args] = answer.undo.line.split(' ');
    expect(script).toBe('sandforge-checkpoint');
    const undone = await runner(
      'sandforge-checkpoint',
      [...args, '--yes', '--json'],
      new AbortController().signal,
    );

    expect(undone.code, undone.stderr).toBe(0);
    expect(world.records('Account').map((r) => r['Name'])).toContain('Renamed by a test');
  });

  it('refuses the apply before its first write when the checkpoint guard refuses the take: the user lacks Modify All Data', async () => {
    worldOf({ permissions: { modifyAllData: false } });

    const applied = await run(line('apply', '--yes', '--json'));

    expect(applied.code).toBe(1);
    const result = envRunResultSchema.parse(applied.answer) as EnvRunResult;
    expect(result.plan.checkpoints?.[0]?.refusal?.code).toBe('PERMISSIONS');
    expect(result.refusal).toContain(
      "The checkpoint the file asks once applied, 'baseline', would be refused: A checkpoint needs a user with View All Data and Modify All Data",
    );
    expect(world.records('Account')).toEqual([]);
    expect(
      world.calls.filter((c) => c.script === 'sandforge-seed' && !c.args.includes('--dry-run')),
    ).toEqual([]);
  });
});

describe('checkpoint.before, and destroy --rewind', () => {
  /** A record the org held before the environment, as a sandbox holds a team's own. */
  const BEFORE_ID = '001000000000500AAA';

  beforeEach(() => {
    writeFile(file({ before: true }));
    vi.setSystemTime(T0 - 3_600_000);
    world.org.add('Account', { Id: BEFORE_ID, Name: 'There before' });
    vi.setSystemTime(T0);
  });

  it('takes the checkpoint before the first write, and destroy --rewind returns the org to it, whoever changed what since', async () => {
    const applied = await run(line('apply', '--yes', '--json'));
    expect(applied.code, applied.said).toBe(0);
    const takes = world.calls.findIndex(
      (c) =>
        c.script === 'sandforge-checkpoint' &&
        c.args[0] === 'take' &&
        !c.args.includes('--estimate'),
    );
    const writesAt = world.calls.findIndex(
      (c) => c.script === 'sandforge-seed' && !c.args.includes('--dry-run'),
    );
    expect(takes).toBeGreaterThan(-1);
    expect(takes).toBeLessThan(writesAt);
    const before = (await stateNow())?.checkpoints?.before;
    expect(before).toMatch(/^ck-/);

    world.org.edit('Account', BEFORE_ID, { Name: 'Changed by a colleague' }, COLLEAGUE);
    world.org.add('Account', {
      Id: '001000000000777AAA',
      Name: 'Made by a test',
      CreatedById: COLLEAGUE,
      LastModifiedById: COLLEAGUE,
    });

    const destroyed = await run(line('destroy', '--rewind', '--yes', '--json'));

    expect(destroyed.code, destroyed.said).toBe(0);
    expect(world.records('Account').map((r) => [r['Id'], r['Name']])).toEqual([
      [BEFORE_ID, 'There before'],
    ]);
    const answer = envRewindResultSchema.parse(destroyed.answer) as EnvRewindResult;
    expect(answer).toMatchObject({
      verb: 'destroy',
      checkpoint: { step: 'before', id: before },
      status: 'success',
      undo: { offered: false },
    });
    expect(destroyed.said).toContain(
      'no undo: the environment’s checkpoints are deleted with it, the journal of this rewind among them: a destroy is undone by applying again',
    );
    const state = await stateNow();
    expect(state?.resources['accounts']?.status).toBe('destroyed');
    expect(state?.resources['accounts']?.runs.every((r) => r.takenBack === true)).toBe(true);
    expect(state?.checkpoints).toBeUndefined();
    expect(checkpointsKept()).toEqual([]);

    // Applied again, it starts over: a new checkpoint before its first write.
    const again = await run(line('apply', '--yes'));
    expect(again.code, again.said).toBe(0);
    expect((await stateNow())?.checkpoints?.before).toMatch(/^ck-/);
    expect(world.records('Account')).toHaveLength(3);
  });

  it('asks for the alias before it rewinds, naming who last changed what and that it is not undone', async () => {
    runner = runnerWithCheckpoints(world, {
      locksDir,
      users: { [COLLEAGUE]: 'Colleague' },
      tick: () => vi.setSystemTime(Date.now() + 30_000),
    });
    await run(line('apply', '--yes'));
    world.org.edit('Account', BEFORE_ID, { Name: 'Changed by a colleague' }, COLLEAGUE);
    const asked: string[] = [];

    const declined = await run(line('destroy', '--rewind'), {
      ask: async (question) => {
        asked.push(question);
        return 'pool';
      },
    });

    expect(declined.code).toBe(1);
    expect(asked[0]).toContain('Type POOL to rewind it to before pool was first applied:');
    expect(asked[0]).toContain('last changed by');
    expect(asked[0]).toContain('Colleague 1');
    expect(asked[0]).toContain(
      "the environment's checkpoints are then deleted, and this is not undone:",
    );
    expect(world.records('Account').map((r) => r['Name'])).toContain('Changed by a colleague');
  });

  it('takes no checkpoint before an apply when the org holds what an earlier one wrote without it, and says why', async () => {
    writeFile(file());
    await run(line('apply', '--yes'));
    // Asked now, of an apply that writes: a rewind to it would keep the records already there.
    const edited = file({ before: true }) as {
      resources: { accounts: { objects: Array<{ count: number }> } };
    };
    const [accounts] = edited.resources.accounts.objects;
    if (accounts) accounts.count = 3;
    writeFile(edited);

    const planned = await run(line('plan', '--json'));

    const plan = envPlanSchema.parse(planned.answer) as EnvPlan;
    expect(plan.actions.map((a) => a.action)).toEqual(['replace']);
    expect(plan.checkpoints).toBeUndefined();
    expect(plan.warnings).toEqual([
      expect.stringContaining(
        'checkpoint.before is taken before the first apply of an environment, and the org holds what an earlier apply wrote without one',
      ),
    ]);
    const calls = world.calls.length;
    expect((await run(line('apply', '--yes'))).code).toBe(0);
    expect(world.calls.slice(calls).filter((c) => c.script === 'sandforge-checkpoint')).toEqual([]);
    expect((await stateNow())?.checkpoints).toBeUndefined();
    const destroyed = await run(line('destroy', '--rewind', '--yes'));
    expect(destroyed.code).toBe(1);
    expect(destroyed.said).toContain('names no checkpoint taken before its first apply');
  });

  it('stops the apply before its first write when the take before it fails, nothing written', async () => {
    const real = runner;
    runner = async (script, args, signal) =>
      script === 'sandforge-checkpoint' && args[0] === 'take' && !args.includes('--estimate')
        ? {
            code: 1,
            stdout: JSON.stringify({
              refusal: { code: 'RUN_WRITING', message: 'A run writes to the org.' },
            }),
            stderr: '',
          }
        : real(script, args, signal);

    const applied = await run(line('apply', '--yes', '--json'));

    expect(applied.code).toBe(1);
    const result = envRunResultSchema.parse(applied.answer) as EnvRunResult;
    expect(result.refusal).toBe(
      "The checkpoint before the first write, 'pool before', was not taken (RUN_WRITING: A run writes to the org.). Nothing was written.",
    );
    expect(result.steps).toEqual([]);
    expect(world.records('Account').map((r) => r['Id'])).toEqual([BEFORE_ID]);
  });

  it('refuses on the line a rewind given the switches of a removal, and an acceptance of a rewind without it', async () => {
    const changed = await run(line('destroy', '--rewind', '--include-changed', '--yes'));
    const noUndo = await run(line('destroy', '--accept-no-undo', '--yes'));
    const unseen = await run(line('destroy', '--accept-unseen', '--yes'));

    expect(changed.code).toBe(2);
    expect(changed.said).toContain('--include-changed take back records by removal');
    expect(noUndo.code).toBe(2);
    expect(noUndo.said).toContain('--accept-no-undo goes with --rewind');
    expect(unseen.code).toBe(2);
    expect(unseen.said).toContain('--accept-unseen goes with --rewind');
  });
});

describe('a destroy, and the checkpoints', () => {
  it('deletes the environment’s checkpoints once every record is taken back, and keeps them while records are left', async () => {
    writeFile(file({ before: true, after: 'baseline' }));
    await run(line('apply', '--yes'));
    expect(checkpointsKept()).toHaveLength(2);
    const [first] = world.records('Account');
    world.org.edit('Account', String(first?.['Id']), { Name: 'Renamed by a test' }, COLLEAGUE);

    const partial = await run(line('destroy', '--yes', '--json'));
    expect(partial.code, partial.said).toBe(3);
    expect(checkpointsKept()).toHaveLength(2);
    expect((await stateNow())?.checkpoints).toMatchObject({ before: expect.any(String) });

    const whole = await run(line('destroy', '--yes', '--include-changed', '--json'));

    expect(whole.code, whole.said).toBe(0);
    const result = envRunResultSchema.parse(whole.answer) as EnvRunResult;
    expect(result.checkpoints?.map((c) => [c.step, c.exitCode])).toEqual([
      ['delete', 0],
      ['delete', 0],
    ]);
    expect(checkpointsKept()).toEqual([]);
    expect((await stateNow())?.checkpoints).toBeUndefined();
  });
});
