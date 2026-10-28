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
 * The article version of a Knowledge base turned on afresh, as its describe
 * gives it: no field for a body but `Summary`, plain text of 1 000 characters.
 */
const ARTICLE_VERSION_DESCRIBED = {
  name: 'Knowledge__kav',
  createable: true,
  fields: [
    field('Title'),
    field('UrlName'),
    field('Summary', { type: 'textarea', length: 1000, extraTypeInfo: 'plaintextarea' }),
    field('Language', { type: 'picklist', length: 40 }),
    ...['IsVisibleInPkb', 'IsVisibleInCsp', 'IsVisibleInPrm'].map((name) =>
      field(name, { type: 'boolean' }),
    ),
  ],
};

/** A text's words, whatever their case and the spaces between them: how a body states a fact. */
const words = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** The address a version is published at, under the API's version. */
const PUBLICATION = /\/knowledgeManagement\/articleVersions\/masterVersions\/(\w+)$/;

/**
 * An org in memory that takes every record it is sent, with a new org's case
 * statuses but its closed one renamed, the agents `planners` names in its
 * Agentforce catalog, and no Knowledge — or, with `knowledge`, a Knowledge
 * base turned on afresh, which publishes the versions it is asked to and
 * links a case to an article by the article's id.
 */
function fakeOrg(planners: Array<Record<string, unknown>> = [], knowledge = false) {
  const written: Record<string, Array<Record<string, unknown>>> = {};
  /** Each publication asked: the version, and the status asked for. */
  const publications: Array<{ versionId: string; status: unknown }> = [];
  /** The article of each version the org took, by the version's id. */
  const articleOf = new Map<string, string>();
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const described: Record<string, (typeof DESCRIBED)[string]> = knowledge
    ? { ...DESCRIBED, Knowledge__kav: ARTICLE_VERSION_DESCRIBED }
    : DESCRIBED;
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
      describe: async () => described[name] ?? { name, createable: false, fields: [] },
      create: async (sent: Array<Record<string, unknown>>) =>
        sent.map((record) => {
          const id = `a0X${String(made++).padStart(12, '0')}AAA`;
          (written[name] ??= []).push({ ...record, Id: id });
          if (name === 'Knowledge__kav') articleOf.set(id, `kA0${id.slice(3)}`);
          return { success: true, id };
        }),
    }),
    describe: async (name: string) => described[name],
    describeGlobal: async () => ({
      sobjects: Object.values(described).map(({ name, createable }) => ({ name, createable })),
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
      if (knowledge && soql.startsWith('SELECT Id, KnowledgeArticleId FROM Knowledge__kav')) {
        const ids = [...soql.matchAll(/'(\w+)'/g)].map(([, id]) => id);
        return page(
          ids.flatMap((id) => {
            const version = [...articleOf.keys()].find((v) => v.slice(0, 15) === id.slice(0, 15));
            return version ? [{ Id: version, KnowledgeArticleId: articleOf.get(version) }] : [];
          }),
        );
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
    request: async (request: string | { method: string; url: string; body?: string }) => {
      if (typeof request === 'string' || request.method !== 'PATCH') return {};
      const publication = PUBLICATION.exec(request.url);
      if (!publication) return {};
      if (!knowledge) throw new Error('NOT_FOUND: The requested resource does not exist');
      const body = JSON.parse(request.body ?? '{}') as { publishStatus?: unknown };
      publications.push({ versionId: publication[1], status: body.publishStatus });
      return undefined;
    },
  };
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  return { written, publications, articleOf };
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
    // Without Knowledge no article is written, and none is published: said, no call made.
    expect(org.publications).toEqual([]);
    expect(summary.result).toMatchObject({
      knowledge: {
        skipped: expect.stringContaining('Salesforce Knowledge is not turned on in it'),
      },
    });
  });

  describe('in an org with Knowledge', () => {
    it('publishes every article it wrote, links each closed case to its article by the article, and writes each body in Summary with every fact', async () => {
      const org = fakeOrg([], true);

      await main(seedArgv('--json'));

      const summary = JSON.parse(stdout.join('')) as {
        runFile: string;
        result: { status: string; knowledge: unknown };
        scenario: { options: Record<string, unknown> };
      };
      expect(summary.result.status).toBe('success');
      expect(summary.result.knowledge).toEqual({
        publish: { asked: 6, done: 6, notDone: [] },
        links: { asked: 20, done: 20, notDone: [] },
      });
      const versions = org.written.Knowledge__kav.map((row) => String(row.Id));
      expect(org.publications).toEqual(
        versions.map((versionId) => ({ versionId, status: 'Online' })),
      );
      // Each link names a closed case the run wrote and the article of a
      // version it wrote, never the version itself.
      const closed = new Set(
        org.written.Case.filter((row) => row.Status === 'Solved').map((row) => row.Id),
      );
      const articles = new Set(versions.map((id) => org.articleOf.get(id)));
      expect(org.written.CaseArticle).toHaveLength(20);
      for (const link of org.written.CaseArticle) {
        expect(closed.has(link.CaseId)).toBe(true);
        expect(articles.has(String(link.KnowledgeArticleId))).toBe(true);
      }
      // Each publication and each call of links is kept in the run's file as
      // a write of the run, after the insert: its removal does not read what
      // they dated as a change since the run.
      const lines = readFileSync(summary.runFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { object?: string; created?: string[] });
      // A publication is kept alone, version by version; a link, by its
      // case again once the articles were written.
      for (const id of versions) {
        expect(
          lines.some((line) => line.object === 'Knowledge__kav' && line.created?.join() === id),
        ).toBe(true);
      }
      const articlesAt = lines.findIndex((line) => line.object === 'Knowledge__kav');
      for (const link of org.written.CaseArticle) {
        const lastAt = lines.reduce(
          (last, line, at) =>
            line.object === 'Case' && line.created?.includes(String(link.CaseId)) ? at : last,
          -1,
        );
        expect(lastAt).toBeGreaterThan(articlesAt);
      }
      // Compiled for the one field a fresh Knowledge base gives a body.
      expect(summary.scenario.options).toMatchObject({
        articleBodyField: 'Summary',
        articleBodyLength: 1000,
      });
      RETAIL_ORDERS_PACK.topics.forEach((topic, at) => {
        const body = String(org.written.Knowledge__kav[at].Summary);
        expect(body.length).toBeLessThanOrEqual(1000);
        expect(body).not.toBe(topic.article.summary);
        for (const fact of topic.article.facts) expect(words(body)).toContain(words(fact));
      });
    });

    it('says in its summary how many it published and linked', async () => {
      fakeOrg([], true);

      await main(seedArgv());

      const out = stdout.join('');
      expect(out).toContain(
        '  articles: published once written, each closed case linked to the article of its ' +
          'topic, their body in Summary (1000 characters, every fact kept)',
      );
      expect(out).toContain('articles published: 6 of 6\n');
      expect(out).toContain('closed cases linked to their article: 20 of 20\n');
    });

    it('publishes nothing and links nothing on a dry run', async () => {
      const org = fakeOrg([], true);

      await main(seedArgv('--dry-run'));

      expect(stdout.join('')).toContain('  articles: published once written');
      expect(org.publications).toEqual([]);
      expect(org.written).toEqual({});
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
