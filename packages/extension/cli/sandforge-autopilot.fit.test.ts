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
vi.mock('./beforeRunCheckpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beforeRunCheckpoint.js')>();
  return { ...actual, commandCheckpoints: vi.fn(actual.commandCheckpoints) };
});
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import type {
  AutopilotFitReport,
  AutopilotPlanScope,
  ForgeTargetAutomation,
  MutedAutomation,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import {
  autopilotFitJson,
  autopilotFitLines,
  main,
  outcomeLines,
  parseArgs,
  scopeLines,
} from './sandforge-autopilot';
import { commandCheckpoints, type CommandCheckpoints } from './beforeRunCheckpoint.js';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import type { AutopilotPlanFit } from '../src/modules/autopilot/AutopilotOrchestrator.js';
import {
  countingConnection,
  describeOf,
  type LargeOrg,
  type LargeOrgRow,
} from '../src/test/largeOrg';
import { fitConnection, fitOrg } from '../src/test/fitOrg';

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const account = (n: number): string => id('001', n);
const contact = (n: number): string => id('003', n);

/** Four accounts, a hierarchy of three among them, and a contact of each of two. */
function rows(): Record<string, LargeOrgRow[]> {
  return {
    Account: [
      { Id: account(1), Name: 'One', ParentId: null },
      { Id: account(2), Name: 'Two', ParentId: account(1), Primary_Contact__c: contact(1) },
      { Id: account(3), Name: 'Three', ParentId: account(1) },
      { Id: account(4), Name: 'Four' },
    ],
    Contact: [
      { Id: contact(1), Name: 'Of One', AccountId: account(1) },
      { Id: contact(2), Name: 'Of Two', AccountId: account(2) },
    ],
  };
}

/** What the target runs on the objects a plan writes. */
function automationOf(objects: ForgeTargetAutomation['objects']): ForgeTargetAutomation {
  return {
    objectsRead: objects.map((o) => o.objectApiName),
    objects,
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };
}

/** The command line, after the script's own two words. */
const argv = (...rest: string[]) => [
  'node',
  'sandforge-autopilot.ts',
  '--source',
  'SRC',
  '--target',
  'TGT',
  '--object',
  'Account',
  '--object',
  'Contact',
  ...rest,
];

/** What the target's `/limits` say, the Nth asking the Nth, the last for any after it. */
type Limits = Array<{ maxMB: number; remainingMB: number }>;

/**
 * A source holding `source`, a sandbox for a target; each read of the source
 * and each write of the target in `events`.
 */
function orgs(
  events: string[],
  limits: Limits = [{ maxMB: 200, remainingMB: 150 }],
  source: Record<string, LargeOrgRow[]> = rows(),
  onLimits?: (asked: number, org: LargeOrg) => void,
) {
  const org = fitOrg(source);
  const reading = fitConnection(org);
  const sourceConn = {
    ...reading.conn,
    query: async (soql: string) => {
      events.push(`read ${soql}`);
      return reading.conn.query(soql);
    },
  };
  const target = countingConnection(fitOrg({}));
  const created: Array<{ object: string; record: Record<string, unknown> }> = [];
  let asked = 0;
  const conn = {
    ...target.conn,
    query: async (soql: string) =>
      soql.includes('FROM Organization')
        ? { records: [{ Id: '00D000000000001AAA', IsSandbox: true }], totalSize: 1, done: true }
        : target.conn.query(soql),
    request: vi.fn(async (): Promise<Record<string, unknown>> => {
      const { maxMB, remainingMB } = limits[Math.min(asked, limits.length - 1)];
      asked++;
      onLimits?.(asked, org);
      events.push('limits');
      return {
        DataStorageMB: { Max: maxMB, Remaining: remainingMB },
        DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
      };
    }),
    sobject: (name: string) => ({
      describe: async () => describeOf(org, name),
      create: vi.fn(async (records: Array<Record<string, unknown>>) => {
        events.push(`write ${name}`);
        return records.map((record) => {
          created.push({ object: name, record });
          return { id: id('0AA', created.length), success: true, errors: [] };
        });
      }),
      update: vi.fn(async (records: Array<Record<string, unknown>>) => {
        events.push(`update ${name}`);
        return records.map(() => ({ id: 'x', success: true, errors: [] }));
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
    (session) => (session.alias === 'SRC' ? sourceConn : conn) as never,
  );
  return { created, reading };
}

/** A fit the summary's JSON carries. */
type FitJson = AutopilotFitReport & {
  applied: boolean;
  heldBy: string;
  cannotFit?: string;
  keptIds?: Record<string, string[]>;
};

describe('sandforge-autopilot --fit', () => {
  let out: string[];
  let err: string[];
  /** Everything the run said, as it said it on stdout. */
  const said = (): string => out.join('');

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
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(automationOf([]));
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
  });

  describe('its flags', () => {
    /** What a bad line says as it exits 2. */
    const refused = (...flags: string[]): string => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      expect(() => parseArgs(argv(...flags))).toThrow('exit 2');
      return err.join('');
    };

    it('asks no fit unless told', () => {
      expect(parseArgs(argv())).not.toHaveProperty('fit');
    });

    it('reads a share, caps by object and for the rest, and the most MB', () => {
      expect(
        parseArgs(
          argv(
            '--fit',
            'share',
            '--fit-cap',
            'Contact=10',
            '--fit-cap',
            '100',
            '--fit-within',
            '2.5',
          ),
        ).fit,
      ).toEqual({ share: true, caps: { all: 100, objects: { Contact: 10 } }, withinMB: 2.5 });
    });

    it('refuses a fit that is not a share, a malformed cap, and a bound with nothing to bound', () => {
      expect(refused('--fit', 'half')).toContain('--fit takes share');
    });

    it('refuses a malformed cap', () => {
      expect(refused('--fit-cap', 'Contact=none')).toContain('--fit-cap wants');
    });

    it('refuses --fit-within alone', () => {
      expect(refused('--fit-within', '3')).toContain('--fit-within goes with');
    });

    it('refuses a cap on an object the run does not select: a parent follows what names it', () => {
      expect(refused('--fit-cap', 'Region__c=3')).toContain(
        '--fit-cap Region__c: give Region__c with --object too.',
      );
    });
  });

  describe('with --plan-only', () => {
    it('says what it keeps object by object, the lookups it empties and what the plan comes to', async () => {
      orgs([]);

      await main(argv('--plan-only', '--fit', 'share', '--fit-within', '0.006'));

      const printed = said();
      expect(printed).toContain('fit: share 50 %, the largest that fits the 0.006 MB asked');
      expect(printed).toContain('  Account  2 of 4  cut 2: 2 spread over the table');
      expect(printed).toContain('  Contact  1 of 2  cut 1: 1 with their Account (AccountId)');
      expect(printed).toContain(
        'left empty: Account.ParentId on 1 (the record of its own object it names was cut), ' +
          'Account.Primary_Contact__c on 1 (the record it names, written after, was cut)',
      );
      expect(printed).toContain('fitted plan: 3 record(s), about');
      expect(printed).toContain('2 requests read to fit it');
      expect(printed).toContain("fitted to the target's storage, read by id:");
      expect(printed).toContain('Account 2 of 4, Contact 1 of 2');
      expect(printed).not.toContain('a real run would be refused');
    });

    it('names the ids kept in --json, on the plan a real run would run, writing nothing', async () => {
      const { created } = orgs([]);

      await main(argv('--plan-only', '--json', '--fit', 'share', '--fit-within', '0.006'));

      const summary = JSON.parse(said()) as {
        fit: FitJson;
        plan: { totalRecords: number; scope: AutopilotPlanScope };
        writeGate: { records: number };
      };
      expect(summary.fit).toMatchObject({
        applied: true,
        heldBy: 'within',
        share: 0.5,
        keptIds: { Account: [account(2), account(4)], Contact: [contact(2)] },
      });
      expect(summary.plan.totalRecords).toBe(3);
      expect(summary.plan.scope.fitted?.records).toBe(3);
      expect(summary.writeGate.records).toBe(3);
      expect(created).toEqual([]);
    });

    it('lifts the refusal of a plan past the storage of a Developer Edition', async () => {
      // 3 000 accounts at 2 KB, 5.9 MB, for the 5 a new Developer Edition has.
      const many = {
        Account: Array.from({ length: 3_000 }, (_, i) => ({ Id: account(i + 1) })),
      };
      const limits = [{ maxMB: 5, remainingMB: 5 }];
      orgs([], limits, many);

      await main(argv('--plan-only'));
      expect(said()).toContain('a real run would be refused');
      expect(said()).toContain('--fit share keeps the largest share of the plan that fits');

      out.length = 0;
      orgs([], limits, many);
      await main(argv('--plan-only', '--fit', 'share'));
      expect(said()).not.toContain('a real run would be refused');
      // 80 % of 4.5 MB, 3.6 MB: 1 843 records of 2 KB.
      expect(said()).toContain('  Account  1843 of 3000');
    });

    it('lifts the refusal of a plan past --max-total, and says that is what held it', async () => {
      orgs([]);

      await main(argv('--plan-only', '--max-total', '4'));
      expect(said()).toContain('more than --max-total 4');

      out.length = 0;
      orgs([]);
      await main(argv('--plan-only', '--max-total', '4', '--fit', 'share'));
      expect(said()).toContain('the largest --max-total lets through');
      expect(said()).not.toContain('a real run would be refused');
    });

    it('thins what follows a kept parent under a cap, a cap alone being no share', async () => {
      orgs([]);

      await main(argv('--plan-only', '--json', '--fit-cap', 'Contact=1'));

      const { fit } = JSON.parse(said()) as { fit: FitJson };
      expect(fit.keptIds).toEqual({
        Account: rows()['Account'].map((row) => row['Id']),
        Contact: [contact(2)],
      });
      expect(fit).not.toHaveProperty('share');
      expect(fit.heldBy).toBe('caps');
    });

    it('says a plan that fits as it is, and changes nothing', async () => {
      orgs([]);

      await main(argv('--plan-only', '--json', '--fit', 'share'));

      const summary = JSON.parse(said()) as {
        fit: FitJson;
        plan: { totalRecords: number; scope: AutopilotPlanScope };
      };
      expect(summary.fit).toMatchObject({ applied: false, heldBy: 'whole' });
      expect(summary.fit).not.toHaveProperty('keptIds');
      expect(summary.plan.totalRecords).toBe(6);
      expect(summary.plan.scope.fitted).toBeUndefined();
    });

    it('says a real run would be refused when the plan cannot be cut to fit', async () => {
      orgs([]);

      await main(argv('--plan-only', '--fit-cap', '4', '--fit-within', '0.001'));

      expect(said()).toContain('fit: the plan cannot be fitted: with these caps the plan takes');
      expect(said()).toContain('a real run would be refused: The plan cannot be fitted to TGT');
    });
  });

  describe('a real run', () => {
    it('writes what the plan said, no contact of a cut account, and names both in --json', async () => {
      const { created } = orgs([]);

      await main(argv('--json', '--fit', 'share', '--fit-within', '0.006'));

      expect(created.map((entry) => [entry.object, entry.record['Name']])).toEqual([
        ['Account', 'Two'],
        ['Account', 'Four'],
        ['Contact', 'Of Two'],
      ]);
      const summary = JSON.parse(said()) as {
        fit: FitJson;
        created: Record<string, string[]>;
        result: { totalSuccess: number; totalFailure: number };
      };
      expect(summary.result).toMatchObject({ totalSuccess: 3, totalFailure: 0 });
      expect(summary.fit.keptIds?.['Account']).toEqual([account(2), account(4)]);
      expect(summary.created['Account']).toHaveLength(2);
    });

    it('reads the fitted objects by the ids kept', async () => {
      const events: string[] = [];
      orgs(events);

      await main(argv('--fit', 'share', '--fit-within', '0.006'));

      const reads = events.filter((event) => event.includes('FIELDS(ALL)'));
      expect(reads).toHaveLength(2);
      expect(reads.every((read) => read.includes('WHERE Id IN'))).toBe(true);
    });

    it('meets the gate again on the plan fitted: an org that lost room since refuses it', async () => {
      const { created } = orgs(
        [],
        [
          { maxMB: 200, remainingMB: 150 },
          { maxMB: 200, remainingMB: 0 },
        ],
      );

      await expect(main(argv('--fit', 'share', '--fit-within', '0.006'))).rejects.toThrow(
        'Nothing was written.',
      );
      expect(created).toEqual([]);
    });

    it('stops on a read of the source refused: nothing is chosen from what was not read', async () => {
      const { created, reading } = orgs([]);
      const answer = reading.conn.query;
      reading.conn.query = async (soql) => {
        if (soql.includes('Primary_Contact__c')) throw new Error('QUERY_TIMEOUT');
        return answer(soql);
      };

      await expect(main(argv('--fit', 'share'))).rejects.toThrow(
        'The plan could not be fitted: the source refused a read of it (QUERY_TIMEOUT).',
      );
      expect(created).toEqual([]);
    });

    it('refuses a plan that cannot be cut to fit, writing nothing', async () => {
      const { created } = orgs([]);

      await expect(main(argv('--fit-cap', '4', '--fit-within', '0.001'))).rejects.toThrow(
        /The plan cannot be fitted to TGT: with these caps the plan takes .* Nothing was written\.$/,
      );
      expect(created).toEqual([]);
    });

    it('refuses a fit when the target would not say what it has left', async () => {
      const { created } = orgs([]);
      vi.mocked(makeConn).mockImplementation((session) => {
        if (session.alias === 'SRC') {
          return fitConnection(fitOrg(rows())).conn as never;
        }
        return {
          ...countingConnection(fitOrg({})).conn,
          query: async () => ({
            records: [{ Id: '00D000000000001AAA', IsSandbox: true }],
            totalSize: 1,
            done: true,
          }),
          request: async () => {
            throw new Error('API_DISABLED_FOR_ORG');
          },
          sobject: (name: string) => ({ describe: async () => describeOf(fitOrg({}), name) }),
        } as never;
      });

      await expect(main(argv('--fit', 'share'))).rejects.toThrow(
        'The plan cannot be fitted to TGT, whose data storage left could not be read',
      );
      expect(created).toEqual([]);
    });
  });

  describe('its place in the run', () => {
    const LEAD_FLOW = automationOf([
      {
        objectApiName: 'Contact',
        flows: [
          {
            apiName: 'Contact_Task',
            label: 'Contact task',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions: [],
            creates: ['Task'],
          },
        ],
        triggers: [{ name: 'ContactTrigger', events: ['afterInsert'] }],
      },
    ]);
    const muted: MutedAutomation = {
      state: 'muted',
      assigned: ['PS_Bypass'],
      held: [],
      permissions: ['Bypass_Flow'],
      silenced: [],
      stillRan: [],
    };
    /** A mute whose lease holds one set, each step in `events`. */
    const muteOf = (events: string[]) => {
      vi.mocked(muteForRun).mockImplementation(async () => {
        events.push('leasePlan');
        return {
          automation: LEAD_FLOW,
          muted,
          plan: { assign: [{ permissionSet: 'PS', label: 'PS', permissions: ['Bypass_Flow'] }] },
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
        } as never;
      });
    };
    const ESTIMATE: RunCheckpointEstimate = {
      state: 'planned',
      estimate: { records: 3, apiRequests: 12, apiRequestsLeft: 14_000, seconds: 1, bytes: 6_000 },
      objects: ['Account', 'Contact'],
      added: [],
      notHeld: [],
      keepDays: 7,
    };
    const TAKEN: RunCheckpointTaken = {
      state: 'taken',
      checkpointId: 'ck-20261101-120000-a1b2',
      name: 'Before Autopilot run',
      takenAt: '2026-11-01T12:00:00.000Z',
      expiresAt: '2026-11-08T12:00:00.000Z',
      objects: ['Account', 'Contact'],
      records: 3,
      bytes: 6_000,
      requests: 12,
      added: [],
      notHeld: [],
    };
    /** The checkpoint the run takes, each step in `events`. */
    const checkpointsOf = (events: string[]) => {
      const port: CommandCheckpoints = {
        scope: vi.fn(async () => {
          events.push('scope');
          return ESTIMATE;
        }),
        take: vi.fn(async () => {
          events.push('take');
          return { taken: true as const, checkpoint: TAKEN };
        }),
        settle: vi.fn(async (taken: RunCheckpointTaken) => {
          events.push('settle');
          return taken;
        }),
      };
      vi.mocked(commandCheckpoints).mockReturnValue(port);
      return port;
    };

    it('reads the source once the mute is planned, before the checkpoint, the lease and the first write', async () => {
      const events: string[] = [];
      orgs(events);
      muteOf(events);
      checkpointsOf(events);

      await main(
        argv('--mute-automation', '--checkpoint-first', '--fit', 'share', '--fit-within', '0.006'),
      );

      const at = (step: string): number => events.indexOf(step);
      const fitRead = events.findIndex(
        (event) => event.startsWith('read ') && event.includes('Primary_Contact__c'),
      );
      expect(fitRead).toBeGreaterThan(at('leasePlan'));
      expect(fitRead).toBeLessThan(at('take'));
      expect(at('take')).toBeLessThan(at('lease'));
      // The gate is met again on the plan fitted, its /limits read again.
      const limits = events.flatMap((event, index) => (event === 'limits' ? [index] : []));
      expect(limits).toHaveLength(2);
      expect(limits[1]).toBeGreaterThan(fitRead);
      expect(limits[1]).toBeLessThan(at('take'));

      const steps = events.flatMap((event): WritePathStep[] => {
        if (event === 'leasePlan') return ['leasePlan'];
        if (event === 'scope') return ['stillRunning'];
        if (event === 'take') return ['checkpointTake'];
        if (event === 'lease') return ['leaseAcquire'];
        if (event === 'release') return ['leaseRelease'];
        if (event.startsWith('write') || event.startsWith('update')) return ['write'];
        if (event === 'limits' || event.startsWith('read ')) return ['reads'];
        return [];
      });
      expect(writePathOrderDefects(['reads', ...steps, 'result'])).toEqual([]);
    });

    it('keeps room for the flows that still run under the records, and names the triggers', async () => {
      orgs([]);
      readAutomation.mockResolvedValue(LEAD_FLOW);

      await main(argv('--plan-only', '--fit', 'share', '--fit-within', '0.009'));

      expect(said()).toContain('kept for what its flows still running create under these records');
      expect(said()).toContain('not counted: what Apex trigger ContactTrigger on Contact creates');
    });

    it('keeps none for what the mute keeps quiet, and assigns nothing to learn it', async () => {
      const events: string[] = [];
      orgs(events);
      muteOf(events);
      const raw = automationOf([
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Contact_Task',
              label: 'Contact task',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [{ name: 'Bypass_Flow', bypass: true, held: false }],
              creates: ['Task'],
            },
          ],
          triggers: [],
        },
      ]);
      readAutomation.mockResolvedValue(raw);

      // Room for four records: with the flow quiet, three accounts and the
      // contact of one, where its task would leave room for three.
      await main(
        argv('--plan-only', '--mute-automation', '--fit', 'share', '--fit-within', '0.009'),
      );

      expect(said()).toContain(
        'nothing kept for its flows: none still running creates records under these ' +
          '(--mute-automation keeps the others quiet)',
      );
      expect(said()).toContain('fitted plan: 4 record(s)');
      expect(events).not.toContain('lease');
    });

    it('counts the checkpoint in what the fit leaves the run of the day', async () => {
      // 14 000 left, a tenth of the 15 000 kept, 12 490 for the checkpoint: ten
      // calls of 200 records for the run.
      const many = {
        Account: Array.from({ length: 3_000 }, (_, i) => ({ Id: account(i + 1) })),
      };
      orgs([], undefined, many);
      const port = checkpointsOf([]);
      vi.mocked(port.scope).mockResolvedValue({
        ...ESTIMATE,
        estimate: { ...ESTIMATE.estimate, apiRequests: 12_490 },
      });

      await main(argv('--plan-only', '--json', '--checkpoint-first', '--fit', 'share'));

      const { fit } = JSON.parse(said()) as { fit: FitJson };
      expect(fit.heldBy).toBe('apiRequests');
      expect(fit.records).toBe(2_000);
    });

    it('holds a record that came to name what the fit cut, the run not partial, and says so', async () => {
      // The contact kept moves under the account cut, once the fit has read it.
      const { created } = orgs([], undefined, undefined, (asked, org) => {
        if (asked === 2) org.rows['Contact'][1]['AccountId'] = account(1);
      });

      await main(argv('--fit', 'share', '--fit-within', '0.006'));

      expect(created.map((entry) => entry.record['Name'])).toEqual(['Two', 'Four']);
      expect(said()).toContain('cut since the fit: 1, read naming a record the fit cut');
      expect(said()).toContain('CUT_WITH_PARENT x1');
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('scopes the checkpoint again when an object has no record left', async () => {
      const events: string[] = [];
      orgs(events);
      const port = checkpointsOf(events);

      await main(argv('--checkpoint-first', '--fit-cap', 'Account=1', '--fit-cap', 'Contact=1'));

      // The last account has no contact: the contact it would keep went with
      // its account, and Contact drops from what the run writes.
      expect(port.scope).toHaveBeenCalledTimes(2);
      expect(vi.mocked(port.scope).mock.calls[1][0].written).toEqual(['Account']);
    });
  });
});

describe('what a run says of a fit', () => {
  const report: AutopilotFitReport = {
    mode: { share: true },
    budget: {
      budgetMB: 16.4,
      remainingMB: 21,
      maxMB: 500,
      share: 0.8,
      roundingMB: 0.5,
      limitedBy: 'storage',
      automationMB: 0,
    },
    share: 0.26,
    objects: [
      {
        objectApiName: 'Account',
        inSource: 12_000,
        kept: 3_000,
        cutSpread: 9_000,
        cutWithParent: [],
      },
      {
        objectApiName: 'Contact',
        inSource: 20_000,
        kept: 5_000,
        cutSpread: 200,
        cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 14_800 }],
      },
    ],
    emptied: [],
    parents: [{ objectApiName: 'Region__c', records: 1 }],
    records: 8_001,
    estimateMB: 16.4,
    requestsRead: 19,
  };
  const fit: AutopilotPlanFit = {
    heldBy: 'storage',
    report,
    keptIds: new Map([['Account', ['001000000000001AAA']]]),
  };

  it('says what held it and what its terms are, the org by name', () => {
    expect(autopilotFitLines(fit, 'TGT', false)[0]).toBe(
      'fit: share 26 %, the largest that fits 16.4 MB: 80 % of the 21 MB TGT says it has left of ' +
        '500, 0.5 MB kept first for the rounding of what it says; nothing kept for its flows: ' +
        'none still running creates records under these',
    );
  });

  it('says each object, why the rest was cut, and the parents the kept records name', () => {
    const lines = autopilotFitLines(fit, 'TGT', false);

    expect(lines).toContain('  Account  3000 of 12000  cut 9000: 9000 spread over the table');
    expect(lines).toContain(
      '  Contact  5000 of 20000  cut 15000: 14800 with their Account (AccountId), ' +
        '200 spread over the table',
    );
    expect(lines).toContain('  Region__c: 1, those the kept records name');
    expect(lines).toContain(
      '  fitted plan: 8001 record(s), about 16.4 MB; 19 requests read to fit it',
    );
  });

  it('says what held it when it was the requests, the bound on records, or the caps', () => {
    const head = (heldBy: AutopilotPlanFit['heldBy']): string =>
      autopilotFitLines({ ...fit, heldBy }, 'TGT', false)[0];

    expect(head('apiRequests')).toContain('the largest whose writes leave TGT a tenth');
    expect(head('maxTotal')).toContain('the largest --max-total lets through');
    expect(head('caps')).toContain('fit: the caps asked, within the 16.4 MB that fit');
  });

  it('says no room was kept for an automation it could not read', () => {
    expect(
      autopilotFitLines({ ...fit, automationUnread: 'INSUFFICIENT_ACCESS' }, 'TGT', false)[0],
    ).toContain('no room kept for what its automation creates: it could not be read');
  });

  it('keeps the ids out of the summary of a plan it left whole', () => {
    expect(autopilotFitJson({ ...fit, heldBy: 'whole' })).not.toHaveProperty('keptIds');
  });

  it('says a fitted plan copies no object whole, and no bound cut it short', () => {
    const lines = scopeLines({
      maxDepth: 5,
      maxObjects: 50,
      selected: ['Account', 'Contact'],
      parents: [],
      leftEmpty: [],
      standardNeeded: [],
      fitted: report,
    });

    expect(lines).toContain(
      "  fitted to the target's storage, read by id: Account 3000 of 12000, Contact 5000 of 20000",
    );
    expect(lines.join('\n')).not.toContain('copied whole');
  });

  it('says what stayed out since the fit, apart from what was refused', () => {
    const lines = outcomeLines({
      totalSuccess: 1,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Contact'],
      failedObjects: [],
      skippedObjects: [],
      cutSinceFit: 2,
      objectOutcomes: {
        Contact: { written: 1, linked: 0, failed: 0, refusals: [], cutSinceFit: 2 },
      },
    });

    expect(lines[0]).toContain('written 1  linked 0  refused 0');
    expect(lines).toContain(
      '      CUT_WITH_PARENT x2: read naming a record the fit cut, and left out with it: ' +
        'neither written nor refused',
    );
  });
});
