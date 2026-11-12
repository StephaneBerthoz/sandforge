/**
 * Whether the target delivers the emails of what still runs as a run of
 * `sandforge-sync` writes (`--accept-emails`), through the real orchestrator
 * over a pair of fake orgs whose target answers the read's one line of
 * anonymous Apex as an org on All email or on System email only answers it:
 * read only when something sends, refused without the flag, said in a dry
 * run, and read before the lease, each step counted in the order it was made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type {
  ForgeTargetAutomation,
  ForgeTargetFlow,
  MutedAutomation,
  SyncSimulationResult,
} from '@sandforge/shared';

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
// What the target runs, as the reader the clone's command reads it with
// would answer it: given by each test.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: () => ({ read: readAutomation }),
}));
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { makeConn } from './sfSession.js';
import { main, parseArgs, parseRemoveArgs } from './sandforge-sync.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import {
  answeringDeliverability,
  type DeliverabilityLevel,
} from '../src/test/deliverabilityOrg.js';

/** A flow of the target that emails as an account goes in, kept quiet by `bypass` when given. */
function emailingFlow(label: string, bypass?: string): ForgeTargetFlow {
  return {
    apiName: label.replace(/ /g, '_'),
    label,
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: bypass ? [{ name: bypass, bypass: true, held: false }] : [],
    messages: [{ kind: 'email', name: `Send ${label}`, limit: 'SingleEmail' }],
  };
}

/** What the target runs on the accounts: `flows`. */
function automationOf(flows: ForgeTargetFlow[]): ForgeTargetAutomation {
  return {
    objectsRead: ['Account'],
    objects: [{ objectApiName: 'Account', flows, triggers: [] }],
    bypassGrants: [
      {
        permission: 'Account_Bypass',
        permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };
}

/** An account flow that emails its owner, which nothing keeps quiet. */
const OWNER_EMAIL = automationOf([emailingFlow('Account owner email')]);

/** The command line, after the script's own two words. */
const argv = (...rest: string[]): string[] => [
  'node',
  'sandforge-sync.ts',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--object',
  'Account',
  ...rest,
];

const ACCOUNTS = [
  { Id: '001000000000001AAA', Name: 'One' },
  { Id: '001000000000002AAA', Name: 'Two' },
];

const field = (name: string, type: string, over: Record<string, unknown> = {}) => ({
  name,
  type,
  createable: true,
  updateable: true,
  queryable: true,
  nillable: true,
  defaultedOnCreate: false,
  length: 80,
  referenceTo: [],
  picklistValues: [],
  ...over,
});

const DESCRIBED = {
  name: 'Account',
  createable: true,
  updateable: true,
  recordTypeInfos: [],
  fields: [field('Id', 'id', { createable: false, updateable: false }), field('Name', 'string')],
};

/**
 * A source of two accounts and a sandbox target that delivers the emails of
 * its automation at `level`, with room to spare and `singleEmails` single
 * emails left today; each write to the target in `events`, and each read of
 * its deliverability as `deliverability read`; a production org when
 * `production` says.
 */
function orgs(
  events: string[],
  level: DeliverabilityLevel,
  production = false,
  described: { fields: unknown[] } = DESCRIBED,
  singleEmails = 5_000,
): void {
  const page = (records: unknown[]) => ({ records, totalSize: records.length, done: true });
  const asked: string[] = [];
  const conn = (side: 'source' | 'target') => ({
    version: '66.0',
    query: async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: !production }]);
      }
      if (/COUNT\(\)/.test(soql)) {
        return { records: [], totalSize: side === 'source' ? ACCOUNTS.length : 0, done: true };
      }
      if (soql.includes('FROM Account')) return page(side === 'source' ? ACCOUNTS : []);
      return page([]);
    },
    queryMore: async () => page([]),
    sobject: () => ({
      describe: async () => described,
      create: async (records: unknown[]) => {
        events.push('write');
        return records.map((_, i) => ({
          id: `001${String(i + 10).padStart(12, '0')}AAA`,
          success: true,
          errors: [],
        }));
      },
    }),
    describe: async () => described,
    tooling: { query: async () => page([]), queryMore: async () => page([]) },
    request: async (request: string | { url: string }) => {
      const before = asked.length;
      const answer = await answeringDeliverability(
        level,
        async () => ({
          DataStorageMB: { Max: 200, Remaining: 150 },
          DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
          SingleEmail: { Max: 5_000, Remaining: singleEmails },
        }),
        asked,
      ).request(request);
      if (asked.length > before && asked[asked.length - 1] === 'apex') {
        events.push('deliverability read');
      }
      return answer;
    },
  });
  const source = conn('source');
  const target = conn('target');
  vi.mocked(makeConn).mockImplementation(
    (session) => (session.alias === 'SRC' ? source : target) as unknown as Connection,
  );
}

