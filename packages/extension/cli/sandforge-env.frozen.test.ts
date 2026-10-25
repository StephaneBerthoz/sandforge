import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envPlanSchema,
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
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { frozenDatasetDigest } from '../src/modules/frozendataset/datasetDigest.js';
import { openEnvStore } from './env/envState.js';
import { main, type EnvCliDeps } from './sandforge-env.js';
import { EnvWorld } from './testing/envWorld.js';
import { freezeDataset } from './testing/frozenDataset.js';

/*
 * Frozen resources, and references between resources, on the command line,
 * on the memory org: each verb run as a terminal or a CI step runs it, its
 * scripts `sandforge-frozen`'s and `sandforge-seed`'s own `main` in this
 * process, a load going record by record through the Load tab's own handler
 * into the memory org. Every `--json` answer is read with the contract's own
 * schema; the records are counted in the org, never by what a script said.
 */

const ORG_ID = '00D000000000009ZAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');
const ENV = 'claims-flow';

let dir: string;
let project: string;
let datasetDir: string;
let journalDir: string;
let locksDir: string;
let journalBefore: string | undefined;
let datasetBefore: string | undefined;
let world: EnvWorld;
let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;
let digest: string;

/** The file: the claims dataset loaded, then contacts drawn from the accounts it created. */
function file(
  over: Record<string, unknown> = {},
  pin: Partial<{ version: string; digest: string }> = {},
) {
  return {
    version: 1,
    name: ENV,
    resources: {
      claims: {
        kind: 'frozen',
        config: 'frozen/claims.frozen.json',
        dataset: {
          path: { env: 'SANDFORGE_CLAIMS_DATASET' },
          version: pin.version ?? '1.0.0',
          digest: pin.digest ?? digest,
        },
      },
      followers: {
        kind: 'seed',
        seed: 7,
        objects: [
          {
            object: 'Contact',
            count: 3,
            fields: [
              {
                fieldApiName: 'LastName',
                ruleType: 'static',
                config: { staticValue: 'SFENV follower' },
              },
            ],
          },
        ],
        relations: [
          {
            lookup: 'Contact.AccountId',
            parents: { from: 'claims.Account' },
            distribution: { mode: 'perParent', count: 1 },
          },
        ],
      },
    },
    ...over,
  };
}

function writeFile(document: unknown): void {
  writeFileSync(join(project, 'sandforge.yaml'), JSON.stringify(document, null, 2));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-frozen-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, 'frozen'));
  writeFileSync(
    join(project, 'frozen', 'claims.frozen.json'),
    JSON.stringify({ rootObject: 'Account', axes: [], edgeCases: [] }),
  );
  datasetDir = await freezeDataset(join(dir, 'datasets', 'claims'), {
    accounts: 2,
    perAccount: 1,
    mark: 'claim',
  });
  digest = await frozenDatasetDigest(datasetDir);
  writeFile(file());
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  datasetBefore = process.env['SANDFORGE_CLAIMS_DATASET'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  process.env['SANDFORGE_CLAIMS_DATASET'] = datasetDir;
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: true,
    scratch: true,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
  });
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
  if (datasetBefore === undefined) delete process.env['SANDFORGE_CLAIMS_DATASET'];
  else process.env['SANDFORGE_CLAIMS_DATASET'] = datasetBefore;
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

async function stateOf() {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if (!('store' in opened)) throw new Error(opened.refusal);
  return { store: opened.store, state: await opened.store.read(ORG_ID, ENV) };
}

/** The records of an object the org holds named with `mark`. */
const named = (object: string, mark: string): Array<Record<string, unknown>> =>
  world
    .records(object)
    .filter((row) => String(row['Name'] ?? row['LastName'] ?? '').startsWith(`SFENV ${mark}`));

/** The lines the scripts were run with, of `script`. */
const linesOf = (script: string): string[][] =>
  world.calls.filter((call) => call.script === script).map((call) => call.args);

