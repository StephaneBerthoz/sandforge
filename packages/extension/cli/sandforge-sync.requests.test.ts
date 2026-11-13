/**
 * The API requests a run of `sandforge-sync` sends its target, as its
 * `--json` says them (`apiRequests`): what its gate priced the run at and
 * every request the command sent the target, counted as it sent them,
 * through the real orchestrator over a pair of fake orgs whose target takes
 * each call through its own `request`, as jsforce sends each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation } from '@sandforge/shared';

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
// What the target runs, as the clone's reader would answer it: nothing that
// sends an email, read in four requests.
const readAutomation = vi.hoisted(() => vi.fn());
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: (conn: { request: (url: string) => Promise<unknown> }) => ({
    read: async (...args: unknown[]) => {
      for (const url of ['/flows', '/triggers', '/processes', '/rules']) await conn.request(url);
      return readAutomation(...args);
    },
  }),
}));

import { makeConn } from './sfSession.js';
import { main, syncApiRequestsJson } from './sandforge-sync.js';

const QUIET: ForgeTargetAutomation = {
  objectsRead: ['Account'],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

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

const ACCOUNTS = Array.from({ length: 150 }, (_, i) => ({
  Id: `001${String(i + 1).padStart(12, '0')}AAA`,
  Name: `Account ${i + 1}`,
}));

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

/** A lookup of the accounts at a contact the target does not hold. */
const KEY_CONTACT = 'Key_Contact__c';

/** What the target is, beside its room to spare. */
interface TargetShape {
  /**
   * The accounts' first write refused whole, every row for its lookup at a
   * contact the target does not hold, as Salesforce refuses one: the run
   * sends them again without it.
   */
  refusesFirst?: boolean;
  /** The accounts the target holds, which a whole read of them takes 1,000 a page, as the org answered. */
  held?: number;
}

/**
 * A source of 150 accounts and a sandbox target with room to spare, whose
 * every call — a query, a describe, who the session is, a write of up to 200
 * records, its limits — goes through its connection's `request`, looked up
 * at each call as jsforce's methods call the connection's own, and is listed
 * in `targetRequests` as the target took it; each statement it was asked,
 * in `targetStatements`.
 */
