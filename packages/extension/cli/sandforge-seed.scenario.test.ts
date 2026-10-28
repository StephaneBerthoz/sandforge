/**
 * `sandforge-seed --scenario` and `--test-file` against an org in memory: the
 * pack compiled with the target's statuses, a dry run that prints the plan
 * and writes nothing, a run that keeps its cases' ids beside its file, and
 * the test file written from it — or, without an agent, said not to be.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({ objectsRead: [], objects: [], unread: [] }),
  })),
}));

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { RETAIL_ORDERS_PACK, testingCenterTestSpecSchema } from '@sandforge/shared';
import { makeConn } from './sfSession.js';
import { main } from './sandforge-seed.js';
import {
  nodeScenarioSidecarFiles,
  readScenarioRunSidecar,
} from '../src/modules/seed/scenario/scenarioRunSidecar.js';
import { journalDirOf } from './sandforge-clone.js';

/** A field as the fake org describes it. */
const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'string',
  createable: true,
  nillable: true,
  length: 255,
  referenceTo: [],
  defaultedOnCreate: false,
  picklistValues: [],
  ...extra,
});

/** The objects a scenario writes, as a new org describes them, Knowledge left out. */
const DESCRIBED: Record<string, { name: string; createable: boolean; fields: unknown[] }> = {
  Account: {
    name: 'Account',
    createable: true,
    fields: ['Name', 'Industry', 'Type', 'Phone', 'Website'].map((name) => field(name)),
  },
  Contact: {
    name: 'Contact',
    createable: true,
    fields: [
      ...['FirstName', 'LastName', 'Email', 'Phone'].map((name) => field(name)),
      field('AccountId', { type: 'reference', referenceTo: ['Account'] }),
    ],
  },
  Case: {
    name: 'Case',
    createable: true,
    fields: [
      ...['Subject', 'Status', 'Priority', 'Origin'].map((name) => field(name)),
      field('Description', { type: 'textarea', length: 32000 }),
      field('ContactId', { type: 'reference', referenceTo: ['Contact'] }),
    ],
  },
  CaseComment: {
    name: 'CaseComment',
    createable: true,
    fields: [
      field('CommentBody', { type: 'textarea', length: 4000 }),
      field('IsPublished', { type: 'boolean' }),
      field('ParentId', { type: 'reference', referenceTo: ['Case'] }),
    ],
  },
};

/**
 * An org in memory that takes every record it is sent, with a new org's case
 * statuses but its closed one renamed, no Knowledge, and the agents `planners`
 * names in its Agentforce catalog.
 */
function fakeOrg(planners: Array<Record<string, unknown>> = []) {
  const written: Record<string, Array<Record<string, unknown>>> = {};
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const toolingTables: Record<string, Array<Record<string, unknown>>> = {
    GenAiPlannerDefinition: planners,
    GenAiPlannerFunctionDef: planners.map((p) => ({
      PlannerId: p.Id,
      Plugin: '179000000000001AAA',
    })),
    GenAiPlannerAttrDefinition: [],
    GenAiPluginDefinition: [{ Id: '179000000000001AAA', DeveloperName: 'Order_Issues' }],
    GenAiPluginFunctionDef: [],
    GenAiFunctionDefinition: [],
  };
  const conn = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBED[name] ?? { name, createable: false, fields: [] },
      create: async (sent: Array<Record<string, unknown>>) => {
        (written[name] ??= []).push(...sent);
        return sent.map(() => ({ success: true, id: `a0X${String(made++).padStart(12, '0')}AAA` }));
      },
    }),
    describe: async (name: string) => DESCRIBED[name],
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBED).map(({ name, createable }) => ({ name, createable })),
    }),
    identity: async () => ({ user_id: '005000000000001AAA' }),
    query: async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true, DefaultLocaleSidKey: 'en_US' }]);
      }
      if (soql.includes('FROM CaseStatus')) {
        return page([
          { ApiName: 'New', IsClosed: false, IsDefault: true },
          { ApiName: 'Solved', IsClosed: true, IsDefault: false },
        ]);
      }
      return page([]);
    },
    tooling: {
      query: async (soql: string) => {
        const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
        return page(toolingTables[object] ?? []);
      },
      queryMore: async () => page([]),
    },
    request: async () => ({}),
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  return { written };
}

