/**
 * A run of `sandforge-seed` on the emails of what still runs as its records
 * go in (`--accept-emails`), through the real orchestrator over a fake org:
 * whether the org delivers them read once the mute's plan says what does, and
 * only when something may send one; refused, exit 1, nothing written, without
 * the flag, which `--accept-automation` never stands for; the read counted
 * with the seed's requests; each step counted in the order it was made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation, MutedAutomation } from '@sandforge/shared';
import { mutePlanOf, stillRunningOf } from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({
    alias,
    username: `${alias}@example.invalid`,
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
  })),
  makeConn: vi.fn(),
}));

/** Every step a run makes, in the order it makes it. */
const steps: string[] = [];
/** What the target runs on the objects read, as the tests set it. */
let automationOf: (objects: readonly string[]) => ForgeTargetAutomation;

vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async (_target: string, objects: readonly string[]) => {
      steps.push('automation read');
      return automationOf(objects);
    },
  })),
}));
// The mute's lease, as the run asks it: tested on its own, here in the
// order the run calls it.
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { makeConn } from './sfSession.js';
import { main, parseArgs } from './sandforge-seed.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { EMAIL_NOT_PERMITTED } from '../src/modules/forge/targetDeliverability.js';

/** A field as the fake org describes it. */
const field = (name: string, type: string, over: Record<string, unknown> = {}) => ({
  name,
  type,
  createable: true,
  nillable: true,
  defaultedOnCreate: false,
  length: 80,
  referenceTo: [],
  picklistValues: [],
  ...over,
});

const DESCRIBES: Record<string, unknown> = {
  Account: {
    name: 'Account',
    createable: true,
    recordTypeInfos: [],
    fields: [
      field('Id', 'id', { createable: false, nillable: false }),
      field('Name', 'string', { nillable: false }),
    ],
  },
  Contact: {
    name: 'Contact',
    createable: true,
    recordTypeInfos: [],
    fields: [
      field('Id', 'id', { createable: false, nillable: false }),
      field('LastName', 'string', { nillable: false }),
      field('AccountId', 'reference', { referenceTo: ['Account'], length: 18 }),
    ],
  },
};

/** A target whose contacts each get a welcome email, which a set's bypass keeps quiet. */
const welcoming = (objects: readonly string[]): ForgeTargetAutomation => ({
  objectsRead: [...objects],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Welcome_Email',
          label: 'Welcome Email',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Org_Bypass', bypass: true, held: false }],
          messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Org_Bypass',
      permissionSets: [{ name: 'Org_Bypass_Set', label: 'Org bypass', grants: 1 }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 1,
});

/** The same target, its welcome email sent whatever the user holds. */
const welcomingAll = (objects: readonly string[]): ForgeTargetAutomation => {
  const read = welcoming(objects);
  return {
    ...read,
    objects: read.objects.map((object) => ({
      ...object,
      flows: object.flows.map((flow) => ({ ...flow, permissions: [] })),
    })),
  };
};

const ALL_EMAIL = { compiled: true, success: true };
const CLOSED = { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };

/**
 * A sandbox with `requests` daily API requests left, that takes every record
 * it is sent, answers its anonymous Apex with `apex`, and puts each step
 * down in `steps`; a production org when `production` says.
 */
function fakeOrg(apex: unknown = ALL_EMAIL, requests = 15_000, production = false): void {
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  vi.mocked(makeConn).mockReturnValue({
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (sent: unknown[]) => {
        steps.push(`write ${name}`);
        return sent.map(() => ({ success: true, id: `001${String(made++).padStart(12, '0')}AAA` }));
      },
    }),
    describe: async (name: string) => DESCRIBES[name],
    describeGlobal: async () => ({
      sobjects: Object.keys(DESCRIBES).map((name) => ({ name, createable: true })),
    }),
    query: async (soql: string) =>
      soql.includes('DefaultLocaleSidKey')
        ? page([{ DefaultLocaleSidKey: 'en_US' }])
        : soql.includes('OrganizationType')
          ? page([{ OrganizationType: 'Enterprise Edition' }])
          : soql.includes('FROM Organization')
            ? page([{ Id: '00D000000000002AAA', IsSandbox: !production }])
            : page([]),
    tooling: { query: async () => page([]) },
    request: async (request: { url: string }) => {
      if (request.url.startsWith('/tooling/executeAnonymous')) {
        steps.push('deliverability read');
        return apex;
      }
      if (request.url.includes('UserPermissionAccess')) {
        return { records: [{ PermissionsEmailSingle: true }] };
      }
      steps.push('limits read');
      return {
        DataStorageMB: { Max: 200, Remaining: 200 },
        DailyApiRequests: { Max: 15_000, Remaining: requests },
        SingleEmail: { Max: 15, Remaining: 15 },
      };
    },
  } as unknown as Connection);
}

