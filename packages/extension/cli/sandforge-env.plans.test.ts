import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envOutputSchema,
  envPlanSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
  envSavedPlanSchema,
  type EnvSavedPlan,
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

import { loadOrg } from './sfSession.js';
import { OUTPUT_DESTROYED_WHY } from './env/envOutput.js';
import { EnvWorld, type EnvWorldOptions } from './testing/envWorld.js';
import { main, type EnvCliDeps } from './sandforge-env.js';

/*
 * Saved plans and outputs on the command line, on the memory org: each verb
 * run as a terminal or a CI step runs it, its scripts `sandforge-seed`'s own
 * `main` in this process. A plan kept by `plan --out` is read back with its
 * own schema, and every `--json` answer with the contract's.
 */

// Ids whose last three characters are the checksum of the first fifteen, as the org gives them.
const ORG_ID = '00D000000000009EAA';
const OTHER_ORG = '00D000000000008EAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

/** The file of two resources, neither pinning its draws: accounts, then contacts under them. */
function file(accounts = 2): Record<string, unknown> {
  const named = (field: string, value: string) => [
    { fieldApiName: field, ruleType: 'static', config: { staticValue: value } },
  ];
  return {
    version: 1,
    name: 'case-flow',
    resources: {
      accounts: {
        kind: 'seed',
        objects: [{ object: 'Account', count: accounts, fields: named('Name', 'SFENV account') }],
      },
      contacts: {
        kind: 'seed',
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

let dir: string;
let project: string;
let fileOf: string;
let planFile: string;
let journalDir: string;
let locksDir: string;
let journalBefore: string | undefined;
let world: EnvWorld;
let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;

/** A Developer Edition org in memory, unless a test makes it another. */
function worldOf(options: EnvWorldOptions = {}): EnvWorld {
  world = new EnvWorld({
    organizationId: ORG_ID,
    sandbox: false,
    edition: 'Developer Edition',
    tick: () => vi.setSystemTime(Date.now() + 30_000),
    ...options,
  });
  return world;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-plans-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  fileOf = join(project, 'sandforge.yaml');
  writeFileSync(fileOf, JSON.stringify(file(), null, 2));
  planFile = join(dir, 'case-flow.plan.json');
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  worldOf();
  vi.mocked(loadOrg).mockClear();
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

/** Run the command, and give back its exit code, its answer read as JSON, and what it said. */
async function run(
  args: string[],
  over: Partial<EnvCliDeps> = {},
): Promise<{ code: number; answer: unknown; said: string; out: string }> {
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
    out,
  };
}

/** The plan `plan --out` kept, read with its own schema. */
const kept = (): EnvSavedPlan =>
  envSavedPlanSchema.parse(JSON.parse(readFileSync(planFile, 'utf8')) as unknown);

/** `plan --out` of the file to the memory org, accepting no state as a first apply to a Developer Edition must. */
const planOut = (...flags: string[]) =>
  run(['plan', '--org', 'TGT', '--json', '--out', planFile, '--accept-no-state', ...flags]);

const applyPlan = (...flags: string[]) =>
  run(['apply', '--org', 'TGT', '--yes', '--json', '--plan', planFile, ...flags]);

/** What a refusal answered, read with its schema. */
const refusalOf = (answer: unknown) => envRefusalAnswerSchema.parse(answer).refusal;

/** The value a line gives a flag. */
const valueOn = (args: readonly string[], flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

describe('the command line of saved plans and outputs', () => {
  it.each([
    [['plan', '--org', 'TGT', '--out', 'p.json', '--quick'], 'a quick plan cannot be'],
    [['plan', '--org', 'TGT', '--out-in-repository'], '--out-in-repository goes with --out'],
    [['plan', '--org', 'TGT', '--out'], '--out wants a value'],
    [
      ['apply', '--org', 'TGT', '--plan', 'p.json', '--replace', 'accounts'],
      '--replace: --plan applies',
    ],
    [
      ['apply', '--org', 'TGT', '--plan', 'p.json', '--accept-no-state'],
      '--accept-no-state: --plan',
    ],
    [
      ['apply', '--org', 'TGT', '--plan', 'p.json', '--replace-drifted'],
      '--replace-drifted: --plan',
    ],
    [['apply', '--org', 'TGT', '--plan', 'p.json', '--accept-automation'], 'kept in it'],
    [['output'], 'output needs --org'],
    [['output', '--org', 'TGT', '--yes'], '"--yes" is not a flag this command reads'],
    [['destroy', '--org', 'TGT', '--plan', 'p.json'], '"--plan" is not a flag this command reads'],
  ])('refuses %j, exit 2, before any org is reached', async (args, said) => {
    const { code, answer } = await run(args);

    expect(code).toBe(2);
    expect(answer).toBeUndefined();
    expect(stderr.join('')).toContain(said);
    expect(loadOrg).not.toHaveBeenCalled();
  });
});

describe('plan --out', () => {
  it('keeps the plan it answers, with the state, the file and the line it was made against, and the seeds its dry runs drew', async () => {
    const planned = await planOut();

    expect(planned.code).toBe(0);
    const saved = kept();
    expect(saved.plan).toEqual(envPlanSchema.parse(planned.answer));
    expect(saved).toMatchObject({
      savedPlan: 1,
      // After the two dry runs, each half a minute by the org's clock.
      madeAt: '2026-10-25T09:01:00.000Z',
      state: { found: false },
      line: { replace: [], replaceDrifted: false, acceptAutomation: false, acceptNoState: true },
    });
    expect(saved.file.digest).toMatch(/^[0-9a-f]{64}$/);
    // The draws each dry run drew, the file pinning none.
    const dryRuns = world.calls.filter((call) => call.args.includes('--dry-run'));
    expect(dryRuns).toHaveLength(2);
    expect(Object.keys(saved.seeds).sort()).toEqual(['accounts', 'contacts']);
    for (const value of Object.values(saved.seeds)) expect(Number.isInteger(value)).toBe(true);
    expect(planned.said).toContain(
      `plan kept in ${planFile}, for apply --plan until 2026-10-26T09:01:00.000Z`,
    );
    // Nothing was applied: no state, no record.
    expect(world.records('Account')).toEqual([]);
    expect(existsSync(join(journalDir, 'env'))).toBe(true);
    expect(world.calls.filter((call) => !call.args.includes('--dry-run'))).toEqual([]);
  });

  it('writes nothing secret: no credential, no username, no value of a record, and its owner alone reads it', async () => {
    vi.mocked(loadOrg).mockImplementation(async (alias: string) => ({
      alias,
      username: 'person.secret@example.com',
      instanceUrl: 'https://secret-instance.my.salesforce.com',
      accessToken: '00Dxx0000001gPL!SECRET-ACCESS-TOKEN',
    }));
    world.copyIn('Account', [{ Name: 'A value of the org held in clear' }]);

    expect((await planOut()).code).toBe(0);

    const text = readFileSync(planFile, 'utf8');
    for (const secret of [
      'SECRET-ACCESS-TOKEN',
      'secret-instance',
      'person.secret',
      'A value of the org held in clear',
      'SFENV account',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // Positive control: what it holds is the plan, by its org and its counts.
    expect(text).toContain(ORG_ID);
    expect(text).toContain('"wouldCreate": 2');
    if (process.platform !== 'win32') expect(statSync(planFile).mode & 0o777).toBe(0o600);
  });

  it('refuses a file inside the repository that holds the file, exit 2, before any org is reached, and keeps it there with --out-in-repository', async () => {
    const inside = join(project, 'out', 'case-flow.plan.json');
    mkdirSync(join(project, 'out'));

    const refused = await run(['plan', '--org', 'TGT', '--json', '--out', inside]);

    expect(refused.code).toBe(2);
    expect(refusalOf(refused.answer)).toMatchObject({ code: 'PLAN_IN_REPOSITORY' });
    // The repository by where its links lead: on Windows, a temporary folder's long name.
    expect(refusalOf(refused.answer).message).toContain(
      `--out ${inside} is inside the repository `,
    );
    expect(refusalOf(refused.answer).message).toContain(
      ' that holds the file: a plan names the org',
    );
    expect(loadOrg).not.toHaveBeenCalled();
    expect(existsSync(inside)).toBe(false);

    const allowed = await run([
      'plan',
      '--org',
      'TGT',
      '--out',
      inside,
      '--out-in-repository',
      '--accept-no-state',
    ]);
    expect(allowed.code).toBe(0);
    expect(existsSync(inside)).toBe(true);
  });

  it('refuses a folder that is not there, exit 2, before any org is reached', async () => {
    const ran = await run(['plan', '--org', 'TGT', '--json', '--out', join(dir, 'nope', 'p.json')]);

    expect(ran.code).toBe(2);
    expect(refusalOf(ran.answer).code).toBe('BAD_LINE');
    expect(loadOrg).not.toHaveBeenCalled();
  });
});

describe('plan --accept-no-state and --accept-automation', () => {
  it('plans what apply would do with them: no state accepted on a Developer Edition is a warning, not a refusal', async () => {
    const refused = envPlanSchema.parse((await run(['plan', '--org', 'TGT', '--json'])).answer);
    expect(refused.refusal).toContain('apply asks --accept-no-state to go ahead');

    const accepted = envPlanSchema.parse(
      (await run(['plan', '--org', 'TGT', '--json', '--accept-no-state'])).answer,
    );
    expect(accepted.refusal).toBeUndefined();
    expect(accepted.warnings?.[0]).toContain('this machine keeps no state of case-flow on TGT');
  });
});

describe('apply --plan', () => {
  it('applies the plan kept and nothing else: its line’s acceptances, the draws its dry runs drew, its counts', async () => {
    await planOut();
    const saved = kept();
    const from = world.calls.length;

    const applied = await applyPlan();

    expect(applied.code, applied.said).toBe(0);
    const result = envRunResultSchema.parse(applied.answer);
    expect(result.status).toBe('success');
    // Accepted by the plan's own line: the flag was not given again.
    expect(result.plan.refusal).toBeUndefined();
    expect(result.steps.map((s) => [s.resource, s.status])).toEqual([
      ['accounts', 'applied'],
      ['contacts', 'applied'],
    ]);
    // Dry-run again, and run, with the draws the plan's dry runs drew.
    const lines = world.calls.slice(from).map((call) => call.args);
    const templateOf = (args: string[]) =>
      (valueOn(args, '--template-file') ?? '').replace(/\\/g, '/');
    for (const name of ['accounts', 'contacts'] as const) {
      const ofIt = lines.filter((args) => new RegExp(`/${name}[.]`).test(templateOf(args)));
      expect(ofIt.length, name).toBeGreaterThanOrEqual(2);
      for (const args of ofIt)
        expect(valueOn(args, '--seed'), name).toBe(String(saved.seeds[name]));
    }
    expect(world.records('Account')).toHaveLength(2);
    expect(world.records('Contact')).toHaveLength(2);
    expect(applied.said).toContain(
      `the plan kept in ${planFile} at ${saved.madeAt} holds: the org, its state, the file and every count are as it planned them`,
    );
  });

  it('refuses a plan made for another org, exit 1, writing nothing', async () => {
    await planOut();
    worldOf({ organizationId: OTHER_ORG });

    const refused = await applyPlan();

    expect(refused.code).toBe(1);
    expect(refusalOf(refused.answer)).toEqual({
      code: 'PLAN_OTHER_ORG',
      message:
        `The plan kept in ${planFile} was made for TGT (${ORG_ID}), and TGT is ${OTHER_ORG}: a ` +
        'plan is applied to the org it was made for. Nothing was written.',
    });
    expect(world.calls).toEqual([]);
    expect(world.records('Account')).toEqual([]);
  });

  it('refuses a plan once the state moved: an apply ran since, exit 1, writing nothing', async () => {
    await planOut();
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);
    const before = world.records('Account').length;
    const from = world.calls.length;

    const refused = await applyPlan();

    expect(refused.code).toBe(1);
    expect(refusalOf(refused.answer)).toEqual({
      code: 'PLAN_STALE',
      message: expect.stringContaining(
        `The plan kept in ${planFile} was made against no state, and the state is now at serial `,
      ),
    });
    expect(refusalOf(refused.answer).message).toContain(
      'an apply or a destroy ran since, or a cache put back another state. Nothing was written: plan again.',
    );
    expect(world.calls.slice(from)).toEqual([]);
    expect(world.records('Account')).toHaveLength(before);
  });

  it('refuses a plan once the file changed, exit 1, writing nothing', async () => {
    await planOut();
    writeFileSync(fileOf, JSON.stringify(file(3), null, 2));

    const refused = await applyPlan();

    expect(refused.code).toBe(1);
    expect(refusalOf(refused.answer).message).toBe(
      `The plan kept in ${planFile} was made from another file: the file, or a variable or an ` +
        'alias it reads, changed since. Nothing was written: plan again.',
    );
    expect(world.calls.filter((call) => !call.args.includes('--dry-run'))).toEqual([]);
    expect(world.records('Account')).toEqual([]);
  });

  it('refuses a plan once what the org holds reads otherwise, action by action and count by count, exit 1, writing nothing', async () => {
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);
    expect((await planOut('--replace', 'accounts')).code).toBe(0);
    expect(kept().line.replace).toEqual(['accounts']);
    const [contact] = world.records('Contact');
    world.org.trash('Contact', String(contact?.['Id']));
    const serial = kept().state;
    const ids = world.records('Account').map((row) => row['Id']);

    const refused = await applyPlan();

    expect(refused.code).toBe(1);
    expect(refusalOf(refused.answer)).toEqual({
      code: 'PLAN_STALE',
      message:
        `The plan kept in ${planFile} is not what the org holds now, read again: contacts: ` +
        'planned replace (Contact at most 2 to write, 2 in the org), now replace (Contact at ' +
        'most 2 to write, 1 in the org, 1 gone). Nothing was written: plan again.',
    });
    // Neither taken back nor written: the accounts as they were, the state with them.
    expect(world.records('Account').map((row) => row['Id'])).toEqual(ids);
    expect(
      world.calls.filter(
        (call) => call.args.includes('--remove') && !call.args.includes('--preview'),
      ),
    ).toEqual([]);
    const after = (await run(['state', '--json'])).answer as { states: Array<{ serial: number }> };
    expect(serial).toMatchObject({ found: true, serial: after.states[0]?.serial });
  });

  it('refuses before any org is reached a plan refused when it was made, one a day old, and one another SandForge made', async () => {
    // Refused when it was made: a Developer Edition with no state, not accepted.
    expect((await run(['plan', '--org', 'TGT', '--out', planFile])).code).toBe(0);
    vi.mocked(loadOrg).mockClear();
    const refused = await applyPlan();
    expect(refused.code).toBe(1);
    expect(refusalOf(refused.answer).code).toBe('PLAN_REFUSED');
    expect(refusalOf(refused.answer).message).toMatch(
      /^The plan kept in .+ was refused when it was made: This machine keeps no state of case-flow on TGT/,
    );
    expect(loadOrg).not.toHaveBeenCalled();

    // A day old.
    await planOut();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 + 1_000);
    vi.mocked(loadOrg).mockClear();
    const old = await applyPlan();
    expect(old.code).toBe(1);
    expect(refusalOf(old.answer).message).toBe(
      `The plan kept in ${planFile} was made at ${kept().madeAt}, more than a day ago. Nothing ` +
        'was written: plan again.',
    );
    expect(loadOrg).not.toHaveBeenCalled();

    // Made by another SandForge.
    vi.setSystemTime(T0);
    await planOut();
    writeFileSync(planFile, JSON.stringify({ ...kept(), sandforgeVersion: '0.1.0' }));
    vi.mocked(loadOrg).mockClear();
    const other = await applyPlan();
    expect(other.code).toBe(1);
    expect(refusalOf(other.answer).message).toMatch(
      /^The plan kept in .+ was made by SandForge 0\.1\.0, and this one is \d+\.\d+\.\d+/,
    );
    expect(loadOrg).not.toHaveBeenCalled();
    expect(world.records('Account')).toEqual([]);
  });

  it('refuses a file that is no plan, exit 2, before any org is reached', async () => {
    const missing = await applyPlan();
    expect(missing.code).toBe(2);
    expect(refusalOf(missing.answer).code).toBe('PLAN_UNREAD');

    writeFileSync(planFile, JSON.stringify(file()));
    const other = await applyPlan();
    expect(other.code).toBe(2);
    expect(refusalOf(other.answer).message).toContain(
      `--plan ${planFile} is no plan plan --out kept`,
    );
    expect(loadOrg).not.toHaveBeenCalled();
  });
});

describe('output', () => {
  it('names per resource the records its last run created, by object, in order: no script run, no org reached', async () => {
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);
    vi.mocked(loadOrg).mockClear();
    const from = world.calls.length;

    const ran = await run(['output', '--org', 'TGT', '--json']);

    expect(ran.code).toBe(0);
    const output = envOutputSchema.parse(ran.answer);
    expect(output.org).toEqual({ organizationId: ORG_ID, kind: 'developer', alias: 'TGT' });
    expect(Object.keys(output.resources)).toEqual(['accounts', 'contacts']);
    expect(output.resources['accounts']).toEqual({
      kind: 'seed',
      status: 'applied',
      run: 1,
      records: { Account: world.records('Account').map((row) => row['Id']) },
    });
    expect(output.resources['contacts']?.records).toEqual({
      Contact: world.records('Contact').map((row) => row['Id']),
    });
    expect(loadOrg).not.toHaveBeenCalled();
    expect(world.calls.slice(from)).toEqual([]);
    // The same, found by the org's Organization Id.
    const byId = await run(['output', '--org', ORG_ID.slice(0, 15), '--json']);
    expect(envOutputSchema.parse(byId.answer)).toEqual(output);
  });

  it('says on a terminal each resource, its records by object, and why it names none', async () => {
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);
    const accounts = world.records('Account').map((row) => String(row['Id']));

    const ran = await run(['output', '--org', 'TGT']);

    expect(ran.out.split('\n').slice(0, 3)).toEqual([
      expect.stringMatching(
        /^case-flow on TGT \(developer, 00D000000000009EAA\): state serial \d+, written /,
      ),
      '  accounts  seed, applied, run 1',
      `    Account  ${accounts.join(' ')}`,
    ]);
  });

  it('names no record of a resource a destroy took back, and says so, exit 0', async () => {
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);
    expect((await run(['destroy', '--org', 'TGT', '--yes'])).code).toBe(0);

    const ran = await run(['output', '--org', 'TGT', '--json']);

    expect(ran.code).toBe(0);
    const output = envOutputSchema.parse(ran.answer);
    expect(output.resources['accounts']).toEqual({
      kind: 'seed',
      status: 'destroyed',
      run: 1,
      records: {},
      why: OUTPUT_DESTROYED_WHY,
    });
  });

  it('names no record of a resource not applied whole, says why, and exits 3', async () => {
    world.refuseCreate = (object) =>
      object === 'Contact' ? 'A validation rule refused it' : undefined;
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(3);

    const ran = await run(['output', '--org', 'TGT', '--json']);

    expect(ran.code).toBe(3);
    const output = envOutputSchema.parse(ran.answer);
    expect(output.resources['accounts']?.records['Account']).toHaveLength(2);
    expect(output.resources['contacts']).toMatchObject({
      status: 'failed',
      records: {},
      why: 'its last run failed: it names no record until it is applied whole — apply again',
    });
  });

  it('refuses with no state of the environment for the org, exit 1, and two states under one alias, naming both', async () => {
    const none = await run(['output', '--org', 'TGT', '--json']);
    expect(none.code).toBe(1);
    expect(refusalOf(none.answer).code).toBe('NO_STATE');

    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);
    // The alias reused for another org, applied to as well.
    worldOf({ organizationId: OTHER_ORG });
    expect((await run(['apply', '--org', 'TGT', '--yes', '--accept-no-state'])).code).toBe(0);

    const two = await run(['output', '--org', 'TGT', '--json']);
    expect(two.code).toBe(1);
    expect(refusalOf(two.answer)).toMatchObject({ code: 'TWO_STATES' });
    expect(refusalOf(two.answer).message).toContain(ORG_ID);
    expect(refusalOf(two.answer).message).toContain(OTHER_ORG);
    // Its Organization Id says which.
    const one = await run(['output', '--org', OTHER_ORG, '--json']);
    expect(one.code).toBe(0);
    expect(envOutputSchema.parse(one.answer).org.organizationId).toBe(OTHER_ORG);
  });

  it('refuses a journal directory inside the repository that holds the file, exit 2', async () => {
    const ran = await run(['output', '--org', 'TGT', '--json'], {
      journalDir: join(project, '.sandforge'),
    });

    expect(ran.code).toBe(2);
    expect(refusalOf(ran.answer).code).toBe('STORE_IN_REPOSITORY');
  });
});
