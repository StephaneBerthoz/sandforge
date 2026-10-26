import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envOutputSchema,
  envPlanSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
  envValidationSchema,
  type EnvPlan,
} from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../src/modules/forge/RunVerifier.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/RunVerifier.js')>()),
  verifiedOrg: vi.fn(),
}));

import type { CommandRunner } from './scriptRunner.js';
import { makeConn } from './sfSession.js';
import { EnvWorld } from './testing/envWorld.js';
import { openEnvStore } from './env/envState.js';
import { main, type EnvCliDeps } from './sandforge-env.js';

/*
 * Forge resources on the command line, on the memory orgs: each verb run as
 * a terminal or a CI step runs it, its scripts `sandforge-clone`'s and
 * `sandforge-seed`'s own `main` in this process, the clone reading a memory
 * source org and writing the memory target. Every `--json` answer is read
 * with the contract's own schema.
 */

const ORG_ID = '00D000000000009FAA';
const SOURCE_ID = '00D000000000008FAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const MARK = 'SFENV forge';

/** A file cloning the marked accounts and the contacts under them, from the uat role. */
function file(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'clone-flow',
    orgs: { uat: { alias: 'SRC' } },
    resources: {
      cloned: {
        kind: 'forge',
        source: 'uat',
        tables: [
          { object: 'Account', where: `Name = '${MARK}'` },
          { object: 'Contact', where: `LastName = '${MARK}'` },
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
let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;

/** The source's marked accounts, a contact under each, and a record of its own. */
function seedTheSource(accounts = 2): void {
  world.seedSource(
    'Account',
    Array.from({ length: accounts }, () => ({ Name: MARK })),
  );
  world.seedSource('Account', [{ Name: 'Not marked' }]);
  for (const account of world.source?.all('Account') ?? []) {
    if (account['Name'] !== MARK) continue;
    world.seedSource('Contact', [{ LastName: MARK, AccountId: account.Id }]);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-forge-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  fileOf = join(project, 'sandforge.yaml');
  writeFileSync(fileOf, JSON.stringify(file(), null, 2));
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: false,
    edition: 'Developer Edition',
    source: { alias: 'SRC', organizationId: SOURCE_ID },
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
  seedTheSource();
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
  runner: world.runner,
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

/** The records of the target named as the source's marked ones are. */
const marked = (object: string): Array<Record<string, unknown>> =>
  world.records(object).filter((row) => row['Name'] === MARK || row['LastName'] === MARK);

/** The state of the file on the target, as this machine keeps it. */
async function stateOf() {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if (!('store' in opened)) throw new Error(opened.refusal);
  return opened.store.read(ORG_ID, 'clone-flow');
}

/** What a plan says, read with the contract's schema. */
async function plan(...flags: string[]): Promise<{ code: number; plan: EnvPlan; said: string }> {
  const ran = await run(['plan', '--org', 'TGT', '--json', ...flags]);
  return { code: ran.code, plan: envPlanSchema.parse(ran.answer), said: ran.said };
}

describe('validate a forge resource', () => {
  it('checks it offline: its source a role of the file, what it clones named, nothing counted', async () => {
    const { code, answer } = await run(['validate', '--json']);

    expect(code).toBe(0);
    expect(envValidationSchema.parse(answer).resources).toEqual([
      {
        name: 'cloned',
        kind: 'forge',
        dependsOn: [],
        source: 'uat',
        objects: [{ object: 'Account' }, { object: 'Contact' }],
      },
    ]);
    expect(world.calls).toEqual([]);
  });

  it('says what it clones, and from which role, on the terminal', async () => {
    const { code } = await run(['validate']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(
      `  cloned: cloned from the uat org: tables Account WHERE Name = '${MARK}', Contact WHERE LastName = '${MARK}'`,
    );
  });
});

describe('plan and apply a forge resource', () => {
  it('plans what its dry run counts, per object, from the source its role names, and writes nothing', async () => {
    const { code, plan: planned } = await plan();

    expect(code).toBe(0);
    expect(planned.actions).toEqual([
      expect.objectContaining({
        resource: 'cloned',
        kind: 'forge',
        action: 'create',
        objects: [
          { object: 'Account', wouldCreate: 2 },
          { object: 'Contact', wouldCreate: 2 },
        ],
      }),
    ]);
    // The clone gives no estimate of its requests: the sum says it is short.
    expect(planned.gates.apiRequests.notCounted).toContain(
      'the requests of the run of cloned, which its script does not estimate',
    );
    expect(world.records('Account')).toEqual([]);
    expect(world.calls.map((call) => call.args.includes('--dry-run'))).toEqual([true]);
    expect(world.calls[0]?.args).toEqual(
      expect.arrayContaining(['--source', 'SRC', '--target', 'TGT', '--template']),
    );
  });

  it('applies it: the clone held to its dry run’s count, its summary beside the state, what it created verified', async () => {
    const { code, answer } = await run([
      'apply',
      '--org',
      'TGT',
      '--yes',
      '--json',
      '--accept-no-state',
    ]);

    expect(code, stderr.join('')).toBe(0);
    const result = envRunResultSchema.parse(answer);
    expect(result.status).toBe('success');
    expect(marked('Account')).toHaveLength(2);
    expect(marked('Contact')).toHaveLength(2);
    const accounts = new Set(marked('Account').map((row) => row['Id']));
    for (const contact of marked('Contact')) expect(accounts.has(contact['AccountId'])).toBe(true);
    // The source's own records stay where they are, and the one not marked is not cloned.
    expect(world.source?.all('Account')).toHaveLength(3);
    expect(world.records('Account').some((row) => row['Name'] === 'Not marked')).toBe(false);

    const runLine = world.calls.find(
      (call) => !call.args.includes('--dry-run') && call.args.includes('--summary'),
    )?.args;
    expect(runLine?.[runLine.indexOf('--max-total') + 1]).toBe('4');
    expect(world.calls.some((call) => call.args.includes('--verify'))).toBe(true);

    const state = await stateOf();
    const cloned = state?.resources['cloned'];
    expect(cloned).toMatchObject({ kind: 'forge', status: 'applied' });
    const runOf = cloned?.runs.at(-1);
    expect(runOf).toMatchObject({
      n: 1,
      script: 'sandforge-clone',
      summary: 'runs/cloned/1.summary.json',
      exitCode: 0,
      objects: [
        { objectApiName: 'Account', created: 2, refused: 0 },
        { objectApiName: 'Contact', created: 2, refused: 0 },
      ],
    });
    expect(runOf?.runId).toBeUndefined();
    const opened = openEnvStore({ journalDir, fileFolder: project });
    if (!('store' in opened)) throw new Error(opened.refusal);
    const summary = opened.store.fileOf(ORG_ID, 'clone-flow', 'runs/cloned/1.summary.json');
    expect(existsSync(summary)).toBe(true);
    expect(JSON.parse(readFileSync(summary, 'utf8'))).toMatchObject({ tool: 'sandforge-clone' });
  });

  it('output names the records the clone created in the target, by object, from its summary, reaching no org', async () => {
    await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);
    vi.mocked(makeConn).mockClear();
    const from = world.calls.length;

    const ran = await run(['output', '--org', 'TGT', '--json']);

    expect(ran.code, ran.said).toBe(0);
    const records = envOutputSchema.parse(ran.answer).resources['cloned']?.records ?? {};
    expect(new Set(records['Account'])).toEqual(new Set(marked('Account').map((row) => row['Id'])));
    expect(new Set(records['Contact'])).toEqual(new Set(marked('Contact').map((row) => row['Id'])));
    expect(records['Account']).toHaveLength(2);
    // None of the source's ids: the clone's remap table gives the target's.
    for (const source of world.source?.all('Account') ?? []) {
      expect(records['Account']).not.toContain(source['Id']);
    }
    expect(makeConn).not.toHaveBeenCalled();
    expect(world.calls.slice(from)).toEqual([]);
  });

  it('applied twice writes nothing the second time: a plan keeps it, the serial and the records unmoved', async () => {
    await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);
    const serial = (await stateOf())?.serial;
    const from = world.calls.length;

    const again = await plan('--fail-on-change');
    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json']);

    expect(again.code).toBe(0);
    expect(again.plan.actions.map((action) => action.action)).toEqual(['keep']);
    expect(applied.code).toBe(0);
    const writing = world.calls
      .slice(from)
      .filter((call) => !call.args.includes('--preview') && !call.args.includes('--dry-run'));
    expect(writing).toEqual([]);
    expect((await stateOf())?.serial).toBe(serial);
    expect(marked('Account')).toHaveLength(2);
  });

  it('holds a run to its plan’s count: a source that grew between the dry run and the run is refused, not written', async () => {
    // Three more marked accounts in the source once the dry run has counted it.
    const growing: CommandRunner = async (script, args, signal) => {
      const ran = await world.runner(script, args, signal);
      if (args.includes('--dry-run')) seedTheSource(3);
      return ran;
    };

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json', '--accept-no-state'], {
      runner: growing,
    });

    expect(applied.code).toBe(1);
    const result = envRunResultSchema.parse(applied.answer);
    // The clone's own refusal, which it says on stderr alone: live, the
    // apply's --json gave its exit code and no word of why.
    expect(result.steps).toEqual([
      expect.objectContaining({
        resource: 'cloned',
        phase: 'run',
        exitCode: 1,
        status: 'failed',
        refusal:
          'The run would write 12 records, more than --max-total 4: narrow the clone (--max, ' +
          '--exclude-object, --filter), or raise --max-total. Nothing was written.',
      }),
    ]);
    const runLine = world.calls.find((call) => call.args.includes('--summary'));
    expect(runLine?.args[runLine.args.indexOf('--max-total') + 1]).toBe('4');
    expect(runLine?.code).toBe(1);
    expect(world.records('Account')).toEqual([]);
    expect(world.records('Contact')).toEqual([]);
  });

  it('replaces it when what it clones changed in the file: its run taken back, then run again', async () => {
    await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);
    const first = marked('Account').map((row) => row['Id']);
    writeFileSync(
      fileOf,
      JSON.stringify(
        file({
          resources: {
            cloned: {
              kind: 'forge',
              source: 'uat',
              tables: [{ object: 'Account', where: `Name = '${MARK}'` }],
            },
          },
        }),
      ),
    );

    const replanned = await plan();
    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json']);

    expect(replanned.plan.actions[0]).toMatchObject({
      action: 'replace',
      why: 'replaced: what it writes changed in the file since it was applied',
    });
    expect(applied.code, applied.said).toBe(0);
    expect(marked('Contact')).toEqual([]);
    expect(marked('Account')).toHaveLength(2);
    expect(marked('Account').some((row) => first.includes(row['Id']))).toBe(false);
  });

  it('replaces it when its role points at another source org, and keeps it when the alias alone is renamed', async () => {
    await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);

    const renamed = await plan('--alias', 'uat=SRC');
    expect(renamed.plan.actions.map((action) => action.action)).toEqual(['keep']);

    const other = new EnvWorld({
      organizationId: ORG_ID,
      sandbox: false,
      edition: 'Developer Edition',
      source: { alias: 'SRC', organizationId: '00D000000000007FAA' },
    });
    // The same target: its records and state stay; the source is another org now.
    for (const object of ['Account', 'Contact']) {
      for (const row of world.records(object))
        other.org.add(object, { ...row, Id: String(row['Id']) });
    }
    world = other;
    seedTheSource();
    const moved = await plan();
    expect(moved.plan.actions[0]).toMatchObject({ action: 'replace' });
  });

  it('reads its drift: a cloned record deleted since is said, and plan --fail-on-drift exits 3', async () => {
    await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);
    const [contact] = marked('Contact');
    world.org.trash('Contact', String(contact?.['Id']), '005000000000009AAA');

    const drifted = await plan('--fail-on-drift');

    expect(drifted.code).toBe(3);
    expect(drifted.plan.actions[0]).toMatchObject({ action: 'drifted' });
    expect(drifted.plan.actions[0]?.why).toContain('Contact 1 gone');
  });

  it('takes it back with destroy, from the summary its run wrote: the target holds none of it after', async () => {
    await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);

    const destroyed = await run(['destroy', '--org', 'TGT', '--yes', '--json']);

    expect(destroyed.code, destroyed.said).toBe(0);
    expect(world.records('Account')).toEqual([]);
    expect(world.records('Contact')).toEqual([]);
    expect((await stateOf())?.resources['cloned']?.status).toBe('destroyed');
    const removal = world.calls.find(
      (call) => call.args.includes('--remove') && !call.args.includes('--preview'),
    );
    expect(removal?.script).toBe('sandforge-clone');
    expect(removal?.args[1]).toMatch(/runs[\\/]cloned[\\/]1\.summary\.json$/);
    // The destroy reads no source: what it takes back is what the state names.
    expect(world.calls.filter((call) => call.args.includes('--dry-run'))).toHaveLength(1);
  });

  it('leaves a run partial when its verification finds what it created not all there', async () => {
    const losing: CommandRunner = async (script, args, signal) => {
      if (args.includes('--verify')) {
        const [contact] = marked('Contact');
        world.org.trash('Contact', String(contact?.['Id']), '005000000000009AAA');
      }
      return world.runner(script, args, signal);
    };

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json', '--accept-no-state'], {
      runner: losing,
    });

    expect(applied.code).toBe(3);
    const step = envRunResultSchema.parse(applied.answer).steps.at(-1);
    expect(step).toMatchObject({ status: 'partial', exitCode: 0 });
    expect(step?.objects[0]?.reason).toBe('its verification found Contact 1 of 2 not there');
    expect((await stateOf())?.resources['cloned']?.status).toBe('partial');
  });

  it('stops the apply on a verification whose readings never agreed, exit 4', async () => {
    const unstable: CommandRunner = async (script, args, signal) => {
      const ran = await world.runner(script, args, signal);
      if (!args.includes('--verify')) return ran;
      const answer = JSON.parse(ran.stdout) as { result: { verdict: string } };
      answer.result.verdict = 'unstable';
      return { ...ran, code: 4, stdout: JSON.stringify(answer) };
    };

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json', '--accept-no-state'], {
      runner: unstable,
    });

    expect(applied.code).toBe(4);
    expect((await stateOf())?.resources['cloned']?.status).toBe('partial');
  });

  it('takes up a run stopped part way from its summary: the next apply takes it back and runs it whole', async () => {
    let stopped = false;
    const stopping: CommandRunner = async (script, args, signal) => {
      if (!stopped && args.includes('--summary')) {
        stopped = true;
        // The clone stopped after its accounts, as a SIGTERM stops it: its
        // summary says what it had created.
        world.onCreate = (object) => {
          if (object === 'Contact') process.emit('SIGTERM');
        };
      }
      try {
        return await world.runner(script, args, signal);
      } finally {
        world.onCreate = undefined;
      }
    };

    const first = await run(['apply', '--org', 'TGT', '--yes', '--json', '--accept-no-state'], {
      runner: stopping,
    });
    const state = await stateOf();
    const again = await run(['apply', '--org', 'TGT', '--yes', '--json']);

    expect(first.code).toBe(143);
    expect(state?.resources['cloned']?.status).toBe('applying');
    expect(again.code, again.said).toBe(0);
    expect(marked('Account')).toHaveLength(2);
    expect(marked('Contact')).toHaveLength(2);
  });
});