describe('validate a frozen resource', () => {
  it('checks it offline, its configuration held to Frozen’s schema, its dataset’s variable named', async () => {
    const { code, answer } = await run(['validate', '--json']);

    expect(code).toBe(0);
    const read = envValidationSchema.parse(answer);
    expect(read.resources).toEqual([
      { name: 'claims', kind: 'frozen', dependsOn: [], objects: [] },
      {
        name: 'followers',
        kind: 'seed',
        dependsOn: ['claims'],
        objects: [{ object: 'Contact', count: 3 }],
      },
    ]);
    expect(read.variables).toEqual([
      { name: 'SANDFORGE_CLAIMS_DATASET', resource: 'claims', set: true },
    ]);
    expect(world.calls).toEqual([]);
  });

  it('says on the terminal what it loads, from where, and what a relation draws from', async () => {
    await run(['validate']);

    const said = stdout.join('');
    expect(said).toContain(
      `  claims: the Frozen dataset 1.0.0 at $SANDFORGE_CLAIMS_DATASET (${digest.slice(0, 19)}…), as frozen/claims.frozen.json configures its load`,
    );
    expect(said).toContain(
      '  followers: Contact 3; Contact.AccountId under the Account records claims created, after claims',
    );
    expect(said).toContain('  variable SANDFORGE_CLAIMS_DATASET (the dataset of claims): set');
  });
});

