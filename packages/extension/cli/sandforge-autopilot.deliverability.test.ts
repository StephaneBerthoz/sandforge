import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});
// What the target runs, as the reader Forge's clone command reads it with
// would answer it: given by each test.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: () => ({ read: readAutomation }),
}));
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import type { ForgeTargetAutomation, ForgeTargetFlow, MutedAutomation } from '@sandforge/shared';
import { mutedAutomationOf } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { main, parseArgs } from './sandforge-autopilot';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { countingConnection, largeOrg } from '../src/test/largeOrg';
import {
  answeringDeliverability,
  type DeliverabilityLevel,
} from '../src/test/deliverabilityOrg.js';

/*
 * Whether the target delivers the emails of what still runs as a run of
 * `sandforge-autopilot` writes its plan (`--accept-emails`), against a large
 * fake org whose target answers the read's one line of anonymous Apex as an
 * org on All email or on System email only answers it: read only when
 * something sends, refused without the flag, said with --plan-only, read
 * before the lease and checked again once the lease is read back.
 */

/** A lead flow that emails the lead it creates, kept quiet by `bypass` when given. */
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

/** What the target runs on the leads: `flows`, the bypass `Bypass_Flow` held by `PS_Bypass`. */
function automationOf(flows: ForgeTargetFlow[]): ForgeTargetAutomation {
  return {
    objectsRead: ['Lead'],
    objects: [{ objectApiName: 'Lead', flows, triggers: [] }],
    bypassGrants: [
      {
        permission: 'Bypass_Flow',
        permissionSets: [{ name: 'PS_Bypass', label: 'Bypass', grants: 1 }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };
}

/** A lead's owner email, which nothing keeps quiet. */
const OWNER_EMAIL = automationOf([emailingFlow('Lead owner email')]);
/** A welcome email the bypass keeps quiet. */
const WELCOME = automationOf([emailingFlow('Lead welcome', 'Bypass_Flow')]);

/** The command line, after the script's own two words. */
const argv = (...rest: string[]) => [
  'node',
  'sandforge-autopilot.ts',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--object',
  'Lead',
  ...rest,
];

/**
 * A source and a target over the same large org, a sandbox with room to
 * spare that delivers the emails of its automation at `level`; each write to
 * the target in `events`, and each read of its deliverability as
 * `deliverability read`; a production org when `production` says.
 */
function orgs(events: string[], level: DeliverabilityLevel, production = false) {
  const org = largeOrg();
  const source = countingConnection(org);
  const target = countingConnection(org);
  const asked: string[] = [];
  const answering = answeringDeliverability(
    level,
    async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
      SingleEmail: { Max: 5_000, Remaining: 5_000 },
    }),
    asked,
  );
  const conn = {
    ...target.conn,
    query: async (soql: string) =>
      soql.includes('FROM Organization')
        ? {
            records: [{ Id: '00D000000000001AAA', IsSandbox: !production }],
            totalSize: 1,
            done: true,
          }
        : target.conn.query(soql),
    request: vi.fn(async (request: string | { url: string }) => {
      const before = asked.length;
      const said = await answering.request(request);
      if (asked.length > before && asked[asked.length - 1] === 'apex') {
        events.push('deliverability read');
      }
      return said;
    }),
    sobject: (name: string) => ({
      ...target.conn.sobject(name),
      create: vi.fn(async (records: unknown[]) => {
        events.push(`write ${name}`);
        return records.map((_, i) => ({ id: `new-${i}`, success: true, errors: [] }));
      }),
    }),
  };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: `${alias}@example.invalid`,
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
  }));
  vi.mocked(makeConn).mockImplementation(
    (session) => (session.alias === 'SRC' ? source.conn : conn) as never,
  );
  return { asked };
}

/**
 * A mute of `read` whose lease is to hold `PS_Bypass`, each plan, acquire and
 * release in `events`; read back holding none of it when `holds` is false.
 */