describe('a forge resource of one record', () => {
  /** A file cloning the one account a query names, and what hangs from it. */
  const recordFile = (where: string): Record<string, unknown> =>
    file({
      resources: {
        one: {
          kind: 'forge',
          source: 'uat',
          record: { object: 'Account', where },
          depth: 'direct',
        },
      },
    });

  it('clones the one row its query answers on the source, read at the plan, and what hangs from it', async () => {
    world.seedSource('Account', [{ Name: 'SFENV one' }]);
    const [one] = (world.source?.all('Account') ?? []).filter((row) => row['Name'] === 'SFENV one');
    world.seedSource('Contact', [{ LastName: MARK, AccountId: one?.Id }]);
    writeFileSync(fileOf, JSON.stringify(recordFile("Name = 'SFENV one'")));

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json', '--accept-no-state']);

    expect(applied.code, applied.said).toBe(0);
    expect(world.records('Account').map((row) => row['Name'])).toEqual(['SFENV one']);
    expect(marked('Contact')).toHaveLength(1);
    const runLine = world.calls.find((call) => call.args.includes('--summary'))?.args ?? [];
    expect(runLine[runLine.indexOf('--record') + 1]).toBe(one?.Id);
  });

  it('blocks it when its query answers no row, or more than one, saying how many', async () => {
    writeFileSync(fileOf, JSON.stringify(recordFile("Name = 'Nobody'")));
    const none = await plan();
    writeFileSync(fileOf, JSON.stringify(recordFile(`Name = '${MARK}'`)));
    const two = await plan();

    expect(none.plan.actions[0]).toMatchObject({ action: 'blocked' });
    expect(none.plan.actions[0]?.refusal).toBe(
      "its record query finds no Account in the uat org (SRC) (WHERE Name = 'Nobody'): a record " +
        'named by a query is one its source answers with exactly one row',
    );
    expect(two.plan.actions[0]?.refusal).toBe(
      `its record query finds 2 Account records in the uat org (SRC) (WHERE Name = '${MARK}'), not ` +
        'one: narrow the where to one row, or name the record by its id',
    );
    expect(world.calls.filter((call) => call.args.includes('--dry-run'))).toEqual([]);
  });

  it('refuses a source that is the org to fill: a clone reads one org and writes another', async () => {
    writeFileSync(fileOf, JSON.stringify(file()));

    const refused = await plan('--alias', 'uat=TGT');

    expect(refused.plan.actions[0]?.refusal).toBe(
      'its source, the uat org (TGT), is the org to fill: a clone reads one org and writes another',
    );
    const applied = await run([
      'apply',
      '--org',
      'TGT',
      '--yes',
      '--json',
      '--accept-no-state',
      '--alias',
      'uat=TGT',
    ]);
    expect(applied.code).toBe(1);
    expect(world.records('Account')).toEqual([]);
  });

  it('refuses the verbs that reach an org when its role’s variable is not set, naming it', async () => {
    writeFileSync(
      fileOf,
      JSON.stringify(file({ orgs: { uat: { alias: { env: 'SFENV_UNSET_UAT' } } } })),
    );

    const refused = await run(['plan', '--org', 'TGT', '--json']);

    expect(refused.code).toBe(2);
    expect(envRefusalAnswerSchema.parse(refused.answer).refusal.message).toContain(
      'the variable SFENV_UNSET_UAT is not set',
    );
    expect(world.calls).toEqual([]);
  });
});

