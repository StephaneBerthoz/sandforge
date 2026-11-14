import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, DescribeSObjectResult } from 'jsforce';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import { main as cloneMain } from './sandforge-clone.js';
import { SampleSourceOrg } from '../src/test/sampleSourceOrg.js';
import { SamplePlan } from '../src/modules/forge/sample/samplePlanStore.js';
import { openClonePlan, readClonePlan } from './mcpClonePlans.js';
import { CLONE_ORG_PLAN_RELAY, CLONE_ORG_RELAY } from './relayWords.js';
import { RELAYED_BY_VARIABLE, type CommandRun, type RunOptions } from './scriptRunner.js';
import { PROTOCOL_VERSION, serve, type CommandRunner } from './sandforge-mcp.js';

/*
 * The frontier of the MCP server's clone of a whole org: the server runs the
 * clone script's own `main` in this process, told who relays its lines as a
 * spawned script is, against a source that answers the reads of a sample as
 * the org does (`test/sampleSourceOrg.ts`) and a target that keeps what it
 * is sent. What is read off one answer is what the script decided on the
 * line the server built: the plan it printed is the one the server copied,
 * the run writes that copy's records and no other, a copy changed since is
 * refused by the script itself, and the `--yes` the server adds is what lets
 * a run with no terminal go.
 */

/** Thrown in place of `process.exit` so a run can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const SOURCE_ORG = '00D000000000001AAA';
const TARGET_ORG = '00D000000000002AAA';
const RUN_USER = '005000000000009AAA';

function described(field: Record<string, unknown>): Record<string, unknown> {
  return {
    label: field['name'],
    type: 'string',
    createable: true,
    updateable: true,
    nillable: true,
    referenceTo: [],
    relationshipName: null,
    cascadeDelete: false,
    groupable: true,
    sortable: true,
    aggregatable: true,
    ...field,
  };
}

function object(
  name: string,
  keyPrefix: string,
  fields: Array<Record<string, unknown>>,
  childRelationships: Array<Record<string, unknown>> = [],
): DescribeSObjectResult {
  return {
    name,
    label: name,
    keyPrefix,
    createable: true,
    recordTypeInfos: [],
    childRelationships,
    fields: [
      { name: 'Id', type: 'id', createable: false, updateable: false, nillable: false },
      { name: 'CreatedDate', type: 'datetime', createable: false, updateable: false },
      { name: 'IsDeleted', type: 'boolean', createable: false, updateable: false },
      ...fields,
    ].map(described),
  } as unknown as DescribeSObjectResult;
}

/** The objects of both orgs: a contact cannot be written without its account. */
const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }],
    [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
  ),
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    {
      name: 'AccountId',
      type: 'reference',
      referenceTo: ['Account'],
      relationshipName: 'Account',
      nillable: false,
    },
  ]),
  Ticket__c: object('Ticket__c', 'a02', [{ name: 'Name' }]),
};

const COLUMNS: Record<string, string[]> = Object.fromEntries(
  Object.values(DESCRIBES).map((d) => [d.name, d.fields.map((f) => f.name)]),
);

function globalOf() {
  return [
    ...Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    { name: 'User', keyPrefix: '005' },
  ].map((entry) => ({
    ...entry,
    queryable: true,
    createable: true,
    updateable: true,
    deletable: true,
    customSetting: false,
    layoutable: true,
  }));
}

const sourceId = (prefix: string, n: number): string =>
  `${prefix}S${String(n).padStart(11, '0')}AAA`;

/** The source: `accounts` accounts with a contact each, and 50 tickets, a minute apart. */
function sourceOf(accounts = 150): SampleSourceOrg {
  const org = new SampleSourceOrg();
  for (const [name, columns] of Object.entries(COLUMNS)) org.columns.set(name, columns);
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  for (let n = 1; n <= accounts; n++) {
    org.add('Account', {
      Id: sourceId('001', n),
      Name: `Account ${n}`,
      CreatedDate: at(n),
      IsDeleted: false,
    });
    org.add('Contact', {
      Id: sourceId('003', n),
      LastName: `Contact ${n}`,
      AccountId: sourceId('001', n),
      CreatedDate: at(n),
      IsDeleted: false,
    });
  }
  for (let n = 1; n <= 50; n++) {
    org.add('Ticket__c', {
      Id: sourceId('a02', n),
      Name: `Ticket ${n}`,
      CreatedDate: at(n),
      IsDeleted: false,
    });
  }
  return org;
}

