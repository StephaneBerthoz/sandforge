/**
 * The API requests a run of `sandforge-sync` sends its target, as its
 * `--json` says them (`apiRequests`): what its gate priced the run at and
 * every request the command sent the target, counted as it sent them,
 * through the real orchestrator over a pair of fake orgs whose target takes
 * each call through its own `request`, as jsforce sends each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * A source of 150 accounts and a sandbox target with room to spare, whose
 * every call — a query, a describe, who the session is, a write of up to 200
 * records, its limits — goes through its connection's `request`, looked up
 * at each call as jsforce's methods call the connection's own, and is listed
 * in `targetRequests` as the target took it.
 */
function orgs(): { targetRequests: string[] } {
  const targetRequests: string[] = [];
  const page = (records: unknown[]) => ({ records, totalSize: records.length, done: true });
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
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true }]);
      }
      if (/COUNT\(\)/.test(soql)) {
        return { records: [], totalSize: side === 'source' ? ACCOUNTS.length : 0, done: true };
      }
      if (soql.includes('FROM Account')) return page(side === 'source' ? ACCOUNTS : []);
      return page([]);
    };
    self.queryMore = async () => {
      await send('/query/next');
      return page([]);
    };
    self.sobject = () => ({
      describe: async () => {
        await send('/sobjects/Account/describe');
        return DESCRIBED;
      },
      create: async (records: unknown[]) => {
        await send('/composite/sobjects');
        return records.map((_, i) => ({
          id: `001${String(i + 900).padStart(12, '0')}AAA`,
          success: true,
          errors: [],
        }));
      },
    });
    self.describe = async () => {
      await send('/sobjects/Account/describe');
      return DESCRIBED;
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
  return { targetRequests };
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

  it('says what it sent when its gate never priced the run', () => {
    expect(syncApiRequestsJson(undefined, 12)).toEqual({ sent: 12 });
    expect(
      syncApiRequestsJson({ verdict: 'fits', estimate: 20, remaining: 900, max: 1_000 }, 12),
    ).toEqual({ verdict: 'fits', estimate: 20, remaining: 900, max: 1_000, sent: 12 });
  });
});