describe('a forge resource with a template of the project', () => {
  it('runs the template’s choices with its own: an object the template leaves out is not cloned', async () => {
    const templates = join(project, '.sandforge', 'forge-templates.json');
    mkdirSync(join(project, '.sandforge'), { recursive: true });
    writeFileSync(
      templates,
      JSON.stringify([
        {
          id: 'accounts-alone',
          name: 'Accounts alone',
          description: '',
          config: {
            inputMode: 'soql',
            soqlQuery: 'SELECT Id FROM Account',
            depth: 'direct',
            anonymizePII: false,
            skipEmpty: true,
            batchSize: 'auto',
            fieldExclusions: { Contact: ['AccountId'] },
          },
          objectCount: 2,
          recordCount: 4,
          createdAt: '2026-10-01T09:00:00.000Z',
          lastUsedAt: '2026-10-01T09:00:00.000Z',
        },
      ]),
    );
    const resource = (file()['resources'] as Record<string, Record<string, unknown>>)['cloned'];
    writeFileSync(
      fileOf,
      JSON.stringify(
        file({
          resources: {
            cloned: {
              ...resource,
              template: { file: '.sandforge/forge-templates.json', id: 'accounts-alone' },
            },
          },
        }),
      ),
    );

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json', '--accept-no-state']);

    expect(applied.code, applied.said).toBe(0);
    // The template left the contacts' account out: cloned, they hang from none.
    expect(marked('Contact').map((row) => row['AccountId'])).toEqual([undefined, undefined]);
  });

  it('refuses a template the file names and its templates file does not hold, naming those it holds', async () => {
    mkdirSync(join(project, '.sandforge'), { recursive: true });
    writeFileSync(
      join(project, '.sandforge', 'forge-templates.json'),
      JSON.stringify([{ id: 'other' }]),
    );
    const resource = (file()['resources'] as Record<string, Record<string, unknown>>)['cloned'];
    writeFileSync(
      fileOf,
      JSON.stringify(
        file({
          resources: {
            cloned: {
              ...resource,
              template: { file: '.sandforge/forge-templates.json', id: 'none' },
            },
          },
        }),
      ),
    );

    const { code, answer } = await run(['validate', '--json']);

    expect(code).toBe(2);
    expect(envValidationSchema.parse(answer).issues).toEqual([
      {
        path: 'resources.cloned.template',
        resource: 'cloned',
        message: '.sandforge/forge-templates.json holds no template "none": it holds other',
      },
    ]);
  });
});

