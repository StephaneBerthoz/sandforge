import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPanelHost, orgFromIdentity } from './panelHost.js';
import type { PanelHost, PanelHostOptions, PanelHostWiring } from './panelHost.js';
import { main as checkpointMain } from './sandforge-checkpoint.js';
import { main as envMain } from './sandforge-env.js';
import { serve, type CommandRunner } from './sandforge-mcp.js';
import { loadOrg } from './sfSession.js';
import { EnvWorld, runInProcess } from './testing/envWorld.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { type MemoryOrgRequest } from '../src/test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../src/test/memoryRestoreOrg.js';

vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// What the memory world of an environment points at itself (`testing/envWorld.ts`):
// each keeps its own implementation until a world is made, as the checkpoint
// script's rewind reaches the org through the real `removalOrg`.
vi.mock('./sfSession.js', async (original) => {
  const real = await original<typeof import('./sfSession.js')>();
  return { ...real, loadOrg: vi.fn(real.loadOrg), makeConn: vi.fn(real.makeConn) };
});
vi.mock('./sandforge-clone.js', async (original) => {
  const real = await original<typeof import('./sandforge-clone.js')>();
  return { ...real, targetAutomationReader: vi.fn(real.targetAutomationReader) };
});
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => {
  const real = await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>();
  return { ...real, removalOrg: vi.fn(real.removalOrg) };
});

/*
 * The MCP server, its checkpoint tools answered by the checkpoint script
 * itself — its `main`, run whole through the extension's own host
 * (`panelHost.ts`) on the memory org its own tests run on — and its
 * environment tools by the env script's own `main`, which runs the seed's on
 * the memory world of an environment. Only what reaches past this machine is
 * stood in for: the `sf` CLI's session and the identity query of a
 * connection, and the org. What the server adds and what the script decides
 * are read off one answer.
 */

const ORG_ID = '00D000000000001AAA';
const COLLEAGUE = '005000000000003AAA';
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const STAMP_FIELDS = [
  { name: 'Id', label: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false },
  {
    name: 'CreatedById',
    label: 'Created By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  {
    name: 'LastModifiedDate',
    label: 'Last Modified Date',
    type: 'datetime',
    permissionable: false,
  },
  {
    name: 'LastModifiedById',
    label: 'Last Modified By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
];
const writable = (name: string) => ({
  name,
  label: name,
  type: 'string',
  createable: true,
  updateable: true,
  nillable: true,
});
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Case: [...STAMP_FIELDS, writable('Subject')],
};

/** The memory org as the checkpoint handler reaches it: a global describe, `/limits`, its record and its user. */
class McpTestOrg extends MemoryRestoreOrg {
  /** Whether each read of its clock moves it a second, as time passes during a rewind. */
  ticking = false;

  constructor() {
    super({}, { now: () => clock });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(FIELDS)) this.changeSchema(name, fields);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: false,
      OrganizationType: 'Developer Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('Account', { Id: id('001', 1), Name: 'Northwind' });
    this.add('Account', { Id: id('001', 2), Name: 'Contoso' });
    this.add('Case', { Id: id('500', 1), Subject: 'Broken' });
    clock = T0;
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: Object.keys(FIELDS).map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
      })),
    };
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: { Max: 15_000, Remaining: 14_900 } };
    }
    return super.request(request);
  }

  override async serverTime(): Promise<string> {
    if (this.ticking) clock += 1_000;
    return super.serverTime();
  }
}

/** The org behind a connection shaped as jsforce's; its Tooling API answers nothing. */
function connectionOf(org: McpTestOrg) {
  return {
    get version() {
      return org.version;
    },
    request: (request: MemoryOrgRequest) => org.request(request),
    query: (soql: string, options?: { scanAll?: boolean }) => org.query(soql, options),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
    describeGlobal: () => org.describeGlobal(),
    tooling: { describeGlobal: () => Promise.resolve({ sobjects: [] }) },
    sobject: (objectApiName: string) => ({
      update: (records: Array<Record<string, unknown>>) => org.update(objectApiName, records),
      destroy: (ids: string[]) => org.destroy(objectApiName, ids),
    }),
    soap: {
      getServerTimestamp: async () => ({ timestamp: await org.serverTime() }),
      getUserInfo: async () => ({ userId: await org.userId() }),
      undelete: (ids: string[]) => org.undelete(ids),
    },
  };
}

const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
  process.exitCode = undefined;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** A tool call's result, as these tests read it. */
interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: { exitCode?: number; answer?: Record<string, unknown>; refusal?: unknown };
  isError: boolean;
}

