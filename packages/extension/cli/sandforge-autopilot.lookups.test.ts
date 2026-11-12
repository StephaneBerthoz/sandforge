import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { ForgeTargetAutomation } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { main } from './sandforge-autopilot';
import { countingConnection, describeOf, largeOrg, type LargeOrgField } from '../src/test/largeOrg';

/*
 * A run whose every record the target took, one of them left without a lookup
 * its second pass could not fill: nothing in the run's totals says so, and it
 * exited as one that did all it set out to.
 */

/** A lookup of a lead at another lead, which a record read first owes one read after it. */
const REFERRED_BY: LargeOrgField = {
  name: 'Referred_By__c',
  label: 'Referred by',
  type: 'reference',
  referenceTo: ['Lead'],
  relationshipName: 'Referred_By__r',
  nillable: true,
  createable: true,
  updateable: true,
  unique: false,
  externalId: false,
  cascadeDelete: false,
  defaultValue: null,
};

/** What an org answers an update setting a lookup at a record its user may not see. */
const NO_ACCESS = {
  statusCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  message: 'insufficient access rights on cross-reference id',
  fields: [],
};

const NOTHING_RUNS: ForgeTargetAutomation = {
  objectsRead: ['Lead'],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

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

/** A source whose first lead names its second, and a target that answers each update as told. */
function orgs(answerUpdate: (record: { Id: string }) => Record<string, unknown>) {
  const org = largeOrg();
  org.objects.get('Lead')?.fields.push(REFERRED_BY);
  const leads = (org.rows.Lead ?? []).slice(0, 3);
  org.rows.Lead = leads.map((row, i) => ({
    ...row,
    Referred_By__c: i === 0 ? String(leads[1]?.['Id']) : null,
  }));
  const source = countingConnection(org);
  const target = countingConnection(org);
  const sourceConn = {
    ...source.conn,
    query: async (soql: string) =>
      // The fake org answers the fields a read names.
      source.conn.query(
        soql.startsWith('SELECT FIELDS(ALL) FROM Lead')
          ? soql.replace('FIELDS(ALL)', 'Id, LastName, Company, Referred_By__c')
          : soql,
      ),
  };
  let next = 0;
  const update = vi.fn(async (records: Array<{ Id: string }>) => records.map(answerUpdate));
  const targetConn = {
    ...target.conn,
    query: async (soql: string) =>
      soql.includes('FROM Organization')
        ? { records: [{ Id: '00D000000000001AAA', IsSandbox: true }], totalSize: 1, done: true }
        : target.conn.query(soql),
    request: vi.fn(async () => ({
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
    })),
    sobject: (name: string) => ({
      describe: async () => describeOf(org, name),
      create: async (records: unknown[]) =>
        records.map(() => ({ id: `00Q00000000${++next}AAA`, success: true, errors: [] })),
      update,
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
  return { update };
}

const refuseIt = (): Record<string, unknown> => ({ success: false, errors: [NO_ACCESS] });
const takeIt = (record: { Id: string }): Record<string, unknown> => ({
  id: record.Id,
  success: true,
  errors: [],
});

describe('sandforge-autopilot — a lookup the second pass could not fill', () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(NOTHING_RUNS);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('exits 3 under --fail-on-partial, every record written', async () => {
    const { update } = orgs(refuseIt);

    await main(argv('--json', '--fail-on-partial'));

    expect(update).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(3);
  });

  it('says partial in --json, with the record left, the lookup and why', async () => {
    orgs(refuseIt);

    await main(argv('--json'));

    const printed = JSON.parse(out.join('')) as {
      result: { status: string; totalSuccess: number; totalFailure: number; lookups: unknown };
    };
    expect(printed.result).toMatchObject({ status: 'partial', totalSuccess: 3, totalFailure: 0 });
    expect(printed.result.lookups).toEqual({
      Lead: {
        filled: 0,
        refusals: [{ ...NO_ACCESS, fields: ['Referred_By__c'], count: 1 }],
        leftEmpty: 1,
      },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('says partial on its summary, above what it wrote', async () => {
    orgs(refuseIt);

    await main(argv());

    const printed = out.join('');
    expect(printed).toContain('\nstatus:  partial\nwritten: 3');
    expect(printed).toContain('lookups filled 0  refused 1');
    expect(printed).toContain('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY [Referred_By__c] x1');
  });

  it('stays a success, and exits 0 under --fail-on-partial, when the pass filled them all', async () => {
    orgs(takeIt);

    await main(argv('--json', '--fail-on-partial'));

    const printed = JSON.parse(out.join('')) as { result: { status: string; lookups: unknown } };
    expect(printed.result.status).toBe('success');
    expect(printed.result.lookups).toEqual({ Lead: { filled: 1, refusals: [] } });
    expect(process.exitCode).toBeUndefined();
  });
});
