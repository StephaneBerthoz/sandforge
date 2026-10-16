import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});

import { loadOrg, makeConn } from './sfSession.js';
import { main, parseArgs } from './sandforge-autopilot';
import { countingConnection, largeOrg } from '../src/test/largeOrg';

/** The command line, after the script's own two words. */
const argv = (...rest: string[]) => [
  'node',
  'sandforge-autopilot.ts',
  '--source',
  'SRC',
  '--target',
  'TGT',
  ...rest,
];

/** A source and a target over the same large org, the target with `remainingMB` of storage. */
function orgs(remainingMB: number) {
  const org = largeOrg();
  const source = countingConnection(org);
  const target = countingConnection(org);
  const create = vi.fn(async (records: unknown[]) =>
    records.map((_, i) => ({ id: `new-${i}`, success: true, errors: [] })),
  );
  const conn = {
    ...target.conn,
    request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: remainingMB } })),
    sobject: (name: string) => ({ ...target.conn.sobject(name), create }),
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
  return { source, create };
}

describe('sandforge-autopilot — what a plan copies', () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the bounds of the walk and the most records a run writes', () => {
    expect(parseArgs(argv('--object', 'Lead'))).toMatchObject({
      maxDepth: 5,
      maxObjects: 50,
      maxTotal: 10_000,
    });
    expect(
      parseArgs(
        argv('--object', 'Lead', '--max-depth', '2', '--max-objects', '8', '--max-total', '40'),
      ),
    ).toMatchObject({ maxDepth: 2, maxObjects: 8, maxTotal: 40 });
  });

  it('plans two objects of a large org as a bounded set, the parents counted by what they reference', async () => {
    // Run for real, the same request planned 601 objects and 2.6 million
    // records: every table the walk reached, whole.
    orgs(150);

    await main(argv('--object', 'Lead', '--object', 'Obj004__c', '--plan-only', '--json'));

    const printed = JSON.parse(out.join('')) as {
      graph: { nodes: Array<{ objectApiName: string; recordCount: number }> };
      plan: { totalRecords: number; scope: { leftEmpty: unknown[] } };
      writeGate: { records: number; refusals: string[] };
    };
    expect(printed.graph.nodes.length).toBeLessThanOrEqual(50);
    const postcodes = printed.graph.nodes.find((n) => n.objectApiName === 'PostalCode__c');
    expect(postcodes?.recordCount).toBe(4);
    expect(printed.plan.totalRecords).toBeLessThan(100);
    expect(printed.plan.scope.leftEmpty.length).toBeGreaterThan(0);
    expect(printed.writeGate).toMatchObject({ records: printed.plan.totalRecords, refusals: [] });
  });

  it('anonymizes the names, emails and phones of a lead under GDPR, without any AI scan', async () => {
    orgs(150);

    await main(argv('--object', 'Lead', '--compliance', 'gdpr', '--plan-only', '--json'));

    const printed = JSON.parse(out.join('')) as {
      plan: {
        anonymizationSummary: { totalPiiFields: number; notCovered?: unknown[] };
      };
    };
    expect(printed.plan.anonymizationSummary.totalPiiFields).toBeGreaterThanOrEqual(4);
    expect(printed.plan.anonymizationSummary.notCovered).toBeUndefined();
  });

  it("refuses a run past the target's data storage before it writes anything", async () => {
    const { create } = orgs(0.01);

    await expect(main(argv('--object', 'Lead', '--object', 'Obj004__c'))).rejects.toThrow(
      /data storage.*Nothing was written\./,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a run past --max-total, and says what a plan-only run would meet', async () => {
    const { create } = orgs(150);

    await expect(main(argv('--object', 'Lead', '--max-total', '5'))).rejects.toThrow(
      /more than --max-total 5/,
    );
    expect(create).not.toHaveBeenCalled();

    out.length = 0;
    await main(argv('--object', 'Lead', '--max-total', '5', '--plan-only'));
    expect(out.join('')).toContain('a real run would be refused: The run would write 30 records');
  });
});