/** A mute planned from what the target runs, whose lease holds `assigned` once read back: the plan's set, unless told. */
function muteOf(assigned: string[] = ['Org_Bypass_Set']): void {
  vi.mocked(muteForRun).mockImplementation((async (
    _org: unknown,
    read: ForgeTargetAutomation,
    options: { writes: Parameters<typeof mutePlanOf>[1] },
  ) => {
    steps.push('lease plan');
    const plan = mutePlanOf(read, options.writes);
    const held: MutedAutomation = {
      state: 'muted',
      assigned,
      held: [],
      permissions: ['Org_Bypass'],
      silenced: [],
      stillRan: [],
    };
    return {
      automation: stillRunningOf(read, plan).automation,
      muted: held,
      plan,
      prepared: {
        plan,
        acquire: async () => {
          steps.push('lease');
          return {
            outcome: held,
            release: async () => {
              steps.push('release');
              return { ...held, released: true };
            },
          };
        },
      },
    };
  }) as never);
}

/** Two accounts, a contact each, into TGT, with `extra` flags. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--object',
    'Account:2',
    '--object',
    'Contact:1',
    '--relation',
    'Contact.AccountId=Account',
    '--per-parent',
    '1',
    '--locale',
    'en_US',
    '--seed',
    '7',
    ...extra,
  ];
}

/** Thrown where the command would exit: a test reads the code. */
class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

/** A step put down by the fakes, as the write path's order names it. */
function asStep(step: string): WritePathStep[] {
  if (step.startsWith('write ')) return ['write'];
  const named: Record<string, WritePathStep> = {
    'automation read': 'reads',
    'limits read': 'reads',
    'lease plan': 'leasePlan',
    'deliverability read': 'deliverabilityRead',
    lease: 'leaseAcquire',
    release: 'leaseRelease',
    result: 'result',
  };
  return named[step] ? [named[step]] : [];
}