function orgs(shape: TargetShape = {}): { targetRequests: string[]; targetStatements: string[] } {
  const targetRequests: string[] = [];
  const targetStatements: string[] = [];
  const page = (records: unknown[]) => ({ records, totalSize: records.length, done: true });
  const described = shape.refusesFirst
    ? {
        ...DESCRIBED,
        fields: [
          ...DESCRIBED.fields,
          field(KEY_CONTACT, 'reference', { referenceTo: ['Contact'] }),
        ],
      }
    : DESCRIBED;
  const sourceAccounts = shape.refusesFirst
    ? ACCOUNTS.map((account, i) => ({
        ...account,
        [KEY_CONTACT]: `003${String(i + 1).padStart(12, '0')}AAA`,
      }))
    : ACCOUNTS;
  const held = Array.from({ length: shape.held ?? 0 }, (_, i) => ({
    Id: `001${String(i + 5_000).padStart(12, '0')}AAA`,
    Name: `Held ${i + 1}`,
  }));
  /** A page of the whole read of the target's accounts, from `from`. */
  const heldPage = (from: number) => ({
    records: held.slice(from, from + 1_000),
    totalSize: held.length,
    done: from + 1_000 >= held.length,
    ...(from + 1_000 < held.length ? { nextRecordsUrl: `/query/next-${from + 1_000}` } : {}),
  });
  let creates = 0;
  const conn = (side: 'source' | 'target') => {
    const self: Record<string, unknown> = { version: '66.0' };
    const send = (url: string): Promise<unknown> =>
      (self.request as (request: { method: string; url: string }) => Promise<unknown>)({
        method: 'GET',
        url,
      });
    self.request = async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      if (side === 'target') targetRequests.push(url);
      return url === '/limits'
        ? {
            DataStorageMB: { Max: 200, Remaining: 150 },
            DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
            SingleEmail: { Max: 5_000, Remaining: 5_000 },
          }
        : {};
    };
    self.query = async (soql: string) => {
      await send('/query');
      if (side === 'target') targetStatements.push(soql);
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true }]);
      }
      if (/COUNT\(\)/.test(soql)) {
        return {
          records: [],
          totalSize: side === 'source' ? ACCOUNTS.length : held.length,
          done: true,
        };
      }
      if (soql.includes('FROM Account')) {
        if (side === 'source') return page(sourceAccounts);
        // Read whole, page by page; by the ids the keeper names, none.
        return / WHERE Id IN /.test(soql) ? page([]) : heldPage(0);
      }
      return page([]);
    };
    self.queryMore = async (url: string) => {
      await send('/query/next');
      const from = /next-(\d+)$/.exec(url);
      return from ? heldPage(Number(from[1])) : page([]);
    };
    self.sobject = () => ({
      describe: async () => {
        await send('/sobjects/Account/describe');
        return described;
      },
      create: async (records: unknown[]) => {
        await send('/composite/sobjects');
        if (shape.refusesFirst && creates++ === 0) {
          return records.map(() => ({
            success: false,
            errors: [
              {
                statusCode: 'INVALID_CROSS_REFERENCE_KEY',
                message: 'invalid cross reference id',
                fields: [KEY_CONTACT],
              },
            ],
          }));
        }
        return records.map((_, i) => ({
          id: `001${String(i + 900).padStart(12, '0')}AAA`,
          success: true,
          errors: [],
        }));
      },
      update: async (records: Array<{ Id: string }>) => {
        await send('/composite/sobjects/update');
        return records.map((record) => ({ id: record.Id, success: true, errors: [] }));
      },
    });
    self.describe = async () => {
      await send('/sobjects/Account/describe');
      return described;
    };
    self.identity = async () => {
      await send('/');
      await send('/id');
      return { user_id: '005000000000007AAA', organization_id: '00D000000000002AAA' };
    };
    self.tooling = {
      query: async () => {
        await send('/tooling/query');
        return page([]);
      },
      queryMore: async () => {
        await send('/tooling/query/next');
        return page([]);
      },
    };
    return self;
  };
  const source = conn('source');
  const target = conn('target');
  vi.mocked(makeConn).mockImplementation(
    (session) => (session.alias === 'SRC' ? source : target) as unknown as Connection,
  );
  return { targetRequests, targetStatements };
}

/** Thrown where the command would exit: a test reads the code. */
class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