/** What `/limits` says of a Developer Edition of 5 MB. */
const LIMITS = {
  DataStorageMB: { Max: 5, Remaining: 5 },
  DailyApiRequests: { Max: 100_000, Remaining: 90_000 },
  DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
  FileStorageMB: { Max: 1_000, Remaining: 900 },
};

const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });

function organizationOf(soql: string, id: string) {
  if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
    return page([{ Id: id, IsSandbox: true }]);
  }
  if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') return page([{}]);
  return undefined;
}

/** The source as the script reaches it, its statements answered by `org` as the org answers them. */
function sourceConn(org: SampleSourceOrg) {
  const answer = async (soql: string, all: boolean) => {
    const organization = organizationOf(soql, SOURCE_ORG);
    if (organization) return organization;
    try {
      return all ? await org.queryAll(soql) : await org.query(soql);
    } catch (err: unknown) {
      if ((err as { errorCode?: string }).errorCode === 'INVALID_TYPE') return page([]);
      throw err;
    }
  };
  return {
    version: '62.0',
    describe: async (name: string) => DESCRIBES[name],
    sobject: (name: string) => ({ describe: async () => DESCRIBES[name] }),
    describeGlobal: async () => ({ sobjects: globalOf() }),
    identity: async () => ({ user_id: RUN_USER }),
    query: (soql: string, options?: { scanAll?: boolean }) =>
      answer(soql, options?.scanAll === true),
    queryMore: (url: string) => org.queryMore(url),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: string | { url: string }) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url === '/limits') return LIMITS;
      if (url.endsWith('/limits/recordCount')) {
        return { sObjects: [...org.rows].map(([name, rows]) => ({ name, count: rows.length })) };
      }
      return {};
    },
  } as unknown as Connection;
}

/**
 * The target: it creates what it is sent and keeps it, each record as sent
 * with the id it gave, created by the run's user before the run ended. It
 * reads back a statement by ids — `WHERE Id IN (…)` — as the org does, counts
 * by `COUNT()` the records of an object, and answers any other read empty. A
 * Ctrl-C comes during the first create of `interruptOn`, as a person's.
 */
function targetConn(options: { interruptOn?: string; firstId?: number } = {}) {
  const creates: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
  const held = new Map<string, Array<Record<string, unknown>>>();
  let made = options.firstId ?? 0;
  let interrupted = false;
  const idOf = (name: string): string =>
    `${DESCRIBES[name]?.keyPrefix ?? 'a09'}T${String(made++).padStart(11, '0')}AAA`;
  const read = (soql: string) => {
    const organization = organizationOf(soql, TARGET_ORG);
    if (organization) return organization;
    const from = /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
    const rows = held.get(from) ?? [];
    if (/^SELECT COUNT\(\) /.test(soql)) return { totalSize: rows.length, done: true, records: [] };
    const ids = /\bId IN \(([^)]*)\)/.exec(soql)?.[1];
    if (ids === undefined) return page([]);
    const asked = new Set(ids.split(',').map((id) => id.trim().replace(/'/g, '')));
    return page(rows.filter((row) => asked.has(String(row['Id']))));
  };
  const conn = {
    version: '62.0',
    describe: async (name: string) => DESCRIBES[name],
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: Array<Record<string, unknown>>) => {
        creates.push({ name, rows: records });
        if (name === options.interruptOn && !interrupted) {
          interrupted = true;
          process.emit('SIGINT', 'SIGINT');
        }
        return records.map((record) => {
          const id = idOf(name);
          const list = held.get(name) ?? [];
          list.push({
            ...record,
            Id: id,
            IsDeleted: false,
            CreatedById: RUN_USER,
            LastModifiedById: RUN_USER,
            CreatedDate: '2026-01-01T00:00:00.000Z',
            LastModifiedDate: '2026-01-01T00:00:00.000Z',
            SystemModstamp: '2026-01-01T00:00:00.000Z',
          });
          held.set(name, list);
          return { id, success: true, errors: [] };
        });
      },
      update: async (records: Array<Record<string, unknown>>) =>
        records.map((record) => ({ id: record['Id'], success: true, errors: [] })),
    }),
    describeGlobal: async () => ({ sobjects: globalOf() }),
    identity: async () => ({ user_id: RUN_USER }),
    query: async (soql: string) => read(soql),
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
      describeGlobal: async () => ({ sobjects: [{ name: 'ApexClass' }] }),
    },
    request: async (request: string | { url: string }) =>
      (typeof request === 'string' ? request : request.url) === '/limits' ? LIMITS : {},
  };
  return { conn: conn as unknown as Connection, creates };
}