describe('sandforge-seed --scenario', () => {
  let stdout: string[];
  let stderr: string[];
  let project: string;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    project = mkdtempSync(join(tmpdir(), 'sandforge-scenario-project-'));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  const seedArgv = (...extra: string[]) => [
    'node',
    'sandforge-seed.ts',
    '--target',
    'TGT',
    '--scenario',
    'retail-orders',
    '--locale',
    'en_US',
    ...extra,
  ];

  it("prints the plan of a dry run, the cases under the org's statuses, the articles skipped with why, and writes nothing", async () => {
    const org = fakeOrg();

    await main(seedArgv('--dry-run'));

    const out = stdout.join('');
    expect(out).toContain('scenario: retail-orders (Retail orders), seed 1');
    expect(out).toContain('  Case: 30 record(s)');
    expect(out).toContain('  Knowledge__kav: 6 record(s), skipped by an org without it');
    expect(out).toContain('  cases: open "New", closed "Solved" (the org\'s)');
    expect(out).toContain('  articles: skipped, Salesforce Knowledge is not turned on in it');
    expect(out).toContain('[dry-run] Case: 30 record(s) (REST)');
    expect(org.written).toEqual({});
  });

  it("writes the pack, keeps its open cases' ids beside the run file, and says the org has no agent yet", async () => {
    const org = fakeOrg();

    await main(seedArgv('--scenario-seed', '3', '--json'));

    const summary = JSON.parse(stdout.join('')) as {
      runFile: string;
      result: { operationId: string; status: string };
      scenario: { packId: string; companion: string; openCasesWritten: number; agents?: string };
    };
    expect(summary.result.status).toBe('success');
    expect(org.written.Case).toHaveLength(30);
    expect(new Set(org.written.Case.map((c) => c.Status))).toEqual(new Set(['New', 'Solved']));
    expect(summary.scenario).toMatchObject({
      packId: 'retail-orders',
      openCasesWritten: 10,
      agents: 'none',
    });
    expect(existsSync(summary.scenario.companion)).toBe(true);
    const kept = await readScenarioRunSidecar(
      nodeScenarioSidecarFiles(),
      journalDirOf(),
      summary.result.operationId,
    );
    expect(kept.kind === 'read' && kept.sidecar.compile).toEqual({
      seed: 3,
      caseStatus: { open: 'New', closed: 'Solved' },
    });
  });

  it('refuses a scenario with a template, and a scenario that is neither shipped nor a file', async () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(main(seedArgv('--template', 'prebuilt-crm-starter'))).rejects.toThrow('exit 2');
    expect(stderr.join('')).toContain('Give --scenario alone');

    stderr.length = 0;
    await expect(
      main(['node', 'sandforge-seed.ts', '--target', 'TGT', '--scenario', 'no-such-pack']),
    ).rejects.toThrow('exit 2');
    expect(stderr.join('')).toContain('--scenario takes the id of a scenario SandForge ships');
  });

  describe('--test-file', () => {
    /** Seed the retail pack into an org with the agents given, and the run's file. */
    async function seeded(planners: Array<Record<string, unknown>>): Promise<string> {
      fakeOrg(planners);
      await main(seedArgv('--json'));
      const { runFile } = JSON.parse(stdout.join('')) as { runFile: string };
      stdout.length = 0;
      return runFile;
    }
    const AGENT = [{ Id: '16j000000000001AAA', DeveloperName: 'Retail_Service_Agent' }];
    const topics = RETAIL_ORDERS_PACK.topics.flatMap((topic) => [
      '--topic',
      `${topic.key}=Order_Issues`,
    ]);

    it('lists the agents and writes nothing without --agent', async () => {
      const runFile = await seeded(AGENT);

      await main(['node', 's', '--test-file', runFile, '--target', 'TGT', '--project', project]);

      expect(process.exitCode).toBe(2);
      expect(stdout.join('')).toContain('  Retail_Service_Agent\n    topic Order_Issues');
      expect(stderr.join('')).toContain('--test-file takes --agent');
      expect(existsSync(join(project, 'specs'))).toBe(false);
    });

    it('writes the test file of the run into the project, outside a DX project without the commands', async () => {
      const runFile = await seeded(AGENT);

      await main([
        'node',
        's',
        '--test-file',
        runFile,
        '--target',
        'TGT',
        '--agent',
        'Retail_Service_Agent',
        ...topics,
        '--project',
        project,
      ]);

      expect(process.exitCode).toBeUndefined();
      const file = join(
        project,
        'specs',
        'Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml',
      );
      const spec = testingCenterTestSpecSchema.parse(parse(readFileSync(file, 'utf8')));
      expect(spec.testCases.length).toBeGreaterThan(0);
      expect(stdout.join('')).toContain('This folder is no Salesforce DX project');
    });

    it('says the org has no agent, exit 1, and writes nothing', async () => {
      const runFile = await seeded([]);

      await main([
        'node',
        's',
        '--test-file',
        runFile,
        '--target',
        'TGT',
        '--agent',
        'Retail_Service_Agent',
        ...topics,
        '--project',
        project,
      ]);

      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toContain(
        'This org has no Agentforce agent: create one, then write the test file from this run.',
      );
      expect(existsSync(join(project, 'specs'))).toBe(false);
    });
  });
});