/**
 * A server whose checkpoint script is run in this process on the memory org,
 * and a client of it: what the script ran with, and the aliases it reached.
 */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-host-'));
  dirs.push(dir);
  const storeDir = join(dir, 'store');
  const locksDir = join(dir, 'locks');
  const org = new McpTestOrg();
  const connected: string[] = [];
  const lines: string[][] = [];
  vi.mocked(getJsforceConnection).mockImplementation(async () => connectionOf(org) as never);

  const createHost = (hostOptions: PanelHostOptions): PanelHost => {
    let wiring: PanelHostWiring | undefined;
    const host = createPanelHost({
      ...hostOptions,
      compose: (built) => {
        hostOptions.compose?.(built);
        wiring = built;
      },
    });
    return {
      get posted() {
        return host.posted;
      },
      request: (request) => host.request(request),
      connect: async (alias) => {
        connected.push(alias);
        const session = {
          alias,
          username: 'tester@example.com',
          instanceUrl: 'https://example.my.salesforce.com',
          accessToken: 'not-a-token',
        };
        const registered = orgFromIdentity(session, {
          userId: '005000000000001AAA',
          username: session.username,
          displayName: 'Tester',
          orgId: ORG_ID,
          orgName: 'Example',
          orgType: 'Developer Edition',
          isSandbox: false,
        });
        if (!wiring) throw new Error('The host built no handlers.');
        await wiring.orgRegistry.saveOrg(registered, {
          loginUrl: session.instanceUrl,
          instanceUrl: session.instanceUrl,
          accessToken: session.accessToken,
          username: session.username,
        });
        return registered;
      },
    };
  };

  // The checkpoint script's own main, its output read as a process's would be.
  const runCommand: CommandRunner = async (script, args) => {
    if (script !== 'sandforge-checkpoint') throw new Error(`no ${script} here`);
    lines.push([...args]);
    let stdout = '';
    let stderr = '';
    let exited: number | undefined;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code;
      throw new Error(`exit ${code}`);
    }) as never);
    process.exitCode = undefined;
    try {
      await checkpointMain(['node', 'sandforge-checkpoint.ts', ...args, '--store', storeDir], {
        createHost,
        locksDir,
      });
    } catch (thrown: unknown) {
      if (exited === undefined) throw thrown;
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
    const code = exited ?? Number(process.exitCode ?? 0);
    process.exitCode = undefined;
    return { code, stdout, stderr };
  };

  const input = new PassThrough();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  const serving = serve({
    input,
    send: (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    },
    runCommand,
    log: () => undefined,
  });
  let next = 1;
  const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const at = next++;
      waiting.set(at, resolve);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: at, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> =>
    (await request('tools/call', { name, arguments: args })).result as CallResult;

  return {
    org,
    connected,
    lines,
    request,
    call,
    close: async () => {
      input.end();
      await serving.done;
    },
  };
}

/** The text of a call's result. */
const textOf = (result: CallResult): string => result.content[0]?.text ?? '';

/** The 60-second demo: one record created, two changed and one deleted, by a colleague. */
function demo(org: McpTestOrg): void {
  clock = T0 + 60_000;
  org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
  org.edit('Account', id('001', 2), { Name: 'Renamed too' }, COLLEAGUE);
  org.add('Case', { Id: id('500', 2), Subject: 'New', LastModifiedById: COLLEAGUE });
  org.trash('Case', id('500', 1), COLLEAGUE);
  clock = T0 + 120_000;
  org.ticking = true;
}

