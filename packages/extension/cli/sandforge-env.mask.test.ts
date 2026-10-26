import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envOutputSchema,
  envPlanSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
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
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { OUTPUT_MASK_DESTROYED_WHY, OUTPUT_MASK_WHY } from './env/envOutput.js';
import { openEnvStore } from './env/envState.js';
import type { CommandRunner } from './scriptRunner.js';
import { missingFieldLine } from './sandforge-dataops.js';
import { main, type EnvCliDeps } from './sandforge-env.js';
import { EnvWorld, type EnvWorldOptions } from './testing/envWorld.js';

/*
 * Mask resources on the command line, on the memory org: each verb run as a
 * terminal or a CI step runs it, its masking `sandforge-dataops`'s own `main`
 * in this process, through the DataOps panel's own handler, which counts,
 * takes its snapshot of and writes over the records a sandbox copied from
 * production holds. Every `--json` answer is read with the contract's own
 * schema; what is masked is read in the org, never taken from what a script
 * said.
 */

const ORG_ID = '00D000000000009MAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const ENV = 'uat-masked';

let dir: string;
let project: string;
let journalDir: string;
let locksDir: string;
let journalBefore: string | undefined;
let world: EnvWorld;
let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;
/** The contacts copied in from production, by id, and the one of the org's own. */
let copied: string[];
let own: string;

/** The rules a set holds by default: the email made up again, the phone masked. */
const RULES = [
  { fieldPattern: 'Contact.Email', ruleType: 'fake' },
  { fieldPattern: 'Contact.Phone', ruleType: 'mask', config: { maskKeepLast: 2 } },
];

/** The file: the copied contacts masked by a set of the file's. */
function file(
  resource: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
  rules: unknown[] = RULES,
) {
  return {
    version: 1,
    name: ENV,
    masking: { 'contact-points': { rules } },
    resources: {
      customers: {
        kind: 'mask',
        rules: 'contact-points',
        object: 'Contact',
        where: "LastName = 'Copied'",
        ...resource,
      },
    },
    ...over,
  };
}

function writeFile(document: unknown): void {
  writeFileSync(join(project, 'sandforge.yaml'), JSON.stringify(document, null, 2));
}