/** Both fake orgs answering for SRC and TGT, the source holding `accounts` accounts. */
function withFakeOrgs(target: Parameters<typeof targetConn>[0] = {}, accounts = 150) {
  const made = targetConn(target);
  const conns = { SRC: sourceConn(sourceOf(accounts)), TGT: made.conn };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
  return { target: made };
}

/** The records the target was sent, counted per object. */
function sentCounts(creates: ReturnType<typeof targetConn>['creates']): Record<string, number> {
  const sent: Record<string, number> = {};
  for (const { name, rows } of creates) sent[name] = (sent[name] ?? 0) + rows.length;
  return sent;
}

/** The accounts of a plan or of what the target was sent, by name: kept as they are. */
async function accountsOfThePlan(dir: string): Promise<string[]> {
  const plan = await SamplePlan.open(dir);
  const names: string[] = [];
  for await (const ids of plan.ids('Account')) {
    for (const id of ids) names.push(`Account ${Number(id.slice(4, 15))}`);
  }
  return names.sort();
}

/** The records of each object a plan holds. */
async function countsOfThePlan(dir: string): Promise<Record<string, number>> {
  const plan = await SamplePlan.open(dir);
  const counts: Record<string, number> = {};
  for (const { objectApiName } of plan.manifest.objects) {
    for await (const ids of plan.ids(objectApiName)) {
      counts[objectApiName] = (counts[objectApiName] ?? 0) + ids.length;
    }
  }
  return counts;
}

interface Ran {
  args: string[];
  relayedBy?: string;
}

/**
 * The clone script's own `main`, run in this process as a spawned script is
 * run: told the command that relays its lines (`RunOptions.relayedBy`, set in
 * the environment while it runs, as the spawned one finds it), what it says
 * on stderr heard as it says it (`onStderr`), stopped as Ctrl-C stops it
 * when its call is, its exit code read off `process.exit`.
 */
function inProcess() {
  const ran: Ran[] = [];
  const runCommand: CommandRunner = async (script, args, signal, options: RunOptions = {}) => {
    if (script !== 'sandforge-clone') throw new Error(`no ${script} here`);
    ran.push({
      args: [...args],
      ...(options.relayedBy !== undefined ? { relayedBy: options.relayedBy } : {}),
    });
    const out: string[] = [];
    const err: string[] = [];
    const said = (text: string) => {
      err.push(text);
      options.onStderr?.(text);
    };
    const relayedBefore = process.env[RELAYED_BY_VARIABLE];
    if (options.relayedBy !== undefined) process.env[RELAYED_BY_VARIABLE] = options.relayedBy;
    const spies = [
      vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
        throw new ExitCalled(typeof code === 'number' ? code : undefined);
      }),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        out.push(String(chunk));
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        said(String(chunk));
        return true;
      }),
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        out.push(`${String(line)}\n`);
      }),
      vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        said(`${String(line)}\n`);
      }),
    ];
    const ctrlC = () => process.emit('SIGINT', 'SIGINT');
    signal.addEventListener('abort', ctrlC, { once: true });
    process.exitCode = undefined;
    let code: number;
    try {
      await cloneMain(['node', 'sandforge-clone.ts', ...args]);
      code = Number(process.exitCode ?? 0);
    } catch (thrown: unknown) {
      if (!(thrown instanceof ExitCalled)) throw thrown;
      code = thrown.code ?? 0;
    } finally {
      signal.removeEventListener('abort', ctrlC);
      for (const spy of spies) spy.mockRestore();
      process.exitCode = undefined;
      if (relayedBefore === undefined) delete process.env[RELAYED_BY_VARIABLE];
      else process.env[RELAYED_BY_VARIABLE] = relayedBefore;
    }
    const run: CommandRun = { code, stdout: out.join(''), stderr: err.join('') };
    return run;
  };
  return { ran, runCommand };
}

interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown> & {
    exitCode?: number;
    answer?: Record<string, unknown>;
    refusal?: { code: string };
    plan?: { id: string; records: number };
    verification?: { exitCode: number; status?: string };
  };
  isError: boolean;
}

let journalDir: string;
const journalsBefore = process.env['SANDFORGE_JOURNAL_DIR'];

beforeEach(() => {
  vi.clearAllMocks();
  journalDir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-clone-org-host-'));
  process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('sf org display reached');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (journalsBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalsBefore;
  rmSync(journalDir, { recursive: true, force: true });
});

/** A server whose clone script is run in this process, and a client of it. */
function harness() {
  const script = inProcess();
  const input = new PassThrough();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  const serving = serve({
    input,
    send: (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    },
    runCommand: script.runCommand,
    log: () => undefined,
    journalDir,
    holdMs: 50_000,
  });
  let next = 1;
  const call = (name: string, args: Record<string, unknown>): Promise<CallResult> =>
    new Promise((resolve) => {
      const at = next++;
      waiting.set(at, (message) => resolve(message.result as CallResult));
      input.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: at,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        })}\n`,
      );
    });
  return {
    ...script,
    call,
    close: async () => {
      input.end();
      await serving.done;
    },
  };
}

/** The plan of a sample of SRC for TGT, as clone_org_plan keeps it from the script's own dry run. */
async function samplePlanned(h: ReturnType<typeof harness>) {
  withFakeOrgs();
  const planned = await h.call('clone_org_plan', {
    source: 'SRC',
    target: 'TGT',
    fit: 'share',
    maxTotal: 60,
  });
  expect(planned.structuredContent.exitCode, planned.content[0]?.text).toBe(0);
  const id = String(planned.structuredContent.plan?.id);
  const receipt = await readClonePlan(journalDir, id);
  if (!receipt?.sample) throw new Error(`no sample kept: ${planned.content[0]?.text}`);
  const dry = planned.structuredContent.answer as {
    wholeOrg: { sample: { plan: { path: string; sha256: string } } };
  };
  return { id, receipt, sample: receipt.sample, dry, planned };
}

describe('clone_org over the clone script itself', () => {
  it('keeps the plan the dry run printed, and writes its copy’s records and no other, the dry run’s own folder gone', async () => {
    const h = harness();
    const { id, sample, dry, planned } = await samplePlanned(h);

    expect(h.ran[0]?.relayedBy).toBe(CLONE_ORG_PLAN_RELAY);
    expect(sample.sha256).toBe(dry.wholeOrg.sample.plan.sha256);
    expect(planned.structuredContent.plan?.records).toBeGreaterThan(0);
    const accounts = await accountsOfThePlan(sample.dir);
    const counts = await countsOfThePlan(sample.dir);
    // Drawn again or swept since, the dry run's folder is not what is written;
    // and a source that grew since would draw other roots: the plan shown is
    // what is written, not a draw of the source as it is now.
    rmSync(dry.wholeOrg.sample.plan.path, { recursive: true });

    const orgs = withFakeOrgs({}, 300);
    const result = await h.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(result.structuredContent.exitCode, result.content[0]?.text).toBe(0);
    expect(h.ran[1]?.relayedBy).toBe(CLONE_ORG_RELAY);
    expect(sentCounts(orgs.target.creates)).toEqual(counts);
    const sentAccounts = orgs.target.creates
      .filter((create) => create.name === 'Account')
      .flatMap((create) => create.rows.map((row) => String(row['Name'])))
      .sort();
    expect(sentAccounts).toEqual(accounts);
    expect(result.content[0]?.text).toContain('--yes: written without the question');
    // Verified by the script's own --verify of the journal the run kept,
    // reading back from the target what it created.
    const journal = String(result.structuredContent.answer?.journal);
    expect(h.ran[2]?.args.slice(0, 2)).toEqual(['--verify', journal]);
    expect(result.structuredContent.verification).toMatchObject({
      exitCode: 0,
      status: 'VERIFIED',
      expected: 60,
      present: 60,
    });
    expect(result.content[0]?.text).toContain(
      'Verification: VERIFIED — 60 of the 60 records the run created read back from TGT',
    );
    expect(await openClonePlan(journalDir, id)).toMatchObject({ state: 'written', journal });
    await h.close();
  });

  it('is refused SAMPLE_PLAN_MISMATCH by the script, nothing written, when the copy changed since, and the plan is dead after', async () => {
    const h = harness();
    const { id, sample } = await samplePlanned(h);
    const file = readdirSync(sample.dir).find((name) => name.endsWith('.ids'));
    const ids = join(sample.dir, String(file));
    const first = readFileSync(ids, 'utf8').split('\n')[0] ?? '';
    writeFileSync(ids, readFileSync(ids, 'utf8').replace(first, `${first.slice(0, -4)}9AAA`));

    const orgs = withFakeOrgs();
    const result = await h.call('clone_org', { plan: id, confirm: 'TGT' });

    expect(result.structuredContent.exitCode).toBe(2);
    expect((result.structuredContent.answer?.refused as { code?: string }).code).toBe(
      'SAMPLE_PLAN_MISMATCH',
    );
    expect(orgs.target.creates).toEqual([]);
    expect(result.content[0]?.text).toContain('The plan no longer holds (SAMPLE_PLAN_MISMATCH)');
    const again = await h.call('clone_org', { plan: id, confirm: 'TGT' });
    expect(again.structuredContent.refusal?.code).toBe('PLAN_GONE');
    await h.close();
  });

  it('is refused by the script without the --yes the server adds, with no terminal to ask on: nothing written', async () => {
    const h = harness();
    const { receipt, sample } = await samplePlanned(h);

    const orgs = withFakeOrgs();
    const without = await h.runCommand(
      'sandforge-clone',
      [...receipt.args, '--fit-plan', sample.dir, '--json'],
      new AbortController().signal,
      { relayedBy: CLONE_ORG_RELAY },
    );

    expect(without.code).toBe(1);
    expect((JSON.parse(without.stdout) as { refused: { code: string } }).refused.code).toBe(
      'CONFIRMATION_UNAVAILABLE',
    );
    expect(orgs.target.creates).toEqual([]);
    await h.close();
  });

  it('takes a run stopped part way up by resume, the line the server builds, every record of the plan written once', async () => {
    const h = harness();
    const { id, sample } = await samplePlanned(h);
    const counts = await countsOfThePlan(sample.dir);

    const stopping = withFakeOrgs({ interruptOn: 'Contact' });
    const stopped = await h.call('clone_org', { plan: id, confirm: 'TGT' });
    expect(stopped.structuredContent.exitCode).toBe(130);
    expect(stopped.content[0]?.text).toContain(
      `clone_org with plan "${id}", resume: true and confirm "TGT" takes it up`,
    );

    const taking = withFakeOrgs({ firstId: 500 });
    const taken = await h.call('clone_org', { plan: id, confirm: 'TGT', resume: true });

    expect(taken.structuredContent.exitCode, taken.content[0]?.text).toBe(0);
    const resumed = h.ran.find((each) => each.args.includes('--resume'));
    expect(resumed?.args).toContain(String(stopped.structuredContent.answer?.journal));
    expect(sentCounts([...stopping.target.creates, ...taking.target.creates])).toEqual(counts);
    await h.close();
  });
});