function muteOf(events: string[], read: ForgeTargetAutomation, holds = true) {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Bypass_Flow'],
    silenced: [],
    stillRan: [],
  };
  vi.mocked(muteForRun).mockImplementation((async () => {
    events.push('lease plan');
    return {
      automation: mutedAutomationOf(read, ['Bypass_Flow']),
      muted,
      plan: {
        assign: [{ permissionSet: 'PS_Bypass', label: 'Bypass', permissions: ['Bypass_Flow'] }],
        silenced: [],
        stillRuns: [],
      },
      prepared: {
        acquire: async () => {
          events.push('lease');
          let released = false;
          return {
            outcome: holds ? muted : { ...muted, assigned: [] },
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

describe('sandforge-autopilot --accept-emails', () => {
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

  /** What a step of the run is, in the order of the write path. */
  const STEPS: Record<string, WritePathStep> = {
    'lease plan': 'leasePlan',
    'deliverability read': 'deliverabilityRead',
    lease: 'leaseAcquire',
    release: 'leaseRelease',
  };
  const stepsOf = (events: readonly string[]): WritePathStep[] =>
    events.map((event) => STEPS[event] ?? (event.startsWith('write') ? 'write' : 'result'));

  it('is read from the line, off unless given, and says in --help what it lets through', () => {
    expect(parseArgs(argv()).acceptEmails).toBe(false);
    expect(parseArgs(argv('--accept-emails')).acceptEmails).toBe(true);

    expect(() => parseArgs(['node', 'sandforge-autopilot.ts', '--help'])).toThrow(Exited);
    const help = out.join('');
    expect(help).toContain('--accept-emails        write although the target delivers the emails');
    expect(help).toContain('exit 1 (EMAILS_NOT_ACCEPTED)');
  });

  it('refuses a run on All email without it, nothing written, the senders named', async () => {
    const events: string[] = [];
    orgs(events, 'all');

    const refused = main(argv());

    await expect(refused).rejects.toThrow('TGT delivers every email its automation sends');
    await expect(refused).rejects.toThrow('flow "Lead owner email" on Lead');
    await expect(refused).rejects.toThrow('Add --accept-emails to run it all the same');
    // Said once, at the end, as every refusal of the gate closes.
    const message = await refused.then(
      () => '',
      (thrown: Error) => thrown.message,
    );
    expect(message.match(/Nothing was written\./g)).toHaveLength(1);
    expect(message.endsWith('Nothing was written.')).toBe(true);
    expect(events).toEqual(['deliverability read']);
    expect(out.join('')).toContain(
      '  deliverability: All email — the emails of what still runs go out (read with one line ' +
        'of anonymous Apex that sends nothing)',
    );
  });

  it('names its code in the line, and answers --json with it', async () => {
    orgs([], 'all');

    await expect(main(argv('--json'))).rejects.toThrow(
      /^refused \(EMAILS_NOT_ACCEPTED\): .*TGT delivers every email/,
    );

    const said = out.join('');
    expect(JSON.parse(said.slice(said.lastIndexOf('\n{\n') + 1))).toMatchObject({
      tool: 'sandforge-autopilot',
      target: 'TGT',
      dryRun: false,
      refused: { code: 'EMAILS_NOT_ACCEPTED' },
    });
  });

  it('says the emails reach the addresses the records keep, under --keep-contact-points', async () => {
    orgs([], 'all');

    await expect(main(argv('--keep-contact-points'))).rejects.toThrow(
      'those of the records this Autopilot run writes, as they hold them',
    );
  });

  it('writes with it', async () => {
    const events: string[] = [];
    orgs(events, 'all');

    await main(argv('--accept-emails'));

    expect(events[0]).toBe('deliverability read');
    expect(events.some((event) => event.startsWith('write'))).toBe(true);
  });

  it('writes without it on an org that withholds them, and says so', async () => {
    const events: string[] = [];
    const { asked } = orgs(events, 'withheld');

    await main(argv());

    expect(asked).toEqual(['apex', 'sendEmail']);
    expect(events.some((event) => event.startsWith('write'))).toBe(true);
    expect(out.join('')).toContain(
      '  deliverability: System email only or No access — none of the emails its flows',
    );
  });

  it('reads nothing of it when nothing that runs sends an email', async () => {
    const events: string[] = [];
    const { asked } = orgs(events, 'all');
    readAutomation.mockResolvedValue(automationOf([]));

    await main(argv());

    expect(asked).toEqual([]);
    expect(out.join('')).not.toContain('deliverability:');
  });

  it('says with --plan-only that a real run would be refused, gives the reading under --json, and counts the reads back', async () => {
    const events: string[] = [];
    orgs(events, 'all');

    await main(argv('--plan-only', '--json'));

    const printed = JSON.parse(out.join('')) as {
      writeGate: {
        deliverability?: unknown;
        refusals: string[];
        apiRequests: { parts?: Record<string, number> };
      };
    };
    expect(printed.writeGate.deliverability).toEqual({
      reading: { level: 'all' },
      senders: [{ objectApiName: 'Lead', kind: 'flow', name: 'Lead owner email', why: 'email' }],
    });
    expect(printed.writeGate.refusals).toEqual([
      expect.stringContaining('Add --accept-emails to run it all the same'),
    ]);
    // A read back of the leads' record types, and the read of the deliverability.
    expect(printed.writeGate.apiRequests.parts).toMatchObject({ readBack: 1, deliverability: 1 });
  });

  it('runs no Apex in a production org --plan-only reads, and takes it for one that would not say', async () => {
    const events: string[] = [];
    const { asked } = orgs(events, 'all', true);

    await main(argv('--plan-only', '--json'));

    expect(asked).toEqual([]);
    const printed = JSON.parse(out.join('')) as {
      writeGate: { deliverability?: { reading: unknown } };
    };
    expect(printed.writeGate.deliverability?.reading).toEqual({
      unread: 'SandForge runs no Apex in a production org',
    });
  });

  it('reads it once the lease is planned and before the lease, which it then takes before the first write', async () => {
    const events: string[] = [];
    orgs(events, 'all');
    readAutomation.mockResolvedValue(
      automationOf([emailingFlow('Lead welcome', 'Bypass_Flow'), emailingFlow('Lead owner email')]),
    );
    muteOf(events, await readAutomation());

    await main(argv('--mute-automation', '--accept-emails', '--json'));

    const writes = events.filter((event) => event.startsWith('write'));
    expect(writes.length).toBeGreaterThan(0);
    expect(events).toEqual(['lease plan', 'deliverability read', 'lease', ...writes, 'release']);
    expect(writePathOrderDefects(['reads', ...stepsOf(events), 'result'])).toEqual([]);
  });

  it('reads nothing when the mute keeps quiet the one flow that sends', async () => {
    const events: string[] = [];
    const { asked } = orgs(events, 'all');
    readAutomation.mockResolvedValue(WELCOME);
    muteOf(events, WELCOME);

    await main(argv('--mute-automation'));

    expect(asked).toEqual([]);
    expect(events.some((event) => event.startsWith('write'))).toBe(true);
  });

  it('refuses the run before its first write when the lease read back does not hold what it was to keep quiet', async () => {
    const events: string[] = [];
    orgs(events, 'all');
    readAutomation.mockResolvedValue(WELCOME);
    muteOf(events, WELCOME, false);

    await expect(main(argv('--mute-automation'))).rejects.toThrow(
      /^refused \(EMAILS_NOT_ACCEPTED\): .*flow "Lead welcome" on Lead may send emails, and whether TGT delivers them was not read/,
    );

    expect(events).toEqual(['lease plan', 'lease', 'release']);
    expect(writePathOrderDefects(['reads', ...stepsOf(events), 'result'])).toEqual([]);
  });

  it('answers --json with the code of a run refused once the lease is read back', async () => {
    // Refused past the gate, a run left stdout empty for a CI job that reads
    // `.refused.code`.
    orgs([], 'all');
    readAutomation.mockResolvedValue(WELCOME);
    muteOf([], WELCOME, false);

    await expect(main(argv('--mute-automation', '--json'))).rejects.toThrow(
      /^refused \(EMAILS_NOT_ACCEPTED\): /,
    );

    const said = out.join('');
    const summary = JSON.parse(said.slice(said.lastIndexOf('\n{\n') + 1)) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      tool: 'sandforge-autopilot',
      target: 'TGT',
      dryRun: false,
      refused: { code: 'EMAILS_NOT_ACCEPTED' },
    });
    // The refusal as the help says it, its code and its message alone.
    expect(Object.keys(summary.refused as object)).toEqual(['code', 'message']);
  });
});
