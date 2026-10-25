import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  envPlanSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
  envStateListSchema,
  envValidationSchema,
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
import { acquireEnvLock } from './env/envLock.js';
import { EnvWorld, type EnvWorldOptions } from './testing/envWorld.js';
import { main, parseArgs, type EnvCliDeps } from './sandforge-env.js';

/*
 * The command line, on the memory org: each verb run as a terminal or a CI
 * step runs it, its scripts `sandforge-seed`'s own `main` in this process.
 * Every `--json` answer is read with the contract's own schema.
 */

const ORG_ID = '00D000000000009EAA';
const OTHER_ORG = '00D000000000008AAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

/** The file of two resources: accounts, then contacts drawn from them. */
function file(over: Record<string, unknown> = {}): Record<string, unknown> {
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
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-cli-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  fileOf = join(project, 'sandforge.yaml');
  writeFileSync(fileOf, JSON.stringify(file(), null, 2));
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

describe('the command line', () => {
  it('prints its help, which runs it as every script is run', async () => {
    const { code } = await run(['--help']);

    expect(code).toBe(0);
    const help = stdout.join('');
    expect(help).toMatch(/^sandforge-env — apply a sandforge\.yaml to an org/);
    expect(help).toContain(
      'pnpm exec tsx packages/extension/cli/sandforge-env.ts <command> [--file <sandforge.yaml>] --org <alias>',
    );
  });

  it.each([
    [['deploy', '--org', 'TGT'], '"deploy" is not a command of sandforge-env'],
    [[], 'Name the command first'],
    [['plan', '--org', 'TGT', '--dry-run'], '"--dry-run" is not a flag this command reads'],
    [['apply', '--org', 'TGT', '--yes=true'], '"--yes=true" is not read'],
    [['apply', '--org', 'TGT', '--sweep'], '"--sweep" is not a flag this command reads'],
    [['plan'], 'plan needs --org'],
    [['plan', '--org', 'TGT', '--alias', 'uat'], '--alias wants <role>=<alias>'],
    [['plan', '--org', 'A', '--org', 'B'], '--org is given 2 times'],
    [['apply', '--org', 'TGT', '--quick'], '"--quick" is not a flag this command reads'],
  ])('refuses %j, exit 2, before any org is reached', async (args, said) => {
    const { code, answer } = await run(args);

    expect(code).toBe(2);
    expect(answer).toBeUndefined();
    expect(stderr.join('')).toContain(said);
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('reads the file next to it by default, and the one --file names', () => {
    // Resolved as the platform resolves it: under a drive on Windows.
    expect(parseArgs(['node', 'x', 'validate'], '/work').file).toBe(
      resolve('/work', 'sandforge.yaml'),
    );
    expect(parseArgs(['node', 'x', 'validate', '--file', 'env/a.yaml'], '/work').file).toBe(
      resolve('/work', 'env/a.yaml'),
    );
  });
});

describe('validate', () => {
  it('checks the file offline and answers what it would apply, in order, its variables named', async () => {
    writeFileSync(
      fileOf,
      [
        '# the data the Case-flow tests need',
        'version: 1',
        'name: case-flow',
        'orgs:',
        '  uat: { alias: { env: SFENV_UNSET_ALIAS } }',
        'resources:',
        '  assets:',
        '    kind: seed',
        '    objects:',
        '      - object: Asset',
        '        count: 3',
        '        fields:',
        '          - { fieldApiName: Name, ruleType: static, config: { staticValue: SFENV } }',
        '',
      ].join('\n'),
    );

    const { code, answer } = await run(['validate', '--json']);

    expect(code).toBe(0);
    expect(envValidationSchema.parse(answer)).toEqual({
      file: fileOf,
      valid: true,
      env: 'case-flow',
      resources: [
        { name: 'assets', kind: 'seed', dependsOn: [], objects: [{ object: 'Asset', count: 3 }] },
      ],
      variables: [{ name: 'SFENV_UNSET_ALIAS', role: 'uat', set: false }],
      issues: [],
      warnings: [],
    });
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('refuses a file that does not validate, each issue where it stands, exit 2', async () => {
    const bad = file();
    (
      (bad.resources as Record<string, { objects: Array<{ count: number }> }>)['accounts']
        ?.objects[0] as { count: number }
    ).count = 0;
    writeFileSync(fileOf, JSON.stringify(bad));

    const { code, answer } = await run(['validate', '--json']);

    expect(code).toBe(2);
    const read = envValidationSchema.parse(answer);
    expect(read.valid).toBe(false);
    expect(read.issues[0]).toMatchObject({
      path: 'resources.accounts.objects[0].count',
      resource: 'accounts',
    });
  });

  it('validates the checkpoint settings, which apply takes, without a warning', async () => {
    writeFileSync(
      fileOf,
      JSON.stringify(file({ checkpoint: { before: true, after: 'baseline' } })),
    );

    const { code, answer } = await run(['validate', '--json']);

    expect(code).toBe(0);
    expect(envValidationSchema.parse(answer).warnings).toEqual([]);
    expect(world.calls).toEqual([]);
  });
});

describe('plan, apply, plan again, destroy', () => {
  it('goes through an environment’s life on a scratch org, each answer read with its schema', async () => {
    worldOf({ sandbox: true, scratch: true });

    // A plan: two to create, and a word that no state is kept for this org.
    const planned = await run(['plan', '--org', 'TGT', '--json']);
    expect(planned.code).toBe(0);
    const plan = envPlanSchema.parse(planned.answer);
    expect(plan.org).toEqual({ organizationId: ORG_ID, kind: 'scratch', alias: 'TGT' });
    expect(plan.actions.map((a) => [a.resource, a.action])).toEqual([
      ['accounts', 'create'],
      ['contacts', 'create'],
    ]);
    expect(plan.warnings?.[0]).toContain('this machine keeps no state of case-flow on TGT');
    expect((await run(['plan', '--org', 'TGT', '--fail-on-change'])).code).toBe(3);

    // Applied, then nothing pending.
    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json']);
    expect(applied.code).toBe(0);
    const result = envRunResultSchema.parse(applied.answer);
    expect(result.status).toBe('success');
    expect(result.steps.map((s) => [s.resource, s.status])).toEqual([
      ['accounts', 'applied'],
      ['contacts', 'applied'],
    ]);
    expect(world.records('Contact')).toHaveLength(2);
    expect((await run(['plan', '--org', 'TGT', '--fail-on-change'])).code).toBe(0);
    expect((await run(['plan', '--org', 'TGT', '--fail-on-drift'])).code).toBe(0);

    // The state, listed without the org.
    const listed = await run(['state', '--json']);
    const states = envStateListSchema.parse(listed.answer);
    expect(states.states).toEqual([
      expect.objectContaining({
        env: 'case-flow',
        organizationId: ORG_ID,
        alias: 'TGT',
        kind: 'scratch',
        resources: { accounts: 'applied', contacts: 'applied' },
        expiresAt: expect.any(String),
      }),
    ]);
    expect(
      envStateListSchema.parse((await run(['state', '--org', 'OTHER', '--json'])).answer).states,
    ).toEqual([]);

    // Drift: a record gone since.
    const [contact] = world.records('Contact');
    world.org.trash('Contact', String(contact?.['Id']));
    expect((await run(['plan', '--org', 'TGT', '--fail-on-drift'])).code).toBe(3);

    // Destroyed: everything taken back, the state kept with each resource destroyed.
    const destroyed = await run(['destroy', '--org', 'TGT', '--yes', '--json']);
    expect(destroyed.code).toBe(0);
    envRunResultSchema.parse(destroyed.answer);
    expect(world.records('Account')).toEqual([]);
    expect(
      envStateListSchema
        .parse((await run(['state', '--json'])).answer)
        .states.map((entry) => entry.resources),
    ).toEqual([{ accounts: 'destroyed', contacts: 'destroyed' }]);
  });

  it('reads no run a removal took back whole: plan, apply and destroy preview the current runs alone', async () => {
    // Each plan previewed every run a replace had taken back, a script
    // started and the org read for each: on a resource replaced at every
    // merge, one more each time, on every plan, apply and destroy.
    worldOf({ sandbox: true, scratch: true });
    await run(['apply', '--org', 'TGT', '--yes', '--json']);
    await run(['apply', '--org', 'TGT', '--yes', '--replace', 'accounts', '--json']);
    await run(['apply', '--org', 'TGT', '--yes', '--replace', 'accounts', '--json']);
    const previewed = (from: number) =>
      world.calls
        .slice(from)
        .filter((call) => call.args.includes('--preview'))
        .map((call) =>
          /runs[\\/](\w+)[\\/](\d+)\.summary\.json$/.exec(call.args[1] ?? '')?.slice(1),
        );
    let from = world.calls.length;

    const planned = await run(['plan', '--org', 'TGT', '--fail-on-change', '--json']);

    expect(planned.code).toBe(0);
    expect(envPlanSchema.parse(planned.answer).actions.map((a) => a.action)).toEqual([
      'keep',
      'keep',
    ]);
    expect(previewed(from)).toEqual([
      ['contacts', '3'],
      ['accounts', '3'],
    ]);
    from = world.calls.length;
    expect((await run(['apply', '--org', 'TGT', '--yes', '--json'])).code).toBe(0);
    expect(previewed(from)).toHaveLength(2);
    from = world.calls.length;
    expect((await run(['destroy', '--org', 'TGT', '--yes', '--json'])).code).toBe(0);
    expect(previewed(from)).toHaveLength(2);
    expect(world.records('Account')).toEqual([]);
  });

  it('prints the plan and each step without --json, nothing on stdout but what it says', async () => {
    worldOf({ sandbox: true, scratch: true });

    const { code } = await run(['apply', '--org', 'TGT', '--yes']);

    expect(code).toBe(0);
    const said = stdout.join('');
    expect(said).toContain(`plan of case-flow on TGT (scratch, ${ORG_ID})`);
    expect(said).toContain('  create   accounts  Account 2 to write');
    expect(said).toContain('  accounts run 1: exit 0, applied  Account 2 created');
    expect(said).toMatch(/apply: success; state serial \d+/);
  });
});

describe('asking before it writes', () => {
  beforeEach(() => {
    worldOf({ sandbox: true, scratch: true });
  });

  it('stops at the question with no terminal and no --yes, exit 2, having written nothing', async () => {
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const tty = stdin.isTTY;
    stdin.isTTY = false as never;
    try {
      const { code } = await run(['apply', '--org', 'TGT']);

      expect(code).toBe(2);
      expect(stderr.join('')).toContain('no terminal to answer: give --yes');
      expect(world.records('Account')).toEqual([]);
      expect(existsSync(join(journalDir, 'env', ORG_ID))).toBe(false);
    } finally {
      stdin.isTTY = tty as never;
    }
  });

  it('writes nothing when the alias typed is not the org’s, exit 1', async () => {
    const asked: string[] = [];

    const { code, answer } = await run(['apply', '--org', 'TGT', '--json'], {
      ask: async (question) => {
        asked.push(question);
        return 'tgt';
      },
    });

    expect(code).toBe(1);
    expect(asked).toEqual(['Type TGT to apply case-flow to it as planned:']);
    expect(envRefusalAnswerSchema.parse(answer).refusal).toEqual({
      code: 'DECLINED',
      message: 'Nothing was written.',
    });
    expect(world.records('Account')).toEqual([]);
  });

  it('applies once the alias is typed, and asks nothing when there is nothing to do', async () => {
    const asked: string[] = [];
    const ask = async (question: string) => {
      asked.push(question);
      return 'TGT';
    };

    expect((await run(['apply', '--org', 'TGT'], { ask })).code).toBe(0);
    expect((await run(['apply', '--org', 'TGT'], { ask })).code).toBe(0);

    expect(asked).toHaveLength(1);
    expect(world.records('Account')).toHaveLength(2);
  });

  it('asks before a destroy, naming what --include-changed takes', async () => {
    await run(['apply', '--org', 'TGT', '--yes']);
    const asked: string[] = [];

    const { code } = await run(['destroy', '--org', 'TGT', '--include-changed'], {
      ask: async (question) => {
        asked.push(question);
        return 'no';
      },
    });

    expect(code).toBe(1);
    expect(asked[0]).toBe(
      'Type TGT to take case-flow back from it, the records changed since included — on a ' +
        'shared org, others’ work:',
    );
    expect(world.records('Account')).toHaveLength(2);
  });
});

describe('the guards, as the command line meets them', () => {
  /** Run a plan, expecting a refusal by its code, and nothing read of the org by a script. */
  async function refused(args: string[], code: string, exit = 1): Promise<string> {
    const { code: got, answer } = await run([...args, '--json']);
    expect(got).toBe(exit);
    const read = envRefusalAnswerSchema.parse(answer);
    expect(read.refusal.code).toBe(code);
    expect(world.calls).toEqual([]);
    return read.refusal.message;
  }

  it('refuses a production org, read live, with no flag to lift it', async () => {
    worldOf({ sandbox: false, edition: 'Enterprise Edition', scratch: true });

    const message = await refused(
      ['apply', '--org', 'PROD', '--yes', '--accept-no-state'],
      'PRODUCTION',
    );

    expect(message).toContain('PROD is a production org');
  });

  it('refuses a sandbox the file does not allow, and one it allows but does not list', async () => {
    worldOf({ sandbox: true });
    expect(await refused(['plan', '--org', 'SBX'], 'KIND')).toContain('SBX is a sandbox');

    writeFileSync(
      fileOf,
      JSON.stringify(
        file({ targets: { kinds: ['sandbox'], sandboxes: [OTHER_ORG.slice(0, 15)] } }),
      ),
    );
    expect(await refused(['plan', '--org', 'SBX'], 'NOT_LISTED')).toMatch(
      /SBX is a sandbox, and its Organization Id \w{18} is not listed under targets\.sandboxes/,
    );

    writeFileSync(
      fileOf,
      JSON.stringify(file({ targets: { kinds: ['sandbox'], sandboxes: [ORG_ID] } })),
    );
    const allowed = await run(['plan', '--org', 'SBX', '--json', '--quick']);
    expect(allowed.code).toBe(0);
    expect(envPlanSchema.parse(allowed.answer).org.kind).toBe('sandbox');
  });

  it('refuses a protected org whatever else the file says', async () => {
    worldOf({ sandbox: true, scratch: true });
    writeFileSync(fileOf, JSON.stringify(file({ targets: { protect: [ORG_ID] } })));

    await refused(['plan', '--org', 'TGT'], 'PROTECTED');
  });

  it('refuses a state filed under another org, and one that does not read', async () => {
    worldOf({ sandbox: true, scratch: true });
    await run(['apply', '--org', 'TGT', '--yes']);
    const folder = join(journalDir, 'env', ORG_ID, 'case-flow');
    const state = JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8')) as {
      org: { organizationId: string };
    };
    state.org.organizationId = OTHER_ORG;
    writeFileSync(join(folder, 'state.json'), JSON.stringify(state));
    world.calls.length = 0;

    await refused(['plan', '--org', 'TGT'], 'OTHER_ORG');

    writeFileSync(join(folder, 'state.json'), '{ "half": ');
    await refused(['plan', '--org', 'TGT'], 'STATE_DAMAGED');
  });

  it('refuses to apply to a Developer Edition org it keeps no state of without --accept-no-state, and plans it saying so', async () => {
    worldOf();

    const planned = await run(['plan', '--org', 'DEV', '--json', '--quick']);
    expect(planned.code).toBe(0);
    expect(envPlanSchema.parse(planned.answer).refusal).toContain(
      'This machine keeps no state of case-flow on DEV',
    );

    const applied = await run(['apply', '--org', 'DEV', '--yes', '--json']);
    expect(applied.code).toBe(1);
    expect(envRunResultSchema.parse(applied.answer).refusal).toContain('--accept-no-state');
    expect(world.records('Account')).toEqual([]);

    const accepted = await run(['apply', '--org', 'DEV', '--yes', '--accept-no-state']);
    expect(accepted.code).toBe(0);
    expect(world.records('Account')).toHaveLength(2);
  });

  it('applies again to a Developer Edition org a destroy took everything back from, without --accept-no-state', async () => {
    // Deleted with its last record, the state left the next apply refused as
    // if a cache had been lost: a pipeline that destroys after each run gave
    // the flag every time, and the refusal kept nothing apart.
    worldOf();
    expect((await run(['apply', '--org', 'DEV', '--yes', '--accept-no-state'])).code).toBe(0);
    expect((await run(['destroy', '--org', 'DEV', '--yes'])).code).toBe(0);
    expect(world.records('Account')).toEqual([]);

    const again = await run(['apply', '--org', 'DEV', '--yes', '--json']);

    expect(again.code).toBe(0);
    expect(world.records('Account')).toHaveLength(2);
  });

  it('refuses every verb but validate with the journal directory inside the file’s repository, exit 2, before reaching the org', async () => {
    const inside = join(project, '.sandforge');

    const { code, answer } = await run(['plan', '--org', 'TGT', '--json'], { journalDir: inside });

    expect(code).toBe(2);
    expect(envRefusalAnswerSchema.parse(answer).refusal).toMatchObject({
      code: 'STORE_IN_REPOSITORY',
      message: expect.stringContaining('is inside the repository'),
    });
    expect(loadOrg).not.toHaveBeenCalled();
    expect((await run(['validate'], { journalDir: inside })).code).toBe(0);
  });

  it('refuses an apply while another holds the org on this machine, and warns a plan of it', async () => {
    worldOf({ sandbox: true, scratch: true });
    const held = acquireEnvLock(locksDir, ORG_ID, {
      operation: 'apply',
      env: 'case-flow',
      alias: 'TGT',
    });
    if (!('lock' in held)) throw new Error('not taken');
    try {
      const planned = await run(['plan', '--org', 'TGT', '--json']);
      expect(envPlanSchema.parse(planned.answer).warnings).toContainEqual(
        expect.stringContaining('an apply of case-flow to TGT is under way on this machine'),
      );

      const applied = await run(['apply', '--org', 'TGT', '--yes', '--json']);
      expect(applied.code).toBe(1);
      expect(envRunResultSchema.parse(applied.answer).refusal).toContain('is under way');
      expect(world.records('Account')).toEqual([]);
    } finally {
      held.lock.release();
    }
  });

  it('refuses a variable the file reads and the job does not set, naming it, exit 2', async () => {
    writeFileSync(
      fileOf,
      JSON.stringify(file({ orgs: { uat: { alias: { env: 'SFENV_UNSET_ALIAS' } } } })),
    );

    const { code, answer } = await run(['plan', '--org', 'TGT', '--json']);

    expect(code).toBe(2);
    const read = envRefusalAnswerSchema.parse(answer);
    expect(read.refusal.code).toBe('INVALID_FILE');
    expect(read.refusal.issues?.[0]?.message).toContain(
      'the variable SFENV_UNSET_ALIAS is not set',
    );
    expect(loadOrg).not.toHaveBeenCalled();

    const given = await run(['plan', '--org', 'TGT', '--alias', 'uat=UAT', '--quick', '--json']);
    expect(given.code).toBe(0);
  });

  it('refuses --replace naming no resource of the file, exit 2', async () => {
    const { code, answer } = await run(['apply', '--org', 'TGT', '--replace', 'cases', '--json']);

    expect(code).toBe(2);
    expect(envRefusalAnswerSchema.parse(answer).refusal.message).toBe(
      '--replace cases names no resource of the file: it has accounts, contacts.',
    );
  });
});