describe('a forge resource whose source is a production org', () => {
  /** The source answers as a production org, as its Organization record says one is. */
  function sourceIsProduction(): void {
    const made = vi.mocked(makeConn).getMockImplementation();
    vi.mocked(makeConn).mockImplementation((session) => {
      const conn = made?.(session) as unknown as {
        query: (soql: string) => Promise<unknown>;
      };
      if (session.alias !== 'SRC') return conn as never;
      return {
        ...conn,
        query: async (soql: string) =>
          /FROM Organization/.test(soql)
            ? {
                totalSize: 1,
                done: true,
                records: [
                  { Id: SOURCE_ID, IsSandbox: false, OrganizationType: 'Enterprise Edition' },
                ],
              }
            : conn.query(soql),
      } as never;
    });
  }
  const resource = (over: Record<string, unknown>) => ({
    resources: {
      cloned: {
        ...(file()['resources'] as Record<string, Record<string, unknown>>)['cloned'],
        ...over,
      },
    },
  });

  it('blocks it without anonymize or accept: { realData: true }, naming both, and the apply writes nothing', async () => {
    sourceIsProduction();

    const { code, plan: planned, said } = await plan();

    expect(code).toBe(0);
    expect(planned.actions[0]).toMatchObject({ resource: 'cloned', action: 'blocked' });
    expect(planned.actions[0]?.refusal).toContain(
      'is a production org (its Organization record says IsSandbox false, edition Enterprise Edition): what it clones is real people’s data',
    );
    expect(said).toContain('or, reviewed in the file, accept: { realData: true }');
    // Not dry-run: a clone the plan refuses reads nothing of production.
    expect(world.calls).toEqual([]);

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);
    expect(applied.code).toBe(1);
    expect(marked('Account')).toEqual([]);
  });

  it('clones it once the file accepts real data, the plan saying so and that contact points are neutralized', async () => {
    sourceIsProduction();
    writeFileSync(fileOf, JSON.stringify(file(resource({ accept: { realData: true } }))));

    const { plan: planned, said } = await plan();

    expect(planned.actions[0]).toMatchObject({ action: 'create' });
    expect(planned.actions[0]?.notes).toEqual([
      'real data: its source, the uat org (SRC), is a production org; what it clones is written as read, as the file accepts (accept: { realData: true })',
      'contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range), as the clone does unless keepContactPoints',
    ]);
    expect(said).toContain(
      '           real data: its source, the uat org (SRC), is a production org',
    );
    const applied = await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state']);
    expect(applied.code, applied.said).toBe(0);
    expect(marked('Account')).toHaveLength(2);
  });

  it('clones it anonymized when the resource anonymizes, and says nothing of real data from a source that is no production org', async () => {
    sourceIsProduction();
    writeFileSync(
      fileOf,
      JSON.stringify(file(resource({ anonymize: { rules: { name: 'fake' } } }))),
    );
    const anonymized = await plan();
    expect(anonymized.plan.actions[0]?.action).toBe('create');
    expect(anonymized.plan.actions[0]?.notes?.[0]).toContain(
      'what it clones is anonymized as its anonymize says (name fake)',
    );

    writeFileSync(fileOf, JSON.stringify(file()));
    vi.mocked(makeConn).mockReset();
    world = new EnvWorld({
      organizationId: ORG_ID,
      sandbox: false,
      edition: 'Developer Edition',
      source: { alias: 'SRC', organizationId: SOURCE_ID },
      tick: () => vi.setSystemTime(Date.now() + 30_000),
    });
    seedTheSource();
    const sandbox = await plan();
    expect(sandbox.plan.actions[0]).toMatchObject({ action: 'create' });
    expect(sandbox.plan.actions[0]?.notes).toBeUndefined();
  });
});