describe('sandforge-sync --json, its API requests', () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as never);
    readAutomation.mockReset();
    readAutomation.mockResolvedValue(QUIET);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  /** What `main` printed on stdout, read as its summary. */
  const summaryOf = async (line: string[]) => {
    out.length = 0;
    await main(line);
    return JSON.parse(out.join('')) as {
      apiRequests: { estimate?: number; verdict?: string; sent: number };
    };
  };

  it('says every request it sent the target beside what its gate priced, a dry run and a run alike', async () => {
    const dry = orgs();
    const planned = await summaryOf(argv('--dry-run', '--json'));
    // Every request the target took, as it took it: the source's are its own.
    expect(planned.apiRequests.sent).toBe(dry.targetRequests.length);
    expect(planned.apiRequests.verdict).toBe('fits');

    const real = orgs();
    const ran = await summaryOf(argv('--json'));
    expect(ran.apiRequests.sent).toBe(real.targetRequests.length);
    // Its write: 150 accounts in one call.
    expect(real.targetRequests.filter((url) => url === '/composite/sobjects')).toHaveLength(1);
    // Who the run writes as, read once, its two requests among those sent.
    expect(real.targetRequests.filter((url) => url === '/' || url === '/id')).toHaveLength(2);
    // Priced with what it sent before its gate, as sent: never fewer than
    // it then sent, and the dry run says what the run would.
    expect(ran.apiRequests.estimate).toBeGreaterThanOrEqual(ran.apiRequests.sent);
    expect(planned.apiRequests.estimate).toBeGreaterThanOrEqual(ran.apiRequests.sent);
  });

  it('prices an update with the reads of what it writes over, sent past its gate: never fewer than it sends', async () => {
    const real = orgs();
    const ran = await summaryOf(argv('--operation', 'update', '--json'));

    // Its write, and before it the read of what it writes over.
    expect(real.targetRequests.filter((url) => url === '/composite/sobjects/update')).toHaveLength(
      1,
    );
    expect(ran.apiRequests.sent).toBe(real.targetRequests.length);
    expect(ran.apiRequests.estimate).toBeGreaterThanOrEqual(ran.apiRequests.sent);
  });

  it('prices the rows the target refused sent again, a call a pass: never fewer than it sends', async () => {
    const real = orgs({ refusesFirst: true });
    const ran = await summaryOf(argv('--json'));

    // Its write, refused whole, then sent again without the lookup.
    expect(real.targetRequests.filter((url) => url === '/composite/sobjects')).toHaveLength(2);
    expect(ran.apiRequests.sent).toBe(real.targetRequests.length);
    expect(ran.apiRequests.estimate).toBeGreaterThanOrEqual(ran.apiRequests.sent);
  });

  describe('of a configuration that runs both ways', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-both-ways-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** A saved configuration updating the accounts under a filter, both ways. */
    const bothWays = (): string[] => {
      const file = join(dir, 'config.json');
      writeFileSync(
        file,
        JSON.stringify({
          id: 'cfg-both-ways',
          name: 'Accounts both ways',
          description: '',
          sourceOrgId: '00D000000000001AAA',
          targetOrgId: '00D000000000002AAA',
          direction: 'bidirectional',
          mode: 'full',
          objects: [
            {
              objectApiName: 'Account',
              operation: 'update',
              where: "Name LIKE 'Account%'",
              fieldMappings: [],
              transformRules: [],
              excludedFields: [],
              addOnFields: [],
              insertOrder: 0,
            },
          ],
          conflictStrategy: 'source_wins',
          enableRollback: false,
        }),
      );
      return [
        'node',
        'sandforge-sync.ts',
        '--config-file',
        file,
        '--store',
        join(dir, 'store'),
        '--source',
        'SRC',
        '--target',
        'TGT',
      ];
    };

    it('prices the whole read of the target it compares with, counted under the filter at its gate: never fewer than it sends', async () => {
      const real = orgs({ held: 12_000 });
      out.length = 0;
      await main([...bothWays(), '--json']);
      const ran = JSON.parse(out.join('')) as {
        apiRequests: { estimate?: number; sent: number };
      };

      // Counted at the gate under the object's filter, then read whole: its
      // describe and twelve pages of 1,000, thirteen requests priced nowhere.
      expect(real.targetStatements).toContain(
        "SELECT COUNT() FROM Account WHERE Name LIKE 'Account%'",
      );
      expect(real.targetRequests.filter((url) => url === '/query/next')).toHaveLength(11);
      expect(ran.apiRequests.sent).toBe(real.targetRequests.length);
      expect(ran.apiRequests.estimate).toBeGreaterThanOrEqual(ran.apiRequests.sent);
    });
  });

  it('says what it sent when its gate never priced the run', () => {
    expect(syncApiRequestsJson(undefined, 12)).toEqual({ sent: 12 });
    expect(
      syncApiRequestsJson({ verdict: 'fits', estimate: 20, remaining: 900, max: 1_000 }, 12),
    ).toEqual({ verdict: 'fits', estimate: 20, remaining: 900, max: 1_000, sent: 12 });
  });
});