/**
 * A mute whose lease holds `PS_Bypass`, each acquire and release in
 * `events`: what it leaves running is `view`.
 */
function muteOf(events: string[], view: ForgeTargetAutomation): void {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Account_Bypass'],
    silenced: [],
    stillRan: [],
  };
  vi.mocked(muteForRun).mockImplementation((async () => {
    events.push('lease plan');
    return {
      automation: view,
      muted,
      plan: {
        assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Account_Bypass'] }],
        silenced: [],
        stillRuns: [],
      },
      prepared: {
        acquire: async () => {
          events.push('lease');
          let released = false;
          return {
            outcome: muted,
            release: async () => {
              if (!released) events.push('release');
              released = true;
              return { ...muted, released: true };
            },
          };
        },
      },
    };
  }) as never);
}

/** Thrown where the command would exit: a test reads the code. */
class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

describe('sandforge-sync --accept-emails', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as never);
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(OWNER_EMAIL);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
  });

  /** The exit code `main` ends on, once it has. */
  const exitOf = async (line: string[]): Promise<number | undefined> => {
    try {
      await main(line);
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    } catch (thrown: unknown) {
      if (thrown instanceof Exited) return thrown.code;
      throw thrown;
    }
  };

  it('is read from the line, off unless given, and says in --help what it lets through', () => {
    expect(parseArgs(argv()).acceptEmails).toBe(false);
    expect(parseArgs(argv('--accept-emails')).acceptEmails).toBe(true);

    expect(() => parseArgs(['node', 'sandforge-sync.ts', '--help'])).toThrow(Exited);
    const help = out.join('');
    expect(help).toContain('--accept-emails        write although the target delivers the emails');
    expect(help).toContain('exit 1 (EMAILS_NOT_ACCEPTED)');
  });

  it('is no flag of a removal, which counts no email', () => {
    expect(() =>
      parseRemoveArgs([
        'node',
        'sandforge-sync.ts',
        '--remove',
        'run.json',
        '--target',
        'TGT',
        '--accept-emails',
      ]),
    ).toThrow(Exited);
  });

  it('refuses a run on All email without it, exit 1, nothing written, the senders named', async () => {
    const events: string[] = [];
    orgs(events, 'all');

    expect(await exitOf(argv())).toBe(1);

    expect(events).toEqual(['deliverability read']);
    const said = out.join('');
    expect(said).toContain(
      '  deliverability: All email — the emails of what still runs go out (read with one line ' +
        'of anonymous Apex that sends nothing)',
    );
    expect(said).toContain('refused (EMAILS_NOT_ACCEPTED): TGT delivers every email');
    expect(said).toContain('flow "Account owner email" on Account');
    expect(said).toContain('Add --accept-emails to sync all the same');
  });

  it('says the emails reach the addresses the records keep, under --keep-contact-points', async () => {
    orgs([], 'all');

    expect(await exitOf(argv('--keep-contact-points'))).toBe(1);

    expect(out.join('')).toContain('those of the records this sync writes, as they hold them');
  });

  it('writes with it', async () => {
    const events: string[] = [];
    orgs(events, 'all');

    expect(await exitOf(argv('--accept-emails'))).toBe(0);

    expect(events).toEqual(['deliverability read', 'write']);
  });

  it('writes without it on an org that withholds them, and says so', async () => {
    const events: string[] = [];
    orgs(events, 'withheld');

    expect(await exitOf(argv())).toBe(0);

    expect(events).toEqual(['deliverability read', 'write']);
    expect(out.join('')).toContain(
      '  deliverability: System email only or No access — none of the emails its flows, ' +
        'processes, workflow rules and Apex send goes out',
    );
  });

  it('reads nothing of it when nothing that runs sends an email', async () => {
    const events: string[] = [];
    orgs(events, 'all');
    readAutomation.mockResolvedValue(automationOf([]));

    expect(await exitOf(argv())).toBe(0);

    expect(events).toEqual(['write']);
    expect(out.join('')).not.toContain('deliverability:');
  });

  it('says with --dry-run that a real run would be refused, and gives the reading under --json', async () => {
    const events: string[] = [];
    orgs(events, 'all');

    expect(await exitOf(argv('--dry-run', '--json'))).toBe(0);

    const printed = JSON.parse(out.join('')) as {
      simulation: SyncSimulationResult;
      wouldBeRefused?: string[];
      wouldBeRefusedCodes?: string[];
    };
    expect(printed.simulation.writeCheck?.deliverability).toEqual({
      reading: { level: 'all' },
      senders: [
        { objectApiName: 'Account', kind: 'flow', name: 'Account owner email', why: 'email' },
      ],
    });
    expect(printed.wouldBeRefused).toEqual([
      expect.stringContaining('Add --accept-emails to sync all the same'),
    ]);
    // The code a real run is refused with, beside it.
    expect(printed.wouldBeRefusedCodes).toEqual(['EMAILS_NOT_ACCEPTED']);
    expect(events).toEqual(['deliverability read']);

    // Given the flag, a dry run says no refusal of it.
    out.length = 0;
    expect(await exitOf(argv('--dry-run', '--json', '--accept-emails'))).toBe(0);
    expect(JSON.parse(out.join('')).wouldBeRefused).toBeUndefined();
  });

  it('gives with --dry-run --json, under wouldBeRefused, the refusal past the emails left today that a real run meets', async () => {
    // The emails accepted, nothing asks: the two accounts' emails are past the one left.
    const events: string[] = [];
    orgs(events, 'all', false, DESCRIBED, 1);
    expect(await exitOf(argv('--dry-run', '--json', '--accept-emails'))).toBe(0);
    const dry = JSON.parse(out.join('')) as {
      wouldBeRefused?: string[];
      wouldBeRefusedCodes?: string[];
    };

    out.length = 0;
    orgs(events, 'all', false, DESCRIBED, 1);
    expect(await exitOf(argv('--json', '--accept-emails'))).toBe(1);
    const real = JSON.parse(out.join('')) as { refused: { code: string; message: string } };

    expect(real.refused.code).toBe('SYNC_EMAILS_EXCEEDED');
    expect(dry.wouldBeRefused).toEqual([real.refused.message]);
    expect(dry.wouldBeRefusedCodes).toEqual([real.refused.code]);
    expect(events).not.toContain('write');
  });

  it('names every reason its gate refuses a real run for, the first under refused, the others under alsoRefused, as its dry run says them', async () => {
    // Past the emails left today and on All email without --accept-emails: a
    // real run said the first code alone, and a CI job that raised the limit
    // was refused again for the second.
    const events: string[] = [];
    orgs(events, 'all', false, DESCRIBED, 1);
    expect(await exitOf(argv('--dry-run', '--json'))).toBe(0);
    const dry = JSON.parse(out.join('')) as { wouldBeRefusedCodes?: string[] };

    out.length = 0;
    err.length = 0;
    orgs(events, 'all', false, DESCRIBED, 1);
    expect(await exitOf(argv('--json'))).toBe(1);
    const real = JSON.parse(out.join('')) as {
      refused: { code: string };
      alsoRefused?: Array<{ code: string; message: string }>;
    };
    // Said on stderr too with --json, as a refused Seed run says them: a CI
    // log that keeps stderr alone showed no reason.
    expect(err.join('')).toMatch(
      /refused \(SYNC_EMAILS_EXCEEDED\): [^\n]*\nrefused \(EMAILS_NOT_ACCEPTED\): TGT delivers every email/,
    );
    // Refused before its first write, it names no run file: none was begun,
    // and the --remove it offered could not read it.
    expect(err.join('')).not.toContain('run file:');

    expect(real.refused.code).toBe('SYNC_EMAILS_EXCEEDED');
    expect(real.alsoRefused).toEqual([
      {
        code: 'EMAILS_NOT_ACCEPTED',
        message: expect.stringContaining('TGT delivers every email') as string,
      },
    ]);
    expect(dry.wouldBeRefusedCodes).toEqual([
      real.refused.code,
      ...(real.alsoRefused ?? []).map(({ code }) => code),
    ]);

    // Each on its line.
    out.length = 0;
    orgs(events, 'all', false, DESCRIBED, 1);
    expect(await exitOf(argv())).toBe(1);
    expect(out.join('')).toMatch(
      /refused \(SYNC_EMAILS_EXCEEDED\): [^\n]*\nrefused \(EMAILS_NOT_ACCEPTED\): TGT delivers every email/,
    );
    expect(out.join('')).not.toContain('run file:');
    expect(events).not.toContain('write');
  });

  it('says an upsert on a field the target matches none on before it writes: counted refused, under wouldBeRefused, and refused in a run', async () => {
    const onName = [
      'node',
      'sandforge-sync.ts',
      '--source',
      'SRC',
      '--target',
      'TGT',
      '--object',
      'Account:Name',
    ];
    const events: string[] = [];
    // As the org's describe says them: Account.Name is no key of an upsert.
    orgs(events, 'withheld', false, {
      ...DESCRIBED,
      fields: [
        field('Id', 'id', { createable: false, updateable: false, idLookup: true }),
        field('Name', 'string', { idLookup: false, externalId: false }),
      ],
    });

    expect(await exitOf([...onName, '--dry-run', '--json'])).toBe(0);

    const printed = JSON.parse(out.join('')) as {
      simulation: SyncSimulationResult;
      wouldBeRefused?: string[];
      wouldBeRefusedCodes?: string[];
    };
    expect(printed.simulation.objects[0]).toMatchObject({ insert: 0, refused: ACCOUNTS.length });
    expect(printed.simulation.writeCheck?.unwritable).toEqual([
      expect.objectContaining({ objectApiName: 'Account', why: 'notAKey', key: 'Name' }),
    ]);
    expect(printed.wouldBeRefused).toEqual([
      expect.stringContaining('its upsert matches on Name, neither an External ID nor an idLookup'),
    ]);
    expect(printed.wouldBeRefusedCodes).toEqual(['SYNC_TARGET_UNWRITABLE']);

    expect(await exitOf(onName)).toBe(1);
    expect(events).toEqual([]);
  });

  it('runs no Apex in a production org a dry run reads, and takes it for one that would not say', async () => {
    const events: string[] = [];
    orgs(events, 'all', true);

    expect(await exitOf(argv('--dry-run', '--json'))).toBe(0);

    expect(events).toEqual([]);
    const printed = JSON.parse(out.join('')) as { simulation: SyncSimulationResult };
    expect(printed.simulation.writeCheck?.deliverability?.reading).toEqual({
      unread: 'SandForge runs no Apex in a production org',
    });
  });

  it('reads it once the lease is planned, before the lease, which it then takes before the first write', async () => {
    const events: string[] = [];
    orgs(events, 'all');
    // The mute keeps a welcome email quiet; the owner's email still runs.
    readAutomation.mockResolvedValue(
      automationOf([
        emailingFlow('Welcome', 'Account_Bypass'),
        emailingFlow('Account owner email'),
      ]),
    );
    muteOf(events, OWNER_EMAIL);

    expect(await exitOf(argv('--mute-automation', '--accept-emails', '--json'))).toBe(0);

    expect(events).toEqual(['lease plan', 'deliverability read', 'lease', 'write', 'release']);
    const steps: Record<string, WritePathStep> = {
      'lease plan': 'leasePlan',
      'deliverability read': 'deliverabilityRead',
      lease: 'leaseAcquire',
      write: 'write',
      release: 'leaseRelease',
    };
    expect(
      writePathOrderDefects([
        'reads',
        ...events.map((event) => steps[event] as WritePathStep),
        'result',
      ]),
    ).toEqual([]);
    // The welcome email the mute keeps quiet is no sender.
    expect(err.join('')).not.toContain('"Welcome"');
  });

  it('does not name --mute-automation to a run that mutes', async () => {
    const events: string[] = [];
    orgs(events, 'all');
    // The bypass of a flow the mute was asked to quiet and did not: the run
    // was given the flag already, and is not told to add it.
    const bothLeft = automationOf([
      emailingFlow('Welcome', 'Account_Bypass'),
      emailingFlow('Account owner email'),
    ]);
    readAutomation.mockResolvedValue(bothLeft);
    muteOf(events, bothLeft);

    expect(await exitOf(argv('--mute-automation'))).toBe(1);

    // Refused at its gate: the lease was never taken, nothing assigned.
    expect(events).toEqual(['lease plan', 'deliverability read']);
    const said = out.join('');
    expect(said).toContain('refused (EMAILS_NOT_ACCEPTED)');
    expect(said).not.toContain('--mute-automation keeps quiet');
  });

  it('names --mute-automation, to a run that does not mute, for what it would keep quiet', async () => {
    const events: string[] = [];
    orgs(events, 'all');
    readAutomation.mockResolvedValue(
      automationOf([
        emailingFlow('Welcome', 'Account_Bypass'),
        emailingFlow('Account owner email'),
      ]),
    );

    expect(await exitOf(argv())).toBe(1);

    expect(out.join('')).toContain(
      '--mute-automation keeps quiet flow "Welcome" on Account, which tests a bypass a ' +
        'permission set of TGT holds; it cannot quiet flow "Account owner email" on Account.',
    );
  });
});