describe('sandforge-seed --accept-emails', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    steps.length = 0;
    automationOf = welcoming;
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as never);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
  });

  const writes = (): string[] => steps.filter((step) => step.startsWith('write '));

  it('refuses a seed on All email without it, nothing written: the addresses it writes are its own', async () => {
    fakeOrg();

    await expect(main(argv())).rejects.toThrow(
      'TGT delivers every email its automation sends (Setup > Deliverability: All email), and ' +
        'what still runs as this seed writes its records sends some: flow "Welcome Email" on ' +
        'Contact. They go to the addresses the records and the alerts name: those of the records ' +
        "this seed writes, as they hold them, the records' owners, the records already in TGT, " +
        'and an address an alert names. Nothing was written. Add --accept-emails to seed all the ' +
        "same, set the org's deliverability to System email only, or turn off what sends them. " +
        '--mute-automation keeps quiet flow "Welcome Email" on Contact, which tests a bypass a ' +
        'permission set of TGT holds.',
    );
    expect(writes()).toEqual([]);
    expect(steps.filter((step) => step === 'deliverability read')).toHaveLength(1);
  });

  it('names its code in the line, and answers --json with it: a CI job read an empty stdout', async () => {
    fakeOrg();

    await expect(main(argv('--json'))).rejects.toThrow(
      /^refused \(EMAILS_NOT_ACCEPTED\): TGT delivers every email/,
    );

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      tool: 'sandforge-seed',
      target: 'TGT',
      dryRun: false,
      refused: {
        code: 'EMAILS_NOT_ACCEPTED',
        message: expect.stringContaining('TGT delivers every email') as string,
      },
    });
    expect(writes()).toEqual([]);
  });

  it('writes with it, the read before the first write', async () => {
    fakeOrg();

    await main(argv('--accept-emails', '--json'));
    steps.push('result');

    expect(writes()).toEqual(['write Account', 'write Contact']);
    expect(steps.indexOf('deliverability read')).toBeLessThan(steps.indexOf('write Account'));
    expect(writePathOrderDefects(steps.flatMap(asStep))).toEqual([]);
    expect(JSON.parse(stdout.join('')).emails.deliverability).toEqual({
      reading: { level: 'all' },
      senders: [{ objectApiName: 'Contact', kind: 'flow', name: 'Welcome Email', why: 'email' }],
    });
  });

  it('asks nothing of an org that withholds them, and says why in a line', async () => {
    fakeOrg(CLOSED);

    await main(argv());

    expect(writes()).toEqual(['write Account', 'write Contact']);
    expect(stdout.join('')).toContain(
      '  deliverability: System email only or No access — none of the emails its flows, ' +
        'processes, workflow rules and Apex send goes out',
    );
  });

  it('refuses on any other answer of the org, its words in the refusal', async () => {
    fakeOrg({ compiled: false, success: false, compileProblem: 'Unexpected token' });

    await expect(main(argv())).rejects.toThrow(
      /^refused \(EMAILS_NOT_ACCEPTED\): Whether TGT delivers the emails its automation sends could not be read \(it did not compile: Unexpected token\)/,
    );
    expect(writes()).toEqual([]);
  });

  it('says on a dry run what a real run would be refused for, under wouldBeRefused and emails.refusal', async () => {
    fakeOrg();

    await main(argv('--dry-run', '--json'));

    const summary = JSON.parse(stdout.join('')) as {
      wouldBeRefused: string[];
      emails: { refusal?: string; deliverability?: unknown };
    };
    expect(summary.wouldBeRefused).toEqual([
      expect.stringContaining('Add --accept-emails to seed all the same'),
    ]);
    expect(summary.emails.refusal).toContain('Add --accept-emails to seed all the same');
    expect(writes()).toEqual([]);
  });

  it('runs no Apex in a production org a dry run reads, and asks', async () => {
    fakeOrg(ALL_EMAIL, 15_000, true);

    await main(argv('--dry-run', '--json'));

    expect(steps).not.toContain('deliverability read');
    expect(JSON.parse(stdout.join('')).emails.deliverability.reading).toEqual({
      unread: 'SandForge runs no Apex in a production org',
    });
  });

  it('reads nothing of an org whose automation sends nothing', async () => {
    fakeOrg();
    automationOf = (objects) => ({ ...welcoming(objects), objects: [] });

    await main(argv('--json'));

    expect(steps).not.toContain('deliverability read');
    expect(JSON.parse(stdout.join('')).emails).not.toHaveProperty('deliverability');
  });

  it('counts what the read sent with the seed’s requests, named in the refusal', async () => {
    fakeOrg(CLOSED, 3);

    await expect(main(argv())).rejects.toThrow(
      /2 of them to read whether the target delivers its emails/,
    );
    expect(writes()).toEqual([]);
  });

  it('reads nothing when the mute’s plan keeps every sender quiet, and writes under the lease', async () => {
    fakeOrg();
    muteOf();

    await main(argv('--mute-automation', '--json'));
    steps.push('result');

    expect(steps).not.toContain('deliverability read');
    expect(steps).toEqual([
      'automation read',
      'lease plan',
      'limits read',
      'lease',
      'write Account',
      'write Contact',
      'release',
      'result',
    ]);
    expect(writePathOrderDefects(steps.flatMap(asStep))).toEqual([]);
  });

  it('refuses before its first write a lease that does not hold the set keeping the sender quiet, and gives it back', async () => {
    fakeOrg();
    muteOf([]);

    await expect(main(argv('--mute-automation'))).rejects.toThrow(
      /flow "Welcome Email" on Contact may send emails, and whether TGT delivers them was not read/,
    );

    expect(writes()).toEqual([]);
    expect(steps.slice(-2)).toEqual(['lease', 'release']);
  });

  it('judges a seed that mutes on what still runs, reading the org before the lease', async () => {
    fakeOrg();
    automationOf = welcomingAll;
    muteOf();

    await main(argv('--mute-automation', '--accept-emails', '--json'));
    steps.push('result');

    expect(steps.indexOf('deliverability read')).toBeLessThan(steps.indexOf('lease'));
    expect(writePathOrderDefects(steps.flatMap(asStep))).toEqual([]);
  });

  it('plans its mute from the writes it makes: an insert, never an update of what it creates', async () => {
    fakeOrg();
    automationOf = welcomingAll;
    muteOf();

    await main(argv('--mute-automation', '--accept-emails', '--json'));

    const writes = vi.mocked(muteForRun).mock.calls[0]?.[2]?.writes;
    expect(writes?.('Contact', 'insert')).toBe(true);
    expect(writes?.('Contact', 'update')).toBe(false);
  });

  it('reads the flag apart from --accept-automation, which a seed’s line does not take, and says it in --help', () => {
    expect(parseArgs(argv('--accept-emails'))).toMatchObject({ acceptEmails: true });
    expect(parseArgs(argv())).toMatchObject({ acceptEmails: false });
    expect(() => parseArgs(argv('--accept-automation'))).toThrow(Exited);

    stdout = [];
    expect(() => parseArgs(['node', 'sandforge-seed.ts', '--help'])).toThrow(Exited);
    const help = stdout.join('');
    expect(help).toMatch(/--accept-emails\s+write although the target delivers every email/);
    expect(help).toContain('EMAILS_NOT_ACCEPTED, exit 1');
  });
});
