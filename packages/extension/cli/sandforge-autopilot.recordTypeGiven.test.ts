import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});
// What the target runs, as the reader Forge's clone command reads it with
// would answer it: nothing, here.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: () => ({ read: readAutomation }),
}));
// The mute's lease, as the run asks it: tested on its own, here in the order
// the run calls it.
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import type {
  AutopilotNode,
  ForgeTargetAutomation,
  MutedAutomation,
  RecordTypeGiven,
} from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { main, outcomeLines } from './sandforge-autopilot';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../src/modules/checkpoint/beforeRunCheckpoint.js';
import { muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { countingConnection, describeOf, largeOrg, type LargeOrgField } from '../src/test/largeOrg';

/*
 * A record on Master in the source goes to the target without a record type,
 * and the target gives it the one it gives the user the run writes as: what
 * its plan says it would give, from the describe of that user, and what a
 * real run read back, as a clone and a sync say it.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const SOURCE_RETAIL = id('012', 1);
const TARGET_RETAIL = id('012', 101);

/** A record type of the target's Lead, as the describe of the run's user gives it. */
const recordType = (recordTypeId: string, developerName: string, available: boolean) => ({
  recordTypeId,
  developerName,
  name: developerName.replace(/_/g, ' '),
  available,
  active: true,
  master: false,
  defaultRecordTypeMapping: false,
});

/** The target's Lead for the run's user: Master the default, SFX_Retail the only other type open. */
const LEAD_TYPES = [
  recordType(id('012', 102), 'SFX_Hidden', false),
  recordType(TARGET_RETAIL, 'SFX_Retail', true),
  {
    ...recordType('012000000000000AAA', 'Master', true),
    master: true,
    defaultRecordTypeMapping: true,
  },
];

/** The field a Lead holds its record type in. */
const RECORD_TYPE_FIELD: LargeOrgField = {
  name: 'RecordTypeId',
  label: 'Record Type',
  type: 'reference',
  referenceTo: ['RecordType'],
  relationshipName: 'RecordType',
  nillable: true,
  createable: true,
  updateable: true,
  unique: false,
  externalId: false,
  cascadeDelete: false,
  defaultValue: null,
};

/** The record types statement the read back sends, its ids taken out. */
const READ_BACK =
  /^SELECT RecordTypeId, COUNT\(Id\) n FROM Lead WHERE Id IN \((.*)\) GROUP BY RecordTypeId$/;

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
 * A source of thirty leads, twenty of them on Master and ten on a type of its
 * own, and a target that gives a lead created without one SFX_Retail: each
 * describe of the target's Lead, write and read back in `events`.
 */
function orgs(events: string[]) {
  const org = largeOrg();
  org.objects.get('Lead')?.fields.push(RECORD_TYPE_FIELD);
  org.rows.Lead = (org.rows.Lead ?? []).map((row, i) => ({
    ...row,
    RecordTypeId: i < 20 ? null : SOURCE_RETAIL,
  }));
  const source = countingConnection(org);
  const target = countingConnection(org);
  const sourceConn = {
    ...source.conn,
    query: async (soql: string) => {
      if (soql === 'SELECT RecordTypeId, COUNT(Id) n FROM Lead GROUP BY RecordTypeId') {
        const records = [
          { RecordTypeId: null, n: 20 },
          { RecordTypeId: SOURCE_RETAIL, n: 10 },
        ];
        return { records, totalSize: records.length, done: true };
      }
      // The fake org answers the fields a read names.
      return source.conn.query(
        soql.startsWith('SELECT FIELDS(ALL) FROM Lead')
          ? soql.replace('FIELDS(ALL)', 'Id, LastName, Company, RecordTypeId')
          : soql,
      );
    },
  };
  /** The record type each lead the target holds went in with, by its id. */
  const held = new Map<string, string>();
  let next = 0;
  const targetConn = {
    ...target.conn,
    query: async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return {
          records: [{ Id: '00D000000000001AAA', IsSandbox: true }],
          totalSize: 1,
          done: true,
        };
      }
      const readBack = READ_BACK.exec(soql);
      if (!readBack) return target.conn.query(soql);
      events.push('read back');
      const counts = new Map<string, number>();
      for (const [, asked] of readBack[1].matchAll(/'([^']+)'/g)) {
        const type = held.get(asked);
        if (type !== undefined) counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      const records = [...counts].map(([RecordTypeId, n]) => ({ RecordTypeId, n }));
      return { records, totalSize: records.length, done: true };
    },
    request: vi.fn(async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
    })),
    sobject: (name: string) => ({
      describe: async () => {
        if (name !== 'Lead') return describeOf(org, name);
        events.push('describe Lead');
        return { ...describeOf(org, name), recordTypeInfos: LEAD_TYPES };
      },
      create: vi.fn(async (records: Array<Record<string, unknown>>) => {
        events.push(`write ${name}`);
        return records.map((record) => {
          const newId = id(name === 'Lead' ? '00Q' : '001', 900 + ++next);
          const sent = record['RecordTypeId'];
          held.set(newId, typeof sent === 'string' ? sent : TARGET_RETAIL);
          return { id: newId, success: true, errors: [] };
        });
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
    (session) => (session.alias === 'SRC' ? sourceConn : targetConn) as never,
  );
}

/** A mute whose lease assigned one set, each acquire and first release in `events`. */
function muteOf(events: string[]) {
  const muted: MutedAutomation = {
    state: 'muted',
    assigned: ['PS_Bypass'],
    held: [],
    permissions: ['Bypass_Flow'],
    silenced: [],
    stillRan: [],
  };
  const read: ForgeTargetAutomation = {
    objectsRead: ['Lead'],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };
  vi.mocked(muteForRun).mockResolvedValue({
    automation: read,
    muted,
    plan: { assign: [{ name: 'PS_Bypass' }] },
    prepared: {
      acquire: async () => {
        events.push('lease');
        // Once is enough, and again answers the same, as a lease does.
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
  } as never);
}

/** What the plan's Lead says of the records created without a record type. */
const SAID: RecordTypeGiven = {
  objectApiName: 'Lead',
  rows: 20,
  why: { masterInSource: 20 },
  predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
};

describe('sandforge-autopilot — the record type the target gives a record sent without one', () => {
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
    readAutomation.mockReset();
    readAutomation.mockResolvedValue({
      objectsRead: ['Lead'],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 4,
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.mocked(muteForRun).mockReset();
  });

  it('says with --plan-only how many would go without one and the type they would get, on the node in --json, writing nothing', async () => {
    const events: string[] = [];
    orgs(events);

    await main(argv('--plan-only', '--json'));

    const printed = JSON.parse(out.join('')) as { graph: { nodes: AutopilotNode[] } };
    const lead = printed.graph.nodes.find((node) => node.objectApiName === 'Lead');
    expect(lead?.recordTypeGiven).toEqual(SAID);
    expect(err.join('')).toContain(
      'record types the target would give the records created without one (1 object(s)):\n' +
        '  Lead  20 record(s) on Master in the source: would go in as SFX_Retail (SFX Retail), ' +
        'the only other Lead record type open to the user the run writes as, whose describe ' +
        'names Master the default\n',
    );
    expect(events.filter((event) => event.startsWith('write'))).toEqual([]);
  });

  it('says with --plan-only that the sets a mute assigns may open other types, when it assigns any', async () => {
    orgs([]);
    muteOf([]);

    await main(argv('--plan-only', '--mute-automation'));

    expect(out.join('')).toContain(
      '  the permission sets a real run assigns to mute the automation may open other record ' +
        'types to the user it writes as',
    );
  });

  it('says a real run what the first of them were read back holding, in its lines and in --json', async () => {
    orgs([]);

    await main(argv('--json'));

    const printed = JSON.parse(out.join('')) as {
      result: Parameters<typeof outcomeLines>[0];
    };
    const given = printed.result.objectOutcomes?.['Lead']?.recordTypeGiven;
    expect(given).toEqual({
      ...SAID,
      readBack: {
        read: 20,
        types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 20 }],
      },
    });
    expect(outcomeLines(printed.result)).toContain(
      '  Lead  20 record(s) on Master in the source: went in as SFX_Retail (SFX Retail), read ' +
        'back on 20',
    );
  });

  it('keeps the order of a muted run: the lease, the record types read again, the writes, the lease given back, the read back', async () => {
    const events: string[] = [];
    orgs(events);
    muteOf(events);

    await main(argv('--mute-automation', '--json'));

    const afterTheLease = events.slice(events.indexOf('lease'));
    const steps = afterTheLease.map((event): WritePathStep => {
      if (event === 'lease') return 'leaseAcquire';
      if (event === 'describe Lead') return 'afterLeaseCheck';
      if (event === 'release') return 'leaseRelease';
      if (event === 'read back') return 'recordTypeReadBack';
      return 'write';
    });
    expect(writePathOrderDefects(['reads', 'leasePlan', 'question', ...steps, 'result'])).toEqual(
      [],
    );
    // The run's first describe of the object comes under the lease too: its
    // fields, then the record types read again. The writes follow both.
    expect(afterTheLease).toEqual([
      'lease',
      'describe Lead',
      'describe Lead',
      'write Lead',
      'release',
      'read back',
    ]);
  });
});