describe('sandforge-mcp: the checkpoint tools on the memory org', () => {
  it('lists its tools, refuses a rewind without confirm before the org is reached, and previews one through the checkpoint script', async () => {
    const h = harness();
    await h.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const listed = await h.request('tools/list', {});
    const taken = await h.call('checkpoint_take', { org: 'DEV-SB', name: 'Before UAT' });
    demo(h.org);
    const reached = h.connected.length;

    const refused = await h.call('checkpoint_rewind', { org: 'DEV-SB', checkpoint: 'Before UAT' });
    const preview = await h.call('checkpoint_preview', { org: 'DEV-SB', checkpoint: 'Before UAT' });

    expect((listed.result as { tools: unknown[] }).tools).toHaveLength(13);
    expect(taken).toMatchObject({ isError: false, structuredContent: { exitCode: 0 } });
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: { refusal: { code: 'CONFIRM' } },
    });
    // The refusal ran no script: the next one to reach the org was the preview.
    expect(h.lines.map((line) => line[0])).toEqual(['take', 'preview']);
    expect(h.connected.length).toBe(reached + 1);
    expect(h.org.updates).toEqual([]);
    expect(preview).toMatchObject({
      isError: false,
      structuredContent: {
        exitCode: 0,
        answer: {
          checkpoint: { name: 'Before UAT', org: 'DEV-SB' },
          toDelete: 1,
          toGiveBack: 2,
          toBringBack: 1,
          differs: true,
        },
      },
    });
    expect(textOf(preview)).toContain('  1 to delete · 2 to give back · 1 to bring back');
    expect(textOf(preview)).toContain('  last changed by: ');
    await h.close();
  });

  it('keeps the script’s acceptance: a rewind whose automation cannot be read is refused without acceptAutomation, named as the person’s to give', async () => {
    const h = harness();
    await h.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await h.call('checkpoint_take', { org: 'DEV-SB', name: 'Before UAT' });
    demo(h.org);

    const result = await h.call('checkpoint_rewind', {
      org: 'DEV-SB',
      checkpoint: 'Before UAT',
      confirm: 'DEV-SB',
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { exitCode: 1, answer: { refusal: { code: 'AUTOMATION' } } },
    });
    expect(textOf(result)).toContain(
      "--accept-automation, named above, is this tool's acceptAutomation: true.",
    );
    expect(h.org.updates).toEqual([]);
    await h.close();
  });

  it('rewinds with confirm: the answer says who last changed the records and what Undo could not bring back, and the undo takes it back', async () => {
    const h = harness();
    await h.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await h.call('checkpoint_take', { org: 'DEV-SB', name: 'Before UAT' });
    demo(h.org);

    const rewound = await h.call('checkpoint_rewind', {
      org: 'DEV-SB',
      checkpoint: 'Before UAT',
      confirm: 'DEV-SB',
      acceptAutomation: true,
    });
    const undone = await h.call('checkpoint_undo', {
      org: 'DEV-SB',
      checkpoint: 'Before UAT',
      confirm: 'DEV-SB',
      acceptAutomation: true,
    });

    expect(rewound, textOf(rewound)).toMatchObject({
      isError: false,
      structuredContent: {
        exitCode: 0,
        answer: {
          status: 'success',
          deleted: { done: 1 },
          givenBack: { done: 3 },
          broughtBack: { done: 1 },
          undo: { cannot: [] },
        },
      },
    });
    expect(textOf(rewound)).toContain('  last changed by: ');
    expect(textOf(rewound)).toContain(
      "DEV-SB is back at 'Before UAT': read again, nothing differs among the objects and fields it holds.",
    );
    expect(h.lines[1]).toEqual([
      'rewind',
      '--org',
      'DEV-SB',
      '--checkpoint',
      'Before UAT',
      '--yes',
      '--accept-automation',
      '--json',
    ]);
    expect(undone, textOf(undone)).toMatchObject({
      isError: false,
      structuredContent: { exitCode: 0, answer: { status: 'success' } },
    });
    expect(
      h.org
        .all('Account')
        .map((row) => row.Name)
        .sort(),
    ).toEqual(['Renamed', 'Renamed too']);
    await h.close();
  });
});