describe('plan and apply a frozen resource', () => {
  it('plans what its dry run counts, the drawing resource at most as the file gives it until the dataset is loaded, and writes nothing', async () => {
    const { code, plan: planned } = await plan();

    expect(code).toBe(0);
    expect(planned.actions).toEqual([
      expect.objectContaining({
        resource: 'claims',
        kind: 'frozen',
        action: 'create',
        objects: [
          { object: 'Account', wouldCreate: 2 },
          { object: 'Contact', wouldCreate: 2 },
        ],
      }),
      expect.objectContaining({
        resource: 'followers',
        action: 'create',
        objects: [{ object: 'Contact', wouldCreate: 3, atMost: true }],
        draws: [{ lookup: 'Contact.AccountId', from: 'claims', object: 'Account' }],
      }),
    ]);
    expect(planned.actions[1]?.why).toContain(
      'it draws its parents from the records claims creates in this apply, which nobody knows before it runs: counted at most as the file gives it',
    );
    expect(world.records('Account')).toEqual([]);
    expect(linesOf('sandforge-frozen')).toEqual([
      expect.arrayContaining(['load', '--target', 'TGT', '--dry-run', '--json']),
    ]);
    // A plan makes no folder of the state: its dry run loads into a sas of its own.
    const { store } = await stateOf();
    expect(existsSync(store.folderOf(ORG_ID, ENV))).toBe(false);
  });

  it('blocks a dataset whose digest is not the one the file pins, naming both, and writes nothing', async () => {
    const pinned = `sha256:${'0'.repeat(64)}`;
    writeFile(file({}, { digest: pinned }));

    const { code, plan: planned } = await plan();

    expect(code).toBe(0);
    expect(planned.actions[0]).toMatchObject({ resource: 'claims', action: 'blocked' });
    expect(planned.actions[0]?.refusal).toBe(
      `its dataset at ${datasetDir} has the digest ${digest}, and the file pins ${pinned}: it is ` +
        'not the dataset the file was reviewed with. Point the path at that one, or pin this ' +
        'digest once this dataset is reviewed',
    );
    // Not dry-run: a dataset that is not the one pinned is not read by a load.
    expect(linesOf('sandforge-frozen')).toEqual([]);
    const applied = await apply();
    expect(applied.code).toBe(1);
    expect(world.records('Account')).toEqual([]);
  });

  it('applies it: the load held to its dry run’s count in the sas the state keeps, the contacts drawn from what it created', async () => {
    const applied = await apply();

    expect(applied.code, applied.said).toBe(0);
    expect(applied.result.status).toBe('success');
    expect(named('Account', 'claim')).toHaveLength(2);
    expect(named('Contact', 'claim')).toHaveLength(2);
    const followers = named('Contact', 'follower');
    // One under each account the load created, and no other: the file's
    // three, two parents given one child each.
    const loaded = new Set(named('Account', 'claim').map((row) => row['Id']));
    expect(followers).toHaveLength(2);
    for (const contact of followers) expect(loaded.has(contact['AccountId'])).toBe(true);

    const load = linesOf('sandforge-frozen').find((args) => !args.includes('--dry-run'));
    expect(load?.[load.indexOf('--max-total') + 1]).toBe('4');
    const { store, state } = await stateOf();
    expect(state?.resources['claims']).toMatchObject({
      kind: 'frozen',
      status: 'applied',
      runs: [
        {
          n: 1,
          script: 'sandforge-frozen',
          sas: 'frozen/claims',
          summary: 'runs/claims/1.summary.json',
          exitCode: 0,
          objects: [
            { objectApiName: 'Account', created: 2, refused: 0 },
            { objectApiName: 'Contact', created: 2, refused: 0 },
          ],
        },
      ],
    });
    // The sas keeps what the load needs: its store and the mapping of what it created.
    const sas = store.sasOf(ORG_ID, ENV, 'frozen/claims');
    expect(existsSync(join(sas, 'cli-store.json'))).toBe(true);
    expect(existsSync(join(sas, `referenceid-mapping.${ORG_ID}.json`))).toBe(true);
    // The configuration the load was given, the sas and the dataset set.
    const config = JSON.parse(
      readFileSync(store.fileOf(ORG_ID, ENV, 'templates/claims.1.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({ rootObject: 'Account', sasDir: sas, datasetDir });
    // The seed handed the accounts by their ids.
    const template = JSON.parse(
      readFileSync(store.fileOf(ORG_ID, ENV, 'templates/followers.1.json'), 'utf8'),
    ) as { relations: Array<{ parents: { kind: string; ids: string[] } }> };
    expect(template.relations[0]?.parents.kind).toBe('records');
    expect(new Set(template.relations[0]?.parents.ids)).toEqual(loaded);
  });

  it('applied twice writes nothing the second time: the dataset verified, both kept, the drawing resource counted exactly', async () => {
    await apply();
    const serial = (await stateOf()).state?.serial;
    const from = world.calls.length;

    const again = await plan('--fail-on-change');
    const applied = await apply();

    expect(again.code).toBe(0);
    expect(again.plan.actions.map((action) => [action.resource, action.action])).toEqual([
      ['claims', 'keep'],
      ['followers', 'keep'],
    ]);
    expect(applied.code).toBe(0);
    const calls = world.calls.slice(from);
    expect(calls.filter((call) => call.args.includes('verify'))).toHaveLength(2);
    const writing = calls.filter(
      (call) =>
        !call.args.includes('--preview') &&
        !call.args.includes('--dry-run') &&
        !call.args.includes('verify'),
    );
    expect(writing).toEqual([]);
    expect((await stateOf()).state?.serial).toBe(serial);
  });

  it('blocks a drawing resource whose parents were deleted since, in the seed’s own words, and writes nothing', async () => {
    await apply();
    const [account] = named('Account', 'claim');
    world.org.trash('Account', String(account?.['Id']));
    const document = file();
    const followers = (document.resources as Record<string, Record<string, unknown>>)['followers'];
    (followers?.['objects'] as Array<Record<string, unknown>>)[0]!['count'] = 4;
    writeFile(document);
    const contacts = world.records('Contact').length;

    const { plan: planned } = await plan();
    const applied = await apply();

    const action = planned.actions.find((each) => each.resource === 'followers');
    expect(action?.action).toBe('blocked');
    expect(action?.refusal).toContain(
      'of the 2 Account record(s) the relation on Contact.AccountId names are no longer in the org',
    );
    expect(applied.code).toBe(1);
    expect(world.records('Contact')).toHaveLength(contacts);
  });

  it('counts a drawing resource exactly once what it draws from has run: the plan says how many parents', async () => {
    await apply();
    const document = file();
    const followers = (document.resources as Record<string, Record<string, unknown>>)['followers'];
    (followers?.['objects'] as Array<Record<string, unknown>>)[0]!['count'] = 4;
    writeFile(document);

    const { plan: planned, said } = await plan();

    const action = planned.actions.find((each) => each.resource === 'followers');
    expect(action).toMatchObject({
      action: 'replace',
      draws: [{ lookup: 'Contact.AccountId', from: 'claims', object: 'Account', parents: 2 }],
    });
    // One child under each of the two accounts the load created: exactly two.
    expect(action?.objects).toEqual([
      expect.objectContaining({ object: 'Contact', wouldCreate: 2 }),
    ]);
    expect(action?.objects[0]?.atMost).toBeUndefined();
    expect(said).toContain(
      'Contact.AccountId draws its parents from the 2 Account record(s) claims created',
    );
  });

  it('reads its drift by its verification: a contact of the load deleted since FAILS its object, named, and plan --fail-on-drift exits 3', async () => {
    await apply();
    const [contact] = named('Contact', 'claim');
    world.org.trash('Contact', String(contact?.['Id']));

    const { code, plan: planned } = await plan('--fail-on-drift');

    expect(code).toBe(3);
    const claims = planned.actions.find((each) => each.resource === 'claims');
    expect(claims?.action).toBe('drifted');
    expect(claims?.why).toContain('Contact 1 gone');
    expect(claims?.why).toContain('its verification: Contact FAILED (1 of 2 found)');
  });

  it('replaces it when its dataset changed, in one run, a reload: the records of the load before purged, its run taken back', async () => {
    await apply();
    const before = new Set(named('Account', 'claim').map((row) => row['Id']));
    const refrozen = await freezeDataset(join(dir, 'datasets', 'claims-2'), {
      accounts: 3,
      perAccount: 1,
      mark: 'claim',
      version: '1.1.0',
    });
    process.env['SANDFORGE_CLAIMS_DATASET'] = refrozen;
    writeFile(file({}, { version: '1.1.0', digest: await frozenDatasetDigest(refrozen) }));
    const from = world.calls.length;

    const applied = await apply();

    expect(applied.code, applied.said).toBe(0);
    expect(applied.result.plan.actions.map((action) => [action.resource, action.action])).toEqual([
      ['claims', 'replace'],
      ['followers', 'replace'],
    ]);
    const frozenCalls = world.calls
      .slice(from)
      .filter((call) => call.script === 'sandforge-frozen');
    // A dry run of the reload, then the reload: no removal of its own.
    expect(frozenCalls.filter((call) => call.args.includes('--reload'))).toHaveLength(2);
    expect(
      frozenCalls.some((call) => call.args[0] === 'remove' && !call.args.includes('--preview')),
    ).toBe(false);
    expect(named('Account', 'claim')).toHaveLength(3);
    expect(named('Account', 'claim').some((row) => before.has(row['Id']))).toBe(false);
    expect(named('Contact', 'follower')).toHaveLength(3);
    const runs = (await stateOf()).state?.resources['claims']?.runs;
    expect(runs?.map((run) => [run.n, run.takenBack === true])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('blocks a replace whose reload would leave records changed since, in the load’s own words, and writes nothing', async () => {
    await apply();
    const [account] = named('Account', 'claim');
    world.org.touch(
      'Account',
      String(account?.['Id']),
      new Date(Date.now() + 60_000).toISOString(),
    );
    vi.setSystemTime(Date.now() + 120_000);
    const refrozen = await freezeDataset(join(dir, 'datasets', 'claims-2'), {
      accounts: 3,
      perAccount: 1,
      mark: 'claim',
      version: '1.1.0',
    });
    process.env['SANDFORGE_CLAIMS_DATASET'] = refrozen;
    writeFile(file({}, { version: '1.1.0', digest: await frozenDatasetDigest(refrozen) }));

    const { plan: planned } = await plan();

    const claims = planned.actions.find((each) => each.resource === 'claims');
    expect(claims?.action).toBe('blocked');
    expect(claims?.refusal).toContain(
      'A removal of the loads this reload replaces would leave 1 of their records in the org',
    );
    const applied = await apply();
    expect(applied.code).toBe(1);
    expect(named('Account', 'claim')).toHaveLength(2);
  });

  it('takes it back with destroy, the drawing resource first: the org holds none of it after, the state every resource destroyed', async () => {
    await apply();

    const destroyed = await run(['destroy', '--org', 'TGT', '--yes', '--json']);

    expect(destroyed.code, destroyed.said).toBe(0);
    const result = envRunResultSchema.parse(destroyed.answer);
    expect(result.steps.map((step) => [step.resource, step.phase, step.exitCode])).toEqual([
      ['followers', 'remove', 0],
      ['claims', 'remove', 0],
    ]);
    expect(world.records('Account')).toEqual([]);
    expect(world.records('Contact')).toEqual([]);
    const removal = linesOf('sandforge-frozen').find(
      (args) => args[0] === 'remove' && !args.includes('--preview'),
    );
    const { store, state } = await stateOf();
    expect(removal?.[removal.indexOf('--config') + 1]).toBe(
      store.fileOf(ORG_ID, ENV, 'templates/claims.1.json'),
    );
    expect(Object.values(state?.resources ?? {}).map((resource) => resource.status)).toEqual([
      'destroyed',
      'destroyed',
    ]);
  });
});
