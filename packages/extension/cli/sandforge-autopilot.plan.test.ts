import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});
// What the target runs, as the reader Forge's clone command reads it with
// would answer: no automation, unless a test gives some.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: () => ({ read: readAutomation }),
}));

import type { ForgeTargetAutomation } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import {
  autopilotInterruptedLine,
  autopilotRunStatus,
  main,
  parseArgs,
} from './sandforge-autopilot';
import { countingConnection, largeOrg } from '../src/test/largeOrg';

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
  ...rest,
];

/**
 * A source and a target over the same large org, the target with
 * `remainingMB` of storage and `singleEmailsLeft` of its fifteen single emails.
 * The target says it is `kind`: a sandbox unless a test says otherwise.
 */
function orgs(
  remainingMB: number,
  singleEmailsLeft = 15,
  kind: Record<string, unknown> = { IsSandbox: true },
) {
  const org = largeOrg();
  const source = countingConnection(org);
  const target = countingConnection(org);
  const create = vi.fn(
    async (
      records: unknown[],
    ): Promise<Array<{ id?: string; success: boolean; errors: unknown[] }>> =>
      records.map((_, i) => ({ id: `new-${i}`, success: true, errors: [] })),
  );
  const conn = {
    ...target.conn,
    // What the target says it is, which the run is refused on before its scan.
    query: async (soql: string) =>
      soql.includes('FROM Organization')
        ? {
            records: [{ Id: '00D000000000001AAA', ...kind }],
            totalSize: 1,
            done: true as const,
          }
        : target.conn.query(soql),
    request: vi.fn(async (): Promise<Record<string, unknown>> => ({
      DataStorageMB: { Max: 200, Remaining: remainingMB },
      SingleEmail: { Max: 15, Remaining: singleEmailsLeft },
    })),
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
  return { source, create, limits: conn.request };
}

describe('sandforge-autopilot — what a plan copies', () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(automationOf([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('neutralizes emails and phone numbers unless --keep-contact-points is given', () => {
    expect(parseArgs(argv('--object', 'Lead')).keepContactPoints).toBe(false);
    expect(parseArgs(argv('--object', 'Lead', '--keep-contact-points')).keepContactPoints).toBe(
      true,
    );
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

  it("refuses a run past the target's daily API requests before it writes anything", async () => {
    // The panel's run was held to them; the command line wrote until the
    // org answered REQUEST_LIMIT_EXCEEDED, part way through.
    const { create, limits } = orgs(150);
    limits.mockResolvedValue({
      DataStorageMB: { Max: 200, Remaining: 150 },
      DailyApiRequests: { Max: 15_000, Remaining: 1 },
      SingleEmail: { Max: 15, Remaining: 15 },
    });

    const run = main(argv('--object', 'Lead', '--object', 'Obj004__c'));

    await expect(run).rejects.toThrow(/API requests.*REQUEST_LIMIT_EXCEEDED/);
    const message = await run.then(
      () => '',
      (err: unknown) => String(err),
    );
    expect(message.match(/Nothing was written\./g)).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('reads the daily API requests on their own when the target says nothing of its storage, and says them with --plan-only', async () => {
    // A Standard User's limits list the daily requests and not the storage.
    const { limits } = orgs(150);
    limits.mockResolvedValue({ DailyApiRequests: { Max: 15_000, Remaining: 0 } });

    await main(argv('--object', 'Lead', '--plan-only', '--json'));

    const printed = JSON.parse(out.join('')) as {
      writeGate: { apiRequests: { verdict: string; remaining: number }; refusals: string[] };
    };
    expect(printed.writeGate.apiRequests).toMatchObject({ verdict: 'exceeds', remaining: 0 });
    expect(printed.writeGate.refusals.some((r) => r.includes('REQUEST_LIMIT_EXCEEDED'))).toBe(true);
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

  it("refuses a run the target's flows would send more emails for than it has left today, and says so with --plan-only", async () => {
    // Autopilot read none of the target's automation: thirty leads into a
    // Developer Edition whose lead flow sends an email for each would have
    // taken it past its fifteen single emails a day, nothing said.
    const { create } = orgs(150, 15);
    readAutomation.mockResolvedValue(
      automationOf([
        {
          objectApiName: 'Lead',
          flows: [
            {
              apiName: 'Lead_Welcome',
              label: 'Lead welcome',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [],
              messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ]),
    );

    await expect(main(argv('--object', 'Lead'))).rejects.toThrow(
      /The target's automation would make TGT send about 30 single emails, 15 of 15 left today.*Nothing was written\./,
    );
    expect(create).not.toHaveBeenCalled();
    expect(readAutomation).toHaveBeenCalledWith('TGT', expect.arrayContaining(['Lead']));

    out.length = 0;
    await main(argv('--object', 'Lead', '--plan-only'));
    const printed = out.join('');
    expect(printed).toContain(
      '  emails: these records make TGT send about 30 single emails (1 per Lead, by Lead ' +
        'welcome), more than the 15 of 15 it has left today',
    );
    expect(printed).toContain(
      "a real run would be refused: The target's automation would make TGT send about 30 single emails",
    );
  });

  it('says the emails fit, and refuses nothing for them, when the target has them left', async () => {
    orgs(150, 15);
    readAutomation.mockResolvedValue(
      automationOf([
        {
          objectApiName: 'Lead',
          flows: [
            {
              apiName: 'Lead_Welcome',
              label: 'Lead welcome',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [{ name: 'Skip_Welcome', bypass: true, held: true }],
              messages: [{ kind: 'email', name: 'Send welcome', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ]),
    );

    await main(argv('--object', 'Lead', '--plan-only'));

    // A bypass the user holds keeps the flow quiet: nothing to count.
    const printed = out.join('');
    expect(printed).not.toContain('emails:');
    expect(printed).not.toContain('a real run would be refused');
  });
});

describe('sandforge-autopilot — a run Ctrl-C stops', () => {
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
    readAutomation.mockResolvedValue(automationOf([]));
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('stops between two calls, says what it wrote, names the records it created, and exits 130', async () => {
    // Killed outright, a run printed nothing of the records it had created,
    // and nothing could take them back.
    // The whole run, for the calls it makes.
    const whole = orgs(150);
    await main(argv('--object', 'Lead', '--object', 'Obj004__c', '--json'));
    const calls = whole.create.mock.calls.length;
    out.length = 0;

    const { create } = orgs(150);
    create.mockImplementationOnce(async (records: unknown[]) => {
      process.emit('SIGINT');
      return records.map((_, i) => ({ id: `new-${i}`, success: true, errors: [] }));
    });

    await main(argv('--object', 'Lead', '--object', 'Obj004__c', '--json'));

    // The calls under way went through; none was sent after them.
    expect(calls).toBeGreaterThan(2);
    expect(create.mock.calls.length).toBeLessThan(calls);
    const sent = create.mock.calls
      .map((call) => (call[0] as unknown[]).length)
      .reduce((sum, rows) => sum + rows, 0);
    const printed = JSON.parse(out.join('')) as {
      interrupted?: boolean;
      result: { stopped?: boolean; totalSuccess: number; stoppedObjects?: string[] };
      created: Record<string, string[]>;
    };
    expect(printed.interrupted).toBe(true);
    expect(printed.result).toMatchObject({ stopped: true, totalSuccess: sent });
    expect(printed.result.stoppedObjects?.length).toBeGreaterThan(0);
    expect(Object.values(printed.created).flat()).toHaveLength(sent);
    expect(err.join('')).toContain(autopilotInterruptedLine(printed.result));
    expect(err.join('')).toContain(
      `interrupted: the run stopped before it was through, ${sent} record(s) written`,
    );
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});

describe('sandforge-autopilot — what the command line refuses, and how a run ends', () => {
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
      throw new Error(`exit ${code}`);
    }) as never);
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(automationOf([]));
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('writes nothing to a production org, refused before the scan reads either org, and exits 1', async () => {
    // Nothing keeps what an Autopilot run creates, and its gate held it to
    // volumes alone: a CI alias left on a production org took the run.
    const { source, create } = orgs(150, 15, {
      IsSandbox: false,
      OrganizationType: 'Enterprise Edition',
    });

    await expect(main(argv('--object', 'Lead'))).rejects.toThrow('exit 1');

    expect(create).not.toHaveBeenCalled();
    expect(source.total()).toBe(0);
    expect(err.join('')).toContain(
      'TGT is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge-autopilot writes to sandboxes and Developer Edition ' +
        'orgs only. Nothing was written; --plan-only, which only reads, runs against it.',
    );
  });

  it('plans against a production org all the same with --plan-only, which only reads', async () => {
    orgs(150, 15, { IsSandbox: false, OrganizationType: 'Enterprise Edition' });

    await main(argv('--object', 'Lead', '--plan-only'));

    expect(out.join('')).toContain('plan: ');
  });

  it('refuses --plan-only=true, which it dropped and ran for real, before any org is reached', () => {
    orgs(150);
    vi.mocked(loadOrg).mockClear();

    expect(() => parseArgs(argv('--object', 'Lead', '--plan-only=true'))).toThrow('exit 2');
    expect(() => parseArgs(argv('--object', 'Lead', '--planonly'))).toThrow('exit 2');
    expect(err.join('')).toContain('"--plan-only=true" is not read');
    expect(err.join('')).toContain('"--planonly" is not a flag this command reads');
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('exits 1 when the target refused every record, and 3 for a partial run with --fail-on-partial', async () => {
    // Every record refused, the run exited 0 as one that wrote them all.
    const refused = orgs(150);
    refused.create.mockImplementation(async (records: unknown[]) =>
      records.map(() => ({ success: false, errors: [{ statusCode: 'X', message: 'no' }] })),
    );
    await main(argv('--object', 'Lead', '--json'));
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    let calls = 0;
    const partly = vi.fn(async (records: unknown[]) =>
      records.map((_, i) =>
        calls++ === 0
          ? { success: false, errors: [{ statusCode: 'X', message: 'no' }] }
          : { id: `new-${i}`, success: true, errors: [] },
      ),
    );
    orgs(150).create.mockImplementation(partly);
    await main(argv('--object', 'Lead', '--json'));
    expect(process.exitCode).toBeUndefined();
    calls = 0;
    orgs(150).create.mockImplementation(partly);
    await main(argv('--object', 'Lead', '--json', '--fail-on-partial'));
    expect(process.exitCode).toBe(3);
  });

  it('stops at a SIGTERM, as Jenkins sends on abort or timeout, as at Ctrl-C, and exits 143', async () => {
    const { create } = orgs(150);
    create.mockImplementationOnce(async (records: unknown[]) => {
      process.emit('SIGTERM');
      return records.map((_, i) => ({ id: `new-${i}`, success: true, errors: [] }));
    });

    await main(argv('--object', 'Lead', '--object', 'Obj004__c', '--json'));

    const printed = JSON.parse(out.join('')) as {
      interrupted?: boolean;
      created: Record<string, string[]>;
    };
    expect(printed.interrupted).toBe(true);
    expect(Object.values(printed.created).flat().length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('takes a run that died, or wrote nothing it was sent, for a failure, and one the target refused part of for partial', () => {
    const run = { totalSuccess: 3, totalFailure: 0, failedObjects: [] };
    expect(autopilotRunStatus(run)).toBe('success');
    expect(autopilotRunStatus({ ...run, totalFailure: 1 })).toBe('partial');
    expect(autopilotRunStatus({ ...run, totalSuccess: 0, totalFailure: 2 })).toBe('failure');
    expect(autopilotRunStatus({ ...run, fatalError: 'INVALID_SESSION_ID' })).toBe('failure');
    expect(autopilotRunStatus({ ...run, failedObjects: ['Lead'] })).toBe('partial');
  });
});
