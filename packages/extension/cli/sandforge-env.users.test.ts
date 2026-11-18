import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import {
  envAuditResultSchema,
  envOutputSchema,
  envPlanSchema,
  envRecoverResultSchema,
  envRefusalAnswerSchema,
  envRunResultSchema,
  usersApplyAnswerSchema,
  usersPlanAnswerSchema,
  usersRemoveAnswerSchema,
  type EnvPlan,
  type UsersChange,
  type UsersConfig,
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

import {
  openCheckpointStore,
  organizationKey,
} from '../src/modules/checkpoint/OrgCheckpointStore.js';
import { fabricateCheckpoint } from '../src/test/replayOrgs.js';
import { fakeAuditOrg, type FakeAuditOrgInit } from './env/audit/auditFakeOrg.js';
import { newEnvState, openEnvStore } from './env/envState.js';
import type { CommandRun, CommandRunner } from './scriptRunner.js';
import { loadOrg, makeConn } from './sfSession.js';
import { main, type EnvCliDeps } from './sandforge-env.js';
import { EnvWorld, type EnvWorldOptions } from './testing/envWorld.js';

/*
 * The users and replay resources of an environment on the command line, the
 * audits an apply reads and the note it writes: each verb run as a terminal
 * or a CI step runs it. `sandforge users` and `sandforge checkpoint replay`
 * answer through scripts of this test's own, which read their line as the
 * scripts do and answer by the contract's own schemas; the seed runs its own
 * `main` on the memory org. Every `--json` answer is read with its schema.
 */

const ORG_ID = '00D000000000009UAA';
const FORMER_ID = '00D000000000008UAA';
const T0 = Date.parse('2026-11-18T09:00:00.000Z');
const ENV = 'uat-after-refresh';
const PROFILE = '00e000000000001UAA';
const SANDBOX_HOST = 'acme--uat.sandbox.my.salesforce.com';

// ─── sandforge users, as this test answers it ───────────────────────────────

/** A user of the org, as the script reads it. */
interface OrgUser {
  username: string;
  userId: string;
  frozen: boolean;
  address: 'invalid' | 'awaiting';
  /** The permission sets it holds, by name, with the assignment's id. */
  sets: Map<string, string>;
}

/** A run the script kept: what it held, which its removal takes back. */
interface UsersRunKept {
  replaces?: number;
  replacedBy?: number;
  held: Array<{ user: OrgUser; change: UsersChange }>;
}

/**
 * `sandforge users`: plans what a run would change per user, refuses an
 * address asked back without `--accept-user-emails`, applies, converges from
 * the run `--replaces` names, and takes a run back by its number. Each run
 * begins its file in `<journal>/users/<Organization Id>/` before it writes,
 * as the script does.
 */
class UsersScript {
  readonly users: OrgUser[] = [
    {
      username: 'jane.qa@acme.com.uat',
      userId: '005000000000001UAA',
      frozen: true,
      address: 'invalid',
      sets: new Map(),
    },
    {
      username: 'erp.integration@acme.com.uat',
      userId: '005000000000002UAA',
      frozen: false,
      address: 'invalid',
      sets: new Map(),
    },
  ];
  readonly runs = new Map<number, UsersRunKept>();
  readonly lines: string[][] = [];
  /** The next apply is stopped once its run file is begun, before it answers. */
  kill = false;
  private next = 0;
  private assignments = 0;

  constructor(private readonly journalDir: () => string) {}

  private get org() {
    return { organizationId: ORG_ID, kind: 'sandbox' as const, username: 'admin@acme.com.uat' };
  }

  folder(): string {
    return join(this.journalDir(), 'users', organizationKey(ORG_ID));
  }

  /** Begin a run's file, as the script does before its first write. */
  beginFile(run: number, replaces?: number): void {
    mkdirSync(this.folder(), { recursive: true });
    writeFileSync(
      join(this.folder(), `run-${run}.json`),
      JSON.stringify({
        version: 1,
        organizationId: ORG_ID,
        run,
        ...(replaces !== undefined ? { replaces } : {}),
        status: 'running',
        startedAt: new Date().toISOString(),
        emailsToPeople: 0,
        users: [],
      }),
    );
  }

  private userOf(given: string): OrgUser {
    const found = this.users.find(
      (user) => user.username === given || user.username === `${given}.uat`,
    );
    if (found === undefined) throw new Error(`No user ${given}`);
    return found;
  }

  /** What a run would change, per user of the config, in the order it writes. */
  private planOf(config: UsersConfig): Array<{ user: OrgUser; changes: UsersChange[] }> {
    return config.users.map((entry) => {
      const settings = { ...config.defaults, ...entry };
      const user = this.userOf(entry.username);
      const changes: UsersChange[] = [];
      if (settings.frozen !== undefined && settings.frozen !== user.frozen) {
        changes.push({ what: 'frozen', from: user.frozen, to: settings.frozen });
      }
      for (const name of settings.permissionSets ?? []) {
        if (!user.sets.has(name)) changes.push({ what: 'permissionSet', name, to: 'added' });
      }
      if (settings.email === 'restore' && user.address === 'invalid') {
        changes.push({ what: 'email', to: 'awaiting' });
      }
      return { user, changes };
    });
  }

  readonly run = async (args: readonly string[]): Promise<CommandRun> => {
    this.lines.push([...args]);
    const value = (flag: string): string | undefined => {
      const at = args.indexOf(flag);
      return at >= 0 ? args[at + 1] : undefined;
    };
    if (args[0] === 'remove') return this.remove(Number(value('--run')));
    const config = JSON.parse(readFileSync(value('--config') ?? '', 'utf8')) as UsersConfig;
    const replaces = value('--replaces') !== undefined ? Number(value('--replaces')) : undefined;
    const planned = this.planOf(config);
    const emailsOf = (changes: UsersChange[]) =>
      changes.filter((change) => change.what === 'email').length;
    const emails = planned.reduce((sum, one) => sum + emailsOf(one.changes), 0);
    const refusals =
      emails > 0 && !args.includes('--accept-user-emails')
        ? [
            {
              code: 'USERS_EMAILS_NOT_ACCEPTED',
              message:
                `Salesforce would email ${emails} ${emails === 1 ? 'person' : 'people'}: the ` +
                'confirmation of each address asked back, a system email, which only the line ' +
                'accepts: --accept-user-emails, once those people may receive them',
            },
          ]
        : [];
    const answer = usersPlanAnswerSchema.parse({
      org: this.org,
      users: planned.map(({ user, changes }) => ({
        username: user.username,
        userId: user.userId,
        address: user.address,
        changes,
        ...(emailsOf(changes) > 0 ? { emailsToPeople: emailsOf(changes) } : {}),
      })),
      emailsToPeople: emails,
      apiRequests: 3,
      ...(refusals.length > 0 ? { refusals } : {}),
    });
    if (args[0] === 'plan' || refusals.length > 0) {
      return { code: refusals.length > 0 ? 1 : 0, stdout: JSON.stringify(answer), stderr: '' };
    }
    const run = ++this.next;
    this.beginFile(run, replaces);
    if (this.kill) {
      this.kill = false;
      return { code: 143, stdout: '', stderr: 'stopped by SIGTERM\n' };
    }
    const before = planned.map(({ user }) => ({ user, frozen: user.frozen }));
    const held: UsersRunKept['held'] = [];
    const created = new Map<OrgUser, string[]>();
    for (const { user, changes } of planned) {
      for (const change of changes) {
        if (change.what === 'frozen') user.frozen = change.to;
        if (change.what === 'email') user.address = 'awaiting';
        if (change.what === 'permissionSet') {
          const id = `0Pa${String(++this.assignments).padStart(12, '0')}UAA`;
          user.sets.set(change.name, id);
          created.set(user, [...(created.get(user) ?? []), id]);
        }
        held.push({ user, change });
      }
    }
    if (replaces !== undefined) {
      const replaced = this.runs.get(replaces);
      if (replaced !== undefined) {
        replaced.replacedBy = run;
        held.unshift(...replaced.held);
      }
    }
    this.runs.set(run, { ...(replaces !== undefined ? { replaces } : {}), held });
    const applied = usersApplyAnswerSchema.parse({
      org: this.org,
      run,
      status: 'success',
      users: planned.map(({ user, changes }) => ({
        username: user.username,
        userId: user.userId,
        before: {
          isActive: true,
          isFrozen: before.find((one) => one.user === user)?.frozen ?? false,
          profileId: PROFILE,
        },
        done: changes,
        created: { permissionSetAssignments: created.get(user) ?? [], groupMembers: [] },
        address: user.address,
      })),
      emailsToPeople: emails,
      apiRequests: 5,
    });
    return { code: 0, stdout: JSON.stringify(applied), stderr: '' };
  };

  private remove(number: number): CommandRun {
    const run = this.runs.get(number);
    if (run === undefined || run.replacedBy !== undefined) {
      return {
        code: 1,
        stdout: '',
        stderr: `sandforge users: run ${number} cannot be taken back\n`,
      };
    }
    const undone = new Map<OrgUser, UsersChange[]>();
    const kept = new Map<OrgUser, Array<{ change: UsersChange; why: string }>>();
    for (const { user, change } of [...run.held].reverse()) {
      if (change.what === 'frozen') {
        user.frozen = change.from;
        undone.set(user, [...(undone.get(user) ?? []), change]);
      } else if (change.what === 'permissionSet') {
        user.sets.delete(change.name);
        undone.set(user, [...(undone.get(user) ?? []), change]);
      } else {
        kept.set(user, [
          ...(kept.get(user) ?? []),
          { change, why: 'an address asked back is never put back under .invalid' },
        ]);
      }
    }
    this.runs.delete(number);
    // Its file keeps the removal, as the script's does.
    const kept_file = join(this.folder(), `run-${number}.json`);
    if (existsSync(kept_file)) {
      const record = JSON.parse(readFileSync(kept_file, 'utf8')) as Record<string, unknown>;
      writeFileSync(
        kept_file,
        JSON.stringify({
          ...record,
          removals: [
            { at: new Date().toISOString(), status: 'success', undone: 0, kept: 0, codes: [] },
          ],
        }),
      );
    }
    const users = [...new Set([...undone.keys(), ...kept.keys()])];
    const answer = usersRemoveAnswerSchema.parse({
      org: this.org,
      run: number,
      status: 'success',
      users: users.map((user) => ({
        username: user.username,
        userId: user.userId,
        undone: undone.get(user) ?? [],
        ...(kept.has(user) ? { kept: kept.get(user) } : {}),
      })),
      apiRequests: 2,
    });
    return { code: 0, stdout: JSON.stringify(answer), stderr: '' };
  }
}

// ─── sandforge checkpoint replay, as this test answers it ───────────────────

/** `sandforge checkpoint replay`: its dry run, its run held to a count, and its removal. */
function replayAnswer(args: readonly string[]): CommandRun {
  const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? '';
  const base = {
    command: 'replay',
    checkpoint: { id: value('--checkpoint'), organizationId: value('--from') },
    target: { alias: value('--target'), organizationId: ORG_ID },
    exit: 0,
  };
  const replay = {
    records: { toCreate: 9 },
    owners: { kept: 9, toRunningUser: 0 },
    filesLeft: [],
    requests: 4,
  };
  if (args.includes('--remove')) {
    const object = (objectApiName: string, n: number) => ({
      objectApiName,
      planned: n,
      deleted: n,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      reasons: [],
    });
    return {
      code: 0,
      stdout: JSON.stringify({
        ...base,
        action: 'remove',
        removal: { status: 'success', objects: [object('Contact', 6), object('Account', 3)] },
      }),
      stderr: '',
    };
  }
  if (args.includes('--dry-run')) {
    const object = (objectApiName: string, n: number) => ({
      objectApiName,
      fromFiles: n,
      toInsert: n,
      toLink: 0,
      notSent: 0,
      toPurge: 0,
    });
    return {
      code: 0,
      stdout: JSON.stringify({
        ...base,
        action: 'dryRun',
        objects: [object('Account', 3), object('Contact', 6)],
        replay,
      }),
      stderr: '',
    };
  }
  const object = (objectApiName: string, n: number) => ({
    objectApiName,
    fromFiles: n,
    inserted: n,
    failed: 0,
  });
  return {
    code: 0,
    stdout: JSON.stringify({
      ...base,
      action: 'replay',
      status: 'success',
      objects: [object('Account', 3), object('Contact', 6)],
      replay,
    }),
    stderr: '',
  };
}

// ─── The world ───────────────────────────────────────────────────────────────

let dir: string;
let project: string;
let journalDir: string;
let locksDir: string;
let journalBefore: string | undefined;
let world: EnvWorld;
let users: UsersScript;
let replays: string[][];
let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;
/** The order the scripts ran in, by name and first word. */
let calls: string[];

/** A seed listed first, then the testers: the file's order, not the apply's. */
function file(over: Record<string, unknown> = {}, testers: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: ENV,
    resources: {
      'demo-accounts': {
        kind: 'seed',
        seed: 1,
        objects: [
          {
            object: 'Account',
            count: 1,
            fields: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Demo' } }],
          },
        ],
      },
      testers: {
        kind: 'users',
        defaults: { email: 'restore', frozen: false },
        users: [
          { username: 'jane.qa@acme.com', permissionSets: ['QA_Tools'] },
          { username: 'erp.integration@acme.com', email: 'keep', frozen: true },
        ],
        ...testers,
      },
    },
    ...over,
  };
}