describe('sandforge-mcp: the environment tools on the memory org', () => {
  const ENV_ORG_ID = '00D000000000009EAA';
  const ENV_T0 = Date.parse('2026-10-25T09:00:00.000Z');
  let journalBefore: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ENV_T0);
    journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  });

  afterEach(() => {
    if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
    else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
    vi.useRealTimers();
    // Back to their own implementations, which the checkpoint tools run on.
    vi.mocked(loadOrg).mockReset();
  });

  /**
   * A server whose env script is run in this process, its seeds on a
   * Developer Edition in memory, and a client of it: what the env script ran
   * with, and the org's records.
   */
  function envHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-mcp-env-'));
    dirs.push(dir);
    const project = join(dir, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const file = join(project, 'sandforge.yaml');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        name: 'case-flow',
        resources: {
          accounts: {
            kind: 'seed',
            seed: 1,
            objects: [
              {
                object: 'Account',
                count: 2,
                fields: [
                  {
                    fieldApiName: 'Name',
                    ruleType: 'static',
                    config: { staticValue: 'SFENV account' },
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const journalDir = join(dir, 'journal');
    process.env['SANDFORGE_JOURNAL_DIR'] = journalDir;
    const world = new EnvWorld({
      organizationId: ENV_ORG_ID,
      sandbox: false,
      edition: 'Developer Edition',
      tick: () => vi.setSystemTime(Date.now() + 30_000),
    });
    const lines: string[][] = [];

    // The env script's own main, its output read as a process's would be.
    const runCommand: CommandRunner = async (script, args) => {
      if (script !== 'sandforge-env') throw new Error(`no ${script} here`);
      lines.push([...args]);
      return runInProcess(() =>
        envMain(['node', 'sandforge-env.ts', ...args], {
          runner: world.runner,
          journalDir,
          locksDir: join(dir, 'locks'),
          onStop: () => () => undefined,
          cwd: project,
        }),
      );
    };

    const input = new PassThrough();
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    const serving = serve({
      input,
      send: (line) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === 'number') waiting.get(message.id)?.(message);
      },
      runCommand,
      log: () => undefined,
    });
    let next = 1;
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const at = next++;
        waiting.set(at, resolve);
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: at, method, params })}\n`);
      });
    const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> =>
      (await request('tools/call', { name, arguments: args })).result as CallResult;

    return {
      file,
      world,
      lines,
      request,
      call,
      close: async () => {
        input.end();
        await serving.done;
      },
    };
  }

  it('plans, refuses an apply without confirm before the org is reached, keeps the no-state guard, applies with confirm and destroys, through the env script and its seed', async () => {
    const h = envHarness();
    await h.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });

    const planned = await h.call('env_plan', { file: h.file, org: 'DEV-ED' });
    const plannedBy = h.world.calls.map((each) => each.args.includes('--dry-run'));
    const reached = vi.mocked(loadOrg).mock.calls.length;
    const unconfirmed = await h.call('env_apply', { file: h.file, org: 'DEV-ED' });
    const reachedByTheRefusal = vi.mocked(loadOrg).mock.calls.length - reached;
    const noState = await h.call('env_apply', { file: h.file, org: 'DEV-ED', confirm: 'DEV-ED' });
    const applied = await h.call('env_apply', {
      file: h.file,
      org: 'DEV-ED',
      confirm: 'DEV-ED',
      acceptNoState: true,
    });

    expect(planned, textOf(planned)).toMatchObject({
      isError: false,
      structuredContent: {
        exitCode: 0,
        answer: {
          env: 'case-flow',
          org: { organizationId: ENV_ORG_ID, alias: 'DEV-ED' },
          actions: [{ resource: 'accounts', action: 'create' }],
        },
      },
    });
    // The plan dry-ran the seed, which wrote nothing.
    expect(plannedBy).toEqual([true]);
    expect(unconfirmed).toMatchObject({
      isError: true,
      structuredContent: { refusal: { code: 'CONFIRM' } },
    });
    expect(textOf(unconfirmed)).toContain(
      'Before it, env_plan of the same file says what it would',
    );
    // The refusal ran no script: the next line the env script ran is the confirmed apply's.
    expect(h.lines.map((line) => line[0])).toEqual(['plan', 'apply', 'apply']);
    expect(reached).toBeGreaterThan(0);
    expect(reachedByTheRefusal).toBe(0);
    expect(noState, textOf(noState)).toMatchObject({
      isError: true,
      structuredContent: { exitCode: 1 },
    });
    expect(textOf(noState)).toContain(
      "--accept-no-state, named above, is this tool's acceptNoState: true.",
    );
    expect(h.lines[1]).toEqual(['apply', '--file', h.file, '--org', 'DEV-ED', '--yes', '--json']);
    expect(applied, textOf(applied)).toMatchObject({
      isError: false,
      structuredContent: {
        exitCode: 0,
        answer: { status: 'success', steps: [{ resource: 'accounts', status: 'applied' }] },
      },
    });
    expect(textOf(applied)).toContain(
      `env_destroy with file "${h.file}" and org "DEV-ED" takes this environment back.`,
    );
    expect(h.world.records('Account').map((row) => row['Name'])).toEqual([
      'SFENV account',
      'SFENV account',
    ]);

    // One account gone since: the plan says the drift, an answer, not an error.
    const [account] = h.world.records('Account');
    h.world.org.trash('Account', String(account?.['Id']));
    const drifted = await h.call('env_plan', { file: h.file, org: 'DEV-ED', failOnDrift: true });
    const destroyed = await h.call('env_destroy', {
      file: h.file,
      org: 'DEV-ED',
      confirm: 'DEV-ED',
    });

    expect(drifted, textOf(drifted)).toMatchObject({
      isError: false,
      structuredContent: { exitCode: 3 },
    });
    expect(textOf(drifted)).toContain('exit 3: drift: the org no longer holds the environment');
    expect(destroyed, textOf(destroyed)).toMatchObject({
      isError: false,
      structuredContent: { exitCode: 0, answer: { status: 'success' } },
    });
    expect(h.world.records('Account')).toEqual([]);
    await h.close();
  });
});