/** A new world, the records a sandbox copied from production holds in it. */
function worldOf(options: EnvWorldOptions = { sandbox: true, scratch: true }): void {
  world = new EnvWorld({
    organizationId: ORG_ID,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
    ...options,
  });
  copied = world.copyIn('Contact', [
    { LastName: 'Copied', Email: 'ada@example.com', Phone: '+33 1 00 00 00 01' },
    { LastName: 'Copied', Email: 'grace@example.com', Phone: '+33 1 00 00 00 02' },
  ]);
  [own] = world.copyIn('Contact', [{ LastName: 'Own', Email: 'own@example.com' }]) as [string];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-mask-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFile(file());
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

async function plan(...flags: string[]): Promise<{ code: number; plan: EnvPlan; said: string }> {
  const ran = await run(['plan', '--org', 'TGT', '--json', ...flags]);
  return { code: ran.code, plan: envPlanSchema.parse(ran.answer), said: ran.said };
}

async function apply(...flags: string[]) {
  const ran = await run(['apply', '--org', 'TGT', '--yes', '--json', ...flags]);
  return { ...ran, result: envRunResultSchema.parse(ran.answer) };
}

async function destroy(...flags: string[]) {
  const ran = await run(['destroy', '--org', 'TGT', '--yes', '--json', ...flags]);
  return { ...ran, result: envRunResultSchema.parse(ran.answer) };
}

async function stateOf() {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if (!('store' in opened)) throw new Error(opened.refusal);
  return { store: opened.store, state: await opened.store.read(ORG_ID, ENV) };
}

/** Where a resource's DataOps store is kept, beside the state. */
async function storeDirOf(resource = 'customers'): Promise<string> {
  return (await stateOf()).store.sasOf(ORG_ID, ENV, `dataops/${resource}`);
}

/** The snapshots a store lists, by the keys its metadata is kept under. */
function snapshotsIn(store: string): string[] {
  const file = join(store, 'snapshots.json');
  if (!existsSync(file)) return [];
  return Object.keys(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    .filter((key) => key.startsWith('backup:') && !key.slice('backup:'.length).includes(':'))
    .map((key) => key.slice('backup:'.length));
}

/** A contact's field, read in the org. */
const fieldOf = (id: string | undefined, field: string): unknown =>
  world.records('Contact').find((row) => row.Id === id)?.[field];

/** The lines `sandforge-dataops` was run with that write: neither a dry run nor anything else. */
const maskings = (): string[][] =>
  world.calls
    .filter((call) => call.script === 'sandforge-dataops' && !call.args.includes('--dry-run'))
    .map((call) => call.args);

describe('a mask resource', () => {
  it('plans the records its condition selects through the script’s own dry run, and writes nothing', async () => {
    const before = JSON.stringify(world.records('Contact'));

    const { code, plan: planned } = await plan();

    expect(code).toBe(0);
    expect(planned.actions).toEqual([
      expect.objectContaining({
        resource: 'customers',
        kind: 'mask',
        action: 'create',
        objects: [{ object: 'Contact', wouldCreate: 2 }],
        notes: [expect.stringContaining('masking is one-way')],
      }),
    ]);
    expect(planned.actions[0]?.notes?.[0]).toContain(
      'sandforge-dataops anonymize --org TGT --restore <the snapshot its run names> ' +
        `--store ${await storeDirOf()}`,
    );
    expect(planned.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('the emails the org sends as the records of customers are masked'),
      ]),
    );
    expect(JSON.stringify(world.records('Contact'))).toBe(before);
    expect(maskings()).toEqual([]);
    // Its dry run kept nothing beside the state, which no plan writes.
    expect(existsSync(await storeDirOf())).toBe(false);
    expect((await stateOf()).state).toBeUndefined();
  });

  it('masks after a snapshot of what it writes over, the state keeping the snapshot’s id, and leaves the others as they were', async () => {
    const applied = await apply();

    expect(applied.code, applied.said).toBe(0);
    for (const id of copied) expect(fieldOf(id, 'Email')).toMatch(/@/);
    expect(fieldOf(copied[0], 'Email')).not.toBe('ada@example.com');
    expect(fieldOf(copied[1], 'Email')).not.toBe('grace@example.com');
    expect(fieldOf(copied[0], 'Phone')).toMatch(/01$/);
    expect(fieldOf(copied[0], 'Phone')).not.toBe('+33 1 00 00 00 01');
    expect(fieldOf(own, 'Email')).toBe('own@example.com');

    const run = (await stateOf()).state?.resources['customers']?.runs[0];
    expect(run).toMatchObject({
      script: 'sandforge-dataops',
      exitCode: 0,
      objects: [{ objectApiName: 'Contact', created: 0, refused: 0, masked: 2 }],
    });
    expect(run?.snapshotId).toMatch(/-snapshot$/);
    expect(snapshotsIn(await storeDirOf())).toEqual([run?.snapshotId]);
    expect(applied.result.steps).toEqual([
      expect.objectContaining({
        resource: 'customers',
        phase: 'run',
        script: 'sandforge-dataops',
        status: 'applied',
        objects: [
          expect.objectContaining({
            object: 'Contact',
            created: 0,
            masked: 2,
            reason: `snapshot ${run?.snapshotId} of the values it wrote over, taken first, kept on this machine until destroy deletes it`,
          }),
        ],
      }),
    ]);
    // The rules it was given, in the store of the resource, the line naming both.
    expect(maskings()).toEqual([
      expect.arrayContaining(['--rules', '--store', await storeDirOf(), '--yes', '--json']),
    ]);
  });

  it('carries a masking the script refused before its first write into the step, in the words it said on stderr', async () => {
    // A store that cannot be opened: the script refuses before it reads a record.
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, '');
    const storeless: CommandRunner = async (script, args, signal) => {
      if (script !== 'sandforge-dataops' || args.includes('--dry-run')) {
        return world.runner(script, args, signal);
      }
      const line = [...args];
      line[args.indexOf('--store') + 1] = blocked;
      return world.runner(script, line, signal);
    };

    const ran = await run(['apply', '--org', 'TGT', '--yes', '--json'], { runner: storeless });

    expect(ran.code).toBe(1);
    const [step] = envRunResultSchema.parse(ran.answer).steps;
    expect(step).toMatchObject({ resource: 'customers', exitCode: 1, status: 'failed' });
    expect(step?.answer).toBeUndefined();
    // Refused by mkdir on every platform, or by the folder check where one would let it by.
    expect(step?.refusal).toMatch(
      /^The store .+not-a-folder (?:could not be made: |is not a folder\.)/,
    );
    expect(fieldOf(copied[0], 'Email')).toBe('ada@example.com');
  });

  it('keeps a masking applied with the same rules over the same records: applied again, it masks nothing twice', async () => {
    await apply();
    const serial = (await stateOf()).state?.serial;
    const masked = JSON.stringify(world.records('Contact'));
    const from = world.calls.length;

    const { code, plan: planned } = await plan('--fail-on-change', '--fail-on-drift');
    const again = await apply();

    expect(code).toBe(0);
    expect(planned.actions[0]).toMatchObject({
      action: 'keep',
      objects: [{ object: 'Contact', present: 2 }],
      why: 'applied, and its condition selects the 2 record(s) it masked, with the same rules: masked again they would only be masked twice',
    });
    expect(again.code).toBe(0);
    expect(world.calls.slice(from).filter((call) => !call.args.includes('--dry-run'))).toEqual([]);
    expect((await stateOf()).state?.serial).toBe(serial);
    expect(JSON.stringify(world.records('Contact'))).toBe(masked);
  });

  it('says drift once its condition selects records copied in since, and --replace-drifted masks them, the first snapshot kept', async () => {
    await apply();
    const first = (await stateOf()).state?.resources['customers']?.runs[0]?.snapshotId;
    const [late] = world.copyIn('Contact', [{ LastName: 'Copied', Email: 'late@example.com' }]);

    const drifted = await plan('--fail-on-drift');
    expect(drifted.code).toBe(3);
    expect(drifted.plan.actions[0]).toMatchObject({
      action: 'drifted',
      objects: [{ object: 'Contact', present: 2 }],
      why:
        'its condition selects other records than it masked: Contact 3 under its condition, 2 ' +
        'masked: 1 more, which hold their original values. Left as they are: --replace ' +
        'customers or --replace-drifted masks them all again',
    });
    // Negative control: left drifted, an apply writes nothing.
    expect((await apply()).code).toBe(0);
    expect(fieldOf(late, 'Email')).toBe('late@example.com');

    const replaced = await apply('--replace-drifted');
    expect(replaced.code, replaced.said).toBe(0);
    expect(replaced.result.plan.actions[0]?.why).toContain(
      `the values they held before any masking stay only in snapshot ${first}, run 1's, which destroy deletes`,
    );
    expect(fieldOf(late, 'Email')).not.toBe('late@example.com');
    const runs = (await stateOf()).state?.resources['customers']?.runs ?? [];
    expect(runs.map((run) => run.objects[0]?.masked)).toEqual([2, 3]);
    // Nothing is taken back first: the first snapshot stays, the second beside it.
    expect(snapshotsIn(await storeDirOf()).sort()).toEqual(
      runs.map((run) => run.snapshotId).sort(),
    );
    expect(runs.every((run) => run.takenBack === undefined)).toBe(true);
  });

  it('replaces a masking whose rules changed, saying what a replace keeps', async () => {
    await apply();
    writeFile(file({}, {}, [...RULES, { fieldPattern: 'Contact.LastName', ruleType: 'fake' }]));

    const { plan: planned } = await plan();

    expect(planned.actions[0]).toMatchObject({ action: 'replace', objects: [{ wouldCreate: 2 }] });
    expect(planned.actions[0]?.why).toMatch(
      /^replaced: what it writes changed in the file since it was applied; it masks again what its condition selects, the records it masked before a second time, and takes nothing back first: the values they held before any masking stay only in snapshot \S+-snapshot, run 1's, which destroy deletes$/,
    );
  });

  it('output names no record of a masking, which creates none: what it masked and its snapshot, then that a destroy left them masked', async () => {
    await apply();
    const snapshot = (await stateOf()).state?.resources['customers']?.runs[0]?.snapshotId;

    const applied = await run(['output', '--org', 'TGT', '--json']);

    expect(applied.code).toBe(0);
    expect(envOutputSchema.parse(applied.answer).resources['customers']).toEqual({
      kind: 'mask',
      status: 'applied',
      run: 1,
      records: {},
      masked: { Contact: 2 },
      snapshotId: snapshot,
      why: OUTPUT_MASK_WHY,
    });

    await destroy();
    const destroyed = await run(['output', '--org', 'TGT', '--json']);

    expect(destroyed.code).toBe(0);
    expect(envOutputSchema.parse(destroyed.answer).resources['customers']).toEqual({
      kind: 'mask',
      status: 'destroyed',
      run: 1,
      records: {},
      why: OUTPUT_MASK_DESTROYED_WHY,
    });
  });

  it('never unmasks: destroy deletes its store, the snapshot with it, and leaves every masked value masked', async () => {
    await apply();
    const masked = JSON.stringify(world.records('Contact'));
    const store = await storeDirOf();
    const snapshot = (await stateOf()).state?.resources['customers']?.runs[0]?.snapshotId;
    expect(existsSync(store)).toBe(true);

    const destroyed = await destroy();

    expect(destroyed.code, destroyed.said).toBe(0);
    expect(destroyed.result.plan.actions[0]).toMatchObject({
      action: 'delete',
      kind: 'mask',
      objects: [{ object: 'Contact', present: 2 }],
    });
    expect(destroyed.result.plan.actions[0]?.why).toContain('destroy, which never unmasks');
    expect(destroyed.said).toContain(
      `customers: its records stay masked — destroy never unmasks —, and its snapshot ${snapshot}, the only copy of the values they held, deleted from this machine with its store`,
    );
    expect(existsSync(store)).toBe(false);
    expect(JSON.stringify(world.records('Contact'))).toBe(masked);
    expect(world.calls.some((call) => call.args.includes('--restore'))).toBe(false);
    const kept = (await stateOf()).state?.resources['customers'];
    expect(kept?.status).toBe('destroyed');
    expect(kept?.runs.every((run) => run.takenBack === true)).toBe(true);
    expect(destroyed.result.steps).toEqual([
      expect.objectContaining({
        phase: 'remove',
        script: 'sandforge-dataops',
        status: 'destroyed',
        objects: [expect.objectContaining({ object: 'Contact', deleted: 0, kept: 0, masked: 2 })],
      }),
    ]);
  });

  it('deletes with its store the snapshot of a masking stopped before it answered, which the state does not name', async () => {
    await apply();
    const store = await storeDirOf();
    // A second snapshot the state names not, as a masking killed after its snapshot leaves one.
    const meta = JSON.parse(readFileSync(join(store, 'snapshots.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const [key] = Object.keys(meta).filter((k) => k.endsWith('-snapshot'));
    meta['backup:cli-killed-snapshot'] = meta[key ?? ''];
    writeFileSync(join(store, 'snapshots.json'), JSON.stringify(meta));

    const destroyed = await destroy();

    expect(destroyed.code).toBe(0);
    expect(destroyed.said).toContain('cli-killed-snapshot');
    expect(existsSync(store)).toBe(false);
  });

  it('takes a mask resource out of the file as a destroy does: its store deleted, its records left masked', async () => {
    await apply();
    const masked = JSON.stringify(world.records('Contact'));
    writeFile({ version: 1, name: ENV, resources: {} });

    const { plan: planned } = await plan();
    const applied = await apply();

    expect(planned.actions[0]).toMatchObject({ action: 'delete', kind: 'mask' });
    expect(planned.actions[0]?.why).toContain('in the state, gone from the file');
    expect(applied.code, applied.said).toBe(0);
    expect(existsSync(await storeDirOf())).toBe(false);
    expect(JSON.stringify(world.records('Contact'))).toBe(masked);
  });

  it('applied again after a stopped masking masks what its condition selects, and destroy takes the stopped run’s snapshot too', async () => {
    let heard: ((signal: 'SIGTERM') => void) | undefined;
    world.onUpdate = () => {
      heard?.('SIGTERM');
      world.onUpdate = undefined;
    };
    const stopped = await run(['apply', '--org', 'TGT', '--yes', '--json'], {
      onStop: (hear) => {
        heard = hear;
        return () => {
          heard = undefined;
        };
      },
      // What the runner sends the script once the apply is stopped: SIGINT,
      // which the script, in this process, hears as its own.
      runner: async (script, args, signal) => {
        const interrupt = (): void => {
          process.emit('SIGINT');
        };
        signal.addEventListener('abort', interrupt, { once: true });
        try {
          return await world.runner(script, args, signal);
        } finally {
          signal.removeEventListener('abort', interrupt);
        }
      },
    });
    expect(stopped.code).toBe(143);
    expect((await stateOf()).state?.resources['customers']?.status).toBe('applying');

    const { plan: planned } = await plan();
    expect(planned.actions[0]?.why).toContain('its last masking was stopped part way');
    const again = await apply();
    expect(again.code, again.said).toBe(0);
    expect(fieldOf(copied[1], 'Email')).not.toBe('grace@example.com');

    const store = await storeDirOf();
    expect(snapshotsIn(store).length).toBeGreaterThanOrEqual(2);
    expect((await destroy()).code).toBe(0);
    expect(existsSync(store)).toBe(false);
  });
});

describe('what refuses a mask resource', () => {
  it('blocks a set naming a field the org lacks, dry-run first, in the script’s own words, and writes nothing', async () => {
    writeFile(file({}, {}, [...RULES, { fieldPattern: 'Contact.Nickname__c', ruleType: 'fake' }]));
    const before = JSON.stringify(world.records('Contact'));

    const { plan: planned } = await plan();
    const applied = await apply();

    expect(planned.actions[0]).toMatchObject({ action: 'blocked' });
    expect(planned.actions[0]?.refusal).toBe(
      `its own dry run says a real run would be refused: ${missingFieldLine('Contact', 'Nickname__c')}`,
    );
    expect(applied.code).toBe(1);
    expect(maskings()).toEqual([]);
    expect(JSON.stringify(world.records('Contact'))).toBe(before);
    // Negative control: the same set without it masks.
    writeFile(file());
    expect((await apply()).code).toBe(0);
  });

  it('refuses a rule set with no rule for its object before any org is reached, exit 2', async () => {
    writeFile(file({ object: 'Lead', where: undefined }));

    const ran = await run(['validate', '--json']);

    expect(ran.code).toBe(2);
    expect(JSON.stringify(ran.answer)).toContain(
      'the rule set contact-points has no rule for Lead: a run would mask nothing',
    );
    expect(world.calls).toEqual([]);
  });

  it('is refused on an org whose kind the file does not allow, and on a sandbox it does not list, by the guards every resource meets', async () => {
    worldOf({ sandbox: true });
    const notAllowed = await run(['plan', '--org', 'TGT', '--json']);
    expect(envRefusalAnswerSchema.parse(notAllowed.answer).refusal.code).toBe('KIND');

    writeFile(file({}, { targets: { kinds: ['sandbox'], sandboxes: ['00D000000000001AAA'] } }));
    const notListed = await run(['plan', '--org', 'TGT', '--json']);
    expect(envRefusalAnswerSchema.parse(notListed.answer).refusal.code).toBe('NOT_LISTED');

    worldOf({ sandbox: false, edition: 'Enterprise Edition' });
    const production = await run(['plan', '--org', 'TGT', '--json']);
    expect(envRefusalAnswerSchema.parse(production.answer).refusal.code).toBe('PRODUCTION');
    expect(world.calls).toEqual([]);

    // Negative control: the sandbox listed by its Organization Id, applied once its state is accepted missing.
    worldOf({ sandbox: true });
    writeFile(file({}, { targets: { kinds: ['sandbox'], sandboxes: [ORG_ID] } }));
    expect((await apply('--accept-no-state')).code).toBe(0);
    expect(fieldOf(copied[0], 'Email')).not.toBe('ada@example.com');
  });

  it('refuses a file asking a checkpoint before the first write beside a mask resource, exit 2', async () => {
    writeFile(file({}, { checkpoint: { before: true } }));

    const ran = await run(['plan', '--org', 'TGT', '--json']);

    expect(ran.code).toBe(2);
    expect(ran.said).toContain('destroy --rewind would put them back into the org');
    expect(world.calls).toEqual([]);
  });
});