function writeFile(document: unknown): void {
  writeFileSync(join(project, 'sandforge.yaml'), JSON.stringify(document, null, 2));
}

function worldOf(options: EnvWorldOptions = { sandbox: true, scratch: true }): void {
  world = new EnvWorld({
    organizationId: ORG_ID,
    tick: () => vi.setSystemTime(Date.now() + 30_000),
    ...options,
  });
}

/** The org reached on a sandbox's My Domain host, as the sf CLI's session names it. */
function onSandboxHost(): void {
  const loaded = vi.mocked(loadOrg).getMockImplementation();
  vi.mocked(loadOrg).mockImplementation(async (alias: string) => ({
    ...(await loaded?.(alias)),
    alias,
    username: 'admin@acme.com.uat',
    instanceUrl: `https://${SANDBOX_HOST}`,
    accessToken: 'token',
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-users-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFile(file());
  journalDir = join(dir, 'journal');
  locksDir = join(dir, 'locks');
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  worldOf();
  users = new UsersScript(() => journalDir);
  replays = [];
  calls = [];
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

/** The scripts the environment runs: users and replay this test's, every other the world's. */
const runner: CommandRunner = async (script, args, signal) => {
  calls.push(`${script} ${args[0] ?? ''}${args.includes('--dry-run') ? ' --dry-run' : ''}`);
  if (script === 'sandforge-users') return users.run(args);
  if (script === 'sandforge-checkpoint' && args[0] === 'replay') {
    replays.push([...args]);
    return replayAnswer(args);
  }
  return world.runner(script, args, signal);
};

const deps = (over: Partial<EnvCliDeps> = {}): EnvCliDeps => ({
  runner,
  journalDir,
  locksDir,
  onStop: () => () => undefined,
  cwd: project,
  ...over,
});

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

async function stateOf(organizationId = ORG_ID) {
  const opened = openEnvStore({ journalDir, fileFolder: project });
  if (!('store' in opened)) throw new Error(opened.refusal);
  return { store: opened.store, state: await opened.store.read(organizationId, ENV) };
}

/** The lines of `sandforge users` that write: applies and removals. */
const usersWrites = (): string[][] => users.lines.filter((line) => line[0] !== 'plan');

// ─── A users resource ────────────────────────────────────────────────────────

describe('a users resource', () => {
  it('is planned first whatever the file’s order, each user with what a run would change, and the emails to people summed, which the line alone accepts', async () => {
    const ran = await run(['plan', '--org', 'TGT', '--json']);
    const planned = envPlanSchema.parse(ran.answer);

    expect(ran.code).toBe(0);
    expect(planned.actions.map((action) => [action.resource, action.action])).toEqual([
      ['testers', 'create'],
      ['demo-accounts', 'create'],
    ]);
    const testers = planned.actions[0];
    expect(testers).toMatchObject({
      kind: 'users',
      objects: [{ object: 'User', wouldCreate: 2 }],
      gates: { emailsToPeople: 1 },
      users: [
        {
          username: 'jane.qa@acme.com.uat',
          changes: [
            { what: 'frozen', from: true, to: false },
            { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
            { what: 'email', to: 'awaiting' },
          ],
          emailsToPeople: 1,
        },
        { username: 'erp.integration@acme.com.uat', changes: [{ what: 'frozen', to: true }] },
      ],
    });
    // Not a block of the resource: the plan's own gate, summed, in its own words.
    expect(testers?.refusal).toBeUndefined();
    expect(planned.totals.blocked).toBe(0);
    expect(planned.gates.emailsToPeople).toEqual({ count: 1, accepted: false });
    expect(planned.refusal).toBe(
      'testers has Salesforce email 1 person (the confirmation of an address asked back), ' +
        'which only the line accepts: --accept-user-emails. Nothing was written.',
    );
    expect(planned.refusalCodes).toEqual(['USERS_EMAILS_NOT_ACCEPTED']);
    // Its plan is the script's own, as the run would be given: no line accepts for it.
    expect(users.lines[0]?.[0]).toBe('plan');
    expect(users.lines[0]).not.toContain('--accept-user-emails');
    expect(ran.said).toContain(
      '  create   testers  User 2 to set up\n' +
        '           not applied to this org yet\n' +
        '           jane.qa@acme.com.uat: unfrozen, permission set QA_Tools added, address asked ' +
        'back, awaiting its owner’s confirmation\n' +
        '           erp.integration@acme.com.uat: frozen\n' +
        "           Salesforce sends 1 email to a person: the confirmation of jane.qa@acme.com.uat's " +
        'address asked back, a system email, which leaves under System email only too\n',
    );
    expect(ran.said).toContain(
      'emails to people: 1, which the line accepts with --accept-user-emails\n',
    );
    expect(ran.said).toContain(
      'an apply now would be refused: testers has Salesforce email 1 person (the confirmation ' +
        'of an address asked back), which only the line accepts: --accept-user-emails. Nothing ' +
        'was written.\n',
    );
    expect(usersWrites()).toEqual([]);
  });

  it('refuses the apply without --accept-user-emails, exit 1, before any script writes', async () => {
    const applied = await apply();

    expect(applied.code).toBe(1);
    expect(applied.result.refusalCodes).toEqual(['USERS_EMAILS_NOT_ACCEPTED']);
    expect(usersWrites()).toEqual([]);
    expect(world.records('Account')).toEqual([]);
    expect((await stateOf()).state).toBeUndefined();
  });

  it('applies the users before every other resource, the line’s accord handed to their script, says each address awaiting its owner’s click, and applied again writes nothing', async () => {
    const applied = await apply('--accept-user-emails');

    expect(applied.code, applied.said).toBe(0);
    expect(calls.filter((call) => !call.endsWith('--dry-run') && !call.endsWith(' plan'))).toEqual([
      'sandforge-users apply',
      'sandforge-seed --target',
    ]);
    expect(usersWrites()[0]).toEqual(expect.arrayContaining(['--accept-user-emails', '--yes']));
    expect(applied.result.plan.gates.emailsToPeople).toEqual({ count: 1, accepted: true });
    expect(applied.said).toContain(
      '  testers run 1: exit 0, applied  User 2 set up\n' +
        "      jane.qa@acme.com.uat: address awaiting its owner's confirmation — Salesforce sent " +
        'the link to it; until it is clicked (72 h), the address stays .invalid\n',
    );
    const state = (await stateOf()).state;
    expect(state?.resources['testers']).toMatchObject({
      kind: 'users',
      status: 'applied',
      runs: [{ n: 1, script: 'sandforge-users', summary: 'runs/testers/1.summary.json' }],
    });

    // Applied again: its plan, the last run named, finds every user as it left them.
    const again = await plan('--fail-on-change', '--accept-user-emails');
    expect(again.code, again.said).toBe(0);
    expect(again.plan.actions.find((action) => action.resource === 'testers')).toMatchObject({
      action: 'keep',
      why: 'applied, and the org holds its 2 user(s) as the last run left them',
      objects: [{ object: 'User', present: 2 }],
    });
    expect(users.lines.at(-1)).toEqual(expect.arrayContaining(['plan', '--replaces', '1']));
    const before = usersWrites().length;
    const serial = state?.serial;
    expect((await apply('--accept-user-emails')).code).toBe(0);
    expect(usersWrites()).toHaveLength(before);
    expect((await stateOf()).state?.serial).toBe(serial);
  });

  it('says drift once a user is frozen again, and --replace-drifted converges from the last run, which is taken back with it', async () => {
    expect((await apply('--accept-user-emails')).code).toBe(0);
    const jane = users.users[0];
    if (jane !== undefined) jane.frozen = true;

    const drifted = await plan('--fail-on-drift', '--accept-user-emails');
    expect(drifted.code).toBe(3);
    expect(drifted.plan.actions.find((action) => action.resource === 'testers')).toMatchObject({
      action: 'drifted',
      why:
        'its users changed since it was applied: jane.qa@acme.com.uat would be unfrozen. Left ' +
        'as they are: --replace testers or --replace-drifted sets them up again, converging ' +
        'from what the last run left',
    });

    const replaced = await apply('--replace-drifted', '--accept-user-emails');
    expect(replaced.code, replaced.said).toBe(0);
    expect(usersWrites().at(-1)).toEqual(
      expect.arrayContaining(['apply', '--replaces', '1', '--yes']),
    );
    // Nothing taken back first: a replace converges, in one run.
    expect(usersWrites().filter((line) => line[0] === 'remove')).toEqual([]);
    expect((await stateOf()).state?.resources['testers']?.runs).toMatchObject([
      { n: 1, takenBack: true },
      { n: 2 },
    ]);
    expect(jane?.frozen).toBe(false);
  });

  it('is taken back after every other resource by its last run alone, saying what was deleted and put back, never an address', async () => {
    expect((await apply('--accept-user-emails')).code).toBe(0);

    const destroyed = await destroy();

    expect(destroyed.code, destroyed.said).toBe(0);
    expect(destroyed.result.plan.actions.map((action) => action.resource)).toEqual([
      'demo-accounts',
      'testers',
    ]);
    expect(destroyed.result.plan.actions[1]?.why).toBe(
      'taken back: the assignments and memberships the environment created deleted by id, each ' +
        'user put back as it was before; an address asked back stays, and no user is deleted, ' +
        'after every other resource',
    );
    // The seed's preview and removal, then the users': taken back last.
    expect(calls.filter((call) => call.endsWith(' remove') || call.includes('--remove'))).toEqual([
      'sandforge-seed --remove',
      'sandforge-seed --remove',
      'sandforge-users remove',
    ]);
    expect(usersWrites().at(-1)).toEqual(
      expect.arrayContaining(['remove', '--run', '1', '--yes', '--json']),
    );
    expect(destroyed.said).toContain(
      '  testers removal of run 1: exit 0, destroyed  PermissionSetAssignment 1 deleted; 3 ' +
        'change(s) of its users put back, the deletions among them\n' +
        '      jane.qa@acme.com.uat: address asked back, awaiting its owner’s confirmation ' +
        'kept, an address asked back is never put back under .invalid\n',
    );
    expect(users.users.map((user) => user.frozen)).toEqual([true, false]);
    expect(users.users[0]?.address).toBe('awaiting');
  });

  it('takes back a run stopped before it answered by the one run file its script began, and names two, never guessing', async () => {
    users.kill = true;
    const stopped = await apply('--accept-user-emails');
    expect(stopped.code).toBe(143);
    expect((await stateOf()).state?.resources['testers']).toMatchObject({
      status: 'applying',
      runs: [{ n: 1, script: 'sandforge-users' }],
    });
    expect((await stateOf()).state?.resources['testers']?.runs[0]?.summary).toBeUndefined();
    // Its run wrote nothing in this test's script; the removal is asked all the same.
    users.runs.set(1, { held: [] });

    const destroyed = await destroy();
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(usersWrites().at(-1)).toEqual(expect.arrayContaining(['remove', '--run', '1']));

    // Negative control: two run files begun since, and nobody can say which is its.
    rmSync(join(journalDir, 'env'), { recursive: true, force: true });
    users.kill = true;
    expect((await apply('--accept-user-emails', '--accept-no-state')).code).toBe(143);
    users.beginFile(9);
    const removals = usersWrites().filter((line) => line[0] === 'remove').length;
    const unknown = await destroy();
    expect(unknown.code).toBe(3);
    expect(unknown.said).toContain(
      'testers: run 1 is not taken back: its run 1 stopped before it answered, and 2 runs of ' +
        'pnpm exec tsx packages/extension/cli/sandforge-users.ts began on this machine after it ' +
        'was launched (2, 9): which is its, nobody can say.',
    );
    expect(usersWrites().filter((line) => line[0] === 'remove')).toHaveLength(removals);
  });

  it('is rebuilt by state recover from its runs’ answers, marked to replace, and the replace converges with nothing to change', async () => {
    expect((await apply('--accept-user-emails')).code).toBe(0);
    unlinkSync(join((await stateOf()).store.folderOf(ORG_ID, ENV), 'state.json'));

    const recovered = await run(['state', 'recover', '--org', 'TGT', '--json']);
    expect(recovered.code, recovered.said).toBe(0);
    expect(envRecoverResultSchema.parse(recovered.answer).resources['testers']).toEqual({
      kind: 'users',
      status: 'applied',
      runs: [1],
      takenBack: [],
      inFile: true,
    });

    const replanned = await plan('--accept-user-emails');
    expect(replanned.plan.actions.find((action) => action.resource === 'testers')).toMatchObject({
      action: 'replace',
      objects: [{ object: 'User', wouldCreate: 0 }],
    });
    const applied = await apply('--accept-user-emails');
    expect(applied.code, applied.said).toBe(0);
    expect(usersWrites().at(-1)).toEqual(expect.arrayContaining(['apply', '--replaces', '1']));
    expect(applied.said).toContain('  testers run 2: exit 0, applied  User 0 set up\n');
  });

  it('names in output the users its last run set up, by username and id alone', async () => {
    expect((await apply('--accept-user-emails')).code).toBe(0);

    const ran = await run(['output', '--org', 'TGT', '--json']);

    expect(ran.code).toBe(0);
    expect(envOutputSchema.parse(ran.answer).resources['testers']).toEqual({
      kind: 'users',
      status: 'applied',
      run: 1,
      records: {},
      users: [
        { username: 'jane.qa@acme.com.uat', userId: '005000000000001UAA' },
        { username: 'erp.integration@acme.com.uat', userId: '005000000000002UAA' },
      ],
      why: 'a users resource creates no record of its own: it sets up users the org holds, named here',
    });
  });

  it('keeps --accept-user-emails with a saved plan, which apply --plan hands to the users’ script', async () => {
    const out = join(dir, 'uat.plan.json');
    const planned = await run([
      'plan',
      '--org',
      'TGT',
      '--json',
      '--accept-user-emails',
      '--out',
      out,
    ]);
    expect(planned.code, planned.said).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
      line: { acceptUserEmails: true },
    });

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json', '--plan', out]);

    expect(applied.code, applied.said).toBe(0);
    expect(usersWrites()[0]).toContain('--accept-user-emails');
  });
});

// ─── A replay resource ───────────────────────────────────────────────────────

describe('a replay resource', () => {
  const CHECKPOINT = 'ck-20261114-174750-5e38';

  function replayFile(checkpoint: Record<string, unknown>) {
    return {
      version: 1,
      name: ENV,
      resources: { 'test-data': { kind: 'replay', checkpoint } },
    };
  }

  /** A checkpoint of another org, kept on this machine as a take leaves one. */
  async function kept(): Promise<void> {
    const opened = openCheckpointStore({ root: join(journalDir, 'checkpoints'), locksDir });
    if ('refusal' in opened) throw new Error(opened.refusal.reason);
    await fabricateCheckpoint(opened.store, {
      checkpointId: CHECKPOINT,
      name: 'uat-before-refresh',
      org: { organizationId: FORMER_ID },
      objects: [
        {
          objectApiName: 'Account',
          rows: [{ Id: '001000000000001UAA', Name: 'Kept account' }],
        },
      ],
    });
  }

  it('is blocked, in the refusal’s words, when this machine keeps no checkpoint it names, before any dry run', async () => {
    writeFile(replayFile({ name: 'uat-before-refresh' }));

    const planned = await plan();

    expect(planned.plan.actions[0]).toMatchObject({ resource: 'test-data', action: 'blocked' });
    expect(planned.plan.actions[0]?.refusal).toContain(
      "no checkpoint of TGT before its refresh named 'uat-before-refresh' is kept on this machine",
    );
    expect(replays).toEqual([]);
    expect((await apply()).code).toBe(1);
    expect(replays).toEqual([]);
  });

  it('replays the checkpoint the plan resolved by its id, held to its dry run’s count, and is taken back by the replay’s own removal', async () => {
    await kept();
    writeFile(replayFile({ id: CHECKPOINT }));

    const applied = await apply();

    expect(applied.code, applied.said).toBe(0);
    const store = join(journalDir, 'checkpoints');
    // The org it was taken of, by the Id its store keeps.
    const from = replays[0]?.[4] ?? '';
    expect(from.slice(0, 15)).toBe(FORMER_ID.slice(0, 15));
    expect(replays[0]).toEqual([
      'replay',
      '--checkpoint',
      CHECKPOINT,
      '--from',
      from,
      '--target',
      'TGT',
      '--store',
      store,
      '--dry-run',
      '--json',
    ]);
    expect(replays[1]).toEqual([
      'replay',
      '--checkpoint',
      CHECKPOINT,
      '--from',
      from,
      '--target',
      'TGT',
      '--store',
      store,
      '--max-records',
      '9',
      '--yes',
      '--json',
    ]);
    expect(applied.said).toContain(
      '  test-data replay 1: exit 0, applied  Account 3, Contact 6 created; 9 records kept their ' +
        'owner, 0 went to you\n',
    );
    // The payload it was given names what it replays: a removal of a replay
    // stopped before it answered is named by it.
    const folder = (await stateOf()).store.folderOf(ORG_ID, ENV);
    expect(JSON.parse(readFileSync(join(folder, 'templates', 'test-data.1.json'), 'utf8'))).toEqual(
      { command: 'replay', checkpoint: { id: CHECKPOINT, organizationId: from } },
    );

    const destroyed = await destroy();
    expect(destroyed.code, destroyed.said).toBe(0);
    expect(replays.at(-1)).toEqual(
      expect.arrayContaining(['--checkpoint', CHECKPOINT, '--remove', '--yes', '--json']),
    );
  });
});

// ─── The audits and the handoff note ─────────────────────────────────────────

describe('the audits an apply reads and the note it writes', () => {
  /** The org's answers to the audits: one endpoint that still names production. */
  const AUDITED: FakeAuditOrgInit = {
    deliverability: 'closed',
    data: {
      CronTrigger: {
        columns: [
          'CronJobDetail.Name',
          'CronJobDetail.JobType',
          'CronExpression',
          'State',
          'NextFireTime',
          'PreviousFireTime',
          'OwnerId',
        ],
        rows: [],
      },
    },
    tooling: {
      NamedCredential: {
        columns: ['DeveloperName', 'Endpoint', 'PrincipalType'],
        rows: [
          {
            DeveloperName: 'ERP_API',
            Endpoint: 'https://erp.acme.com/api?key=abc123',
            PrincipalType: 'NamedUser',
          },
        ],
      },
      RemoteProxy: { columns: ['SiteName', 'EndpointUrl', 'IsActive'], rows: [] },
    },
  };

  /** The org reached as the sf CLI reaches it, the audits' requests answered by the fake org. */
  function reachAudited(init: FakeAuditOrgInit = AUDITED): EnvCliDeps['reach'] {
    const fake = fakeAuditOrg(init);
    return async (alias) => {
      const session = await loadOrg(alias);
      const conn = makeConn(session) as unknown as Record<string, unknown> & {
        request: (request: unknown) => Promise<unknown>;
      };
      const audited = {
        ...conn,
        request: async (request: unknown) => {
          const url = typeof request === 'string' ? request : (request as { url: string }).url;
          return url.startsWith('/query?') || url.startsWith('/tooling/')
            ? fake.transport.request({ method: 'GET', url })
            : conn.request(request);
        },
      };
      return { session, conn: audited as unknown as Connection };
    };
  }

  function audited(audits: Record<string, unknown>) {
    return {
      version: 1,
      name: ENV,
      audits,
      resources: {
        'demo-accounts': {
          kind: 'seed',
          seed: 1,
          objects: [
            {
              object: 'Account',
              count: 1,
              fields: [
                { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Demo' } },
              ],
            },
          ],
        },
      },
    };
  }

  it('reads them once the apply ended, never in its exit code, and writes the handoff note on this machine, its owner’s alone', async () => {
    writeFile(
      audited({ schedules: true, endpoints: { productionHosts: ['erp.acme.com'] }, handoff: true }),
    );
    onSandboxHost();

    const planned = await run(['plan', '--org', 'TGT'], { reach: reachAudited() });
    expect(planned.out).toContain(
      'audits after the apply: deliverability, scheduled jobs, endpoints, about 4 to 7 API ' +
        'requests; then the handoff note\n',
    );

    const applied = await run(['apply', '--org', 'TGT', '--yes', '--json'], {
      reach: reachAudited(),
    });

    // Findings are said, and the apply ends as its steps ended.
    expect(applied.code, applied.said).toBe(0);
    const result = envRunResultSchema.parse(applied.answer);
    expect(envAuditResultSchema.parse(result.audits)).toMatchObject({
      org: { organizationId: ORG_ID, host: SANDBOX_HOST },
      deliverability: { read: 'closed' },
      endpoints: { found: [{ name: 'ERP_API', url: 'https://erp.acme.com/api', why: 'listed' }] },
      findings: 1,
    });
    expect(applied.said).toContain('audits: 1 endpoint(s) still name production (below)\n');
    const path = result.handoff?.path ?? '';
    expect(path.startsWith(join(journalDir, 'handoff', ENV))).toBe(true);
    expect(applied.said).toContain(`handoff note: ${path}\napply: success; state serial `);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const note = readFileSync(path, 'utf8');
    expect(note).toContain(`# Handoff: \`${ENV}\` on \`TGT\``);
    // A URL's query is never kept: the key it carried is in no line, answer or note.
    for (const said of [applied.out, applied.said, note]) expect(said).not.toContain('abc123');
  });

  it('says an audit the org would not answer not read, the apply ending 0 all the same', async () => {
    writeFile(audited({ schedules: true }));

    const applied = await apply();

    expect(applied.code, applied.said).toBe(0);
    expect(applied.result.audits?.schedules?.unread).toBeDefined();
    expect(applied.said).toContain('; not read: ');
  });

  it('writes the note where --handoff says, refused inside the repository unless --out-in-repository, before any org is reached', async () => {
    writeFile(audited({}));
    const inside = join(project, 'notes', 'handoff.md');
    mkdirSync(join(project, 'notes'));

    vi.mocked(loadOrg).mockClear();
    const refused = await run(['apply', '--org', 'TGT', '--yes', '--json', '--handoff', inside]);
    expect(refused.code).toBe(2);
    expect(envRefusalAnswerSchema.parse(refused.answer).refusal.code).toBe('HANDOFF_IN_REPOSITORY');
    expect(vi.mocked(loadOrg)).not.toHaveBeenCalled();

    const kept = await run([
      'apply',
      '--org',
      'TGT',
      '--yes',
      '--json',
      '--handoff',
      inside,
      '--out-in-repository',
    ]);
    expect(kept.code, kept.said).toBe(0);
    expect(envRunResultSchema.parse(kept.answer).handoff).toEqual({ path: inside });
    expect(existsSync(inside)).toBe(true);
  });

  it('env audit reads every part the file does not turn off, writes nothing, and --fail-on-findings ends 3 on what it found', async () => {
    writeFile(audited({ endpoints: { productionHosts: ['erp.acme.com'] } }));
    onSandboxHost();

    const read = await run(['audit', '--org', 'TGT', '--json'], { reach: reachAudited() });
    expect(read.code, read.said).toBe(0);
    expect(envAuditResultSchema.parse(read.answer)).toMatchObject({
      org: { organizationId: ORG_ID, host: SANDBOX_HOST },
      findings: 1,
    });
    expect(read.said).toContain('audit of TGT (scratch org, 00D000000000009UAA), ');
    expect(calls).toEqual([]);

    const failing = await run(['audit', '--org', 'TGT', '--json', '--fail-on-findings'], {
      reach: reachAudited(),
    });
    expect(failing.code).toBe(3);

    // Negative control: nothing to find, nothing to fail on.
    const clean = await run(['audit', '--org', 'TGT', '--json', '--fail-on-findings'], {
      reach: reachAudited({
        ...AUDITED,
        tooling: {
          ...AUDITED.tooling,
          NamedCredential: { columns: ['DeveloperName', 'Endpoint', 'PrincipalType'], rows: [] },
        },
      }),
    });
    expect(clean.code, clean.said).toBe(0);
  });

  it('env audit --save is refused, exit 2, when the file reads no scheduled jobs', async () => {
    writeFile(audited({ schedules: false }));

    const refused = await run(['audit', '--org', 'TGT', '--json', '--save']);

    expect(refused.code).toBe(2);
    expect(envRefusalAnswerSchema.parse(refused.answer).refusal.code).toBe('BAD_LINE');
  });
});

// ─── A sandbox listed by its My Domain, and refreshed ───────────────────────

describe('a sandbox listed by its My Domain', () => {
  function listed() {
    return {
      version: 1,
      name: ENV,
      targets: { kinds: ['sandbox'], sandboxes: [{ myDomain: 'acme--uat' }] },
      resources: {
        'demo-accounts': {
          kind: 'seed',
          seed: 1,
          objects: [
            {
              object: 'Account',
              count: 1,
              fields: [
                { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Demo' } },
              ],
            },
          ],
        },
      },
    };
  }

  /** The state this machine kept of the sandbox before its refresh, under its former Id. */
  async function keptBeforeRefresh(): Promise<string> {
    const { store } = await stateOf();
    const before = newEnvState({
      env: ENV,
      org: {
        organizationId: FORMER_ID,
        kind: 'sandbox',
        username: 'admin@acme.com.uat',
        alias: 'TGT',
        host: SANDBOX_HOST,
      },
      fileDigest: 'a'.repeat(64),
      sandforgeVersion: '1.82.0',
    });
    await store.write(before, { serial: 0, lineage: before.lineage });
    return store.folderOf(FORMER_ID, ENV);
  }

  beforeEach(() => {
    worldOf({ sandbox: true, edition: 'Developer Edition' });
    onSandboxHost();
    writeFile(listed());
  });

  it('is planned, the plan naming its My Domain and saying it is listed by it', async () => {
    const ran = await run(['plan', '--org', 'TGT', '--json', '--accept-no-state']);
    const planned = envPlanSchema.parse(ran.answer);

    expect(ran.code, ran.said).toBe(0);
    expect(planned.org).toMatchObject({ kind: 'sandbox', host: SANDBOX_HOST });
    expect(planned.warnings).toContain('TGT: listed by its My Domain');
    expect(ran.said).toContain(`plan of ${ENV} on TGT (sandbox acme--uat, ${ORG_ID})\n`);
  });

  it('applies anew without --accept-no-state once a state of it under its former Id on the same host proves its refresh, set aside, kept', async () => {
    const setAside = await keptBeforeRefresh();

    const ran = await run(['plan', '--org', 'TGT', '--json']);
    const planned = envPlanSchema.parse(ran.answer);
    expect(ran.code, ran.said).toBe(0);
    expect(planned.refusal).toBeUndefined();
    expect(planned.state).toMatchObject({
      found: false,
      refreshed: {
        organizationId: expect.stringMatching(new RegExp(`^${FORMER_ID.slice(0, 15)}`)),
        serial: 1,
        setAside,
      },
    });
    expect(planned.warnings).toContain(
      'TGT: listed by its My Domain; its Organization Id changed since the last apply',
    );
    expect(ran.said).toContain(
      `state: none for this Organization Id; TGT was refreshed since the last apply, which this ` +
        `machine kept under ${planned.state.refreshed?.organizationId ?? ''} (serial 1, 2026-11-18): the refresh took what it held, ` +
        `and this apply starts anew. That state is set aside, kept: ${setAside}\n`,
    );

    const applied = await apply();
    expect(applied.code, applied.said).toBe(0);
    expect((await stateOf()).state?.org.host).toBe(SANDBOX_HOST);
    // The state of before the refresh is where it was.
    expect((await stateOf(FORMER_ID)).state?.serial).toBe(1);
  });

  it('is refused, as today, with no state it can prove refreshed: --accept-no-state lifts it', async () => {
    const ran = await run(['plan', '--org', 'TGT', '--json']);

    expect(envPlanSchema.parse(ran.answer).refusalCodes).toEqual(['NO_STATE']);
  });

  it('keeps its host in a saved plan, the My Domain the file names, and none when the file lists it by its Id', async () => {
    const out = join(dir, 'uat.plan.json');
    expect(
      (await run(['plan', '--org', 'TGT', '--json', '--accept-no-state', '--out', out])).code,
    ).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).plan.org.host).toBe(SANDBOX_HOST);

    // Listed by its Id alone, the host is not kept: it names the client.
    writeFile({ ...listed(), targets: { kinds: ['sandbox'], sandboxes: [ORG_ID] } });
    expect(
      (await run(['plan', '--org', 'TGT', '--json', '--accept-no-state', '--out', out])).code,
    ).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).plan.org.host).toBeUndefined();
  });
});

describe('the order of a file', () => {
  it('validate says a users resource is applied first', async () => {
    const ran = await run(['validate']);

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('  testers: User 2, applied first\n');
    expect(readdirSync(dir)).not.toContain('journal');
  });
});
