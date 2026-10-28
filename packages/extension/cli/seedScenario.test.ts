import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RETAIL_ORDERS_PACK, SAAS_SUPPORT_PACK } from '@sandforge/shared';
import type { AgentDefinition, SeedScenarioPreparation } from '@sandforge/shared';
import {
  agentLines,
  parseTestFileArgs,
  scenarioKnowledgeLines,
  scenarioPackOf,
  scenarioPlanLines,
  testFileCommand,
  testFileOutcomeLines,
  testFileRunOf,
} from './seedScenario.js';

describe('scenarioPackOf — the pack the line names', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('takes a shipped pack by its id', () => {
    expect(scenarioPackOf('saas-support')).toEqual({ pack: SAAS_SUPPORT_PACK, from: 'built-in' });
  });

  it('reads a pack file, and names every field of one that does not hold', () => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-pack-'));
    const good = join(dir, 'own.sandforge-scenario.json');
    const bad = join(dir, 'bad.sandforge-scenario.json');
    writeFileSync(good, JSON.stringify({ ...RETAIL_ORDERS_PACK, id: 'own-shop' }));
    writeFileSync(bad, JSON.stringify({ ...RETAIL_ORDERS_PACK, version: 2 }));

    expect(scenarioPackOf(good)).toEqual({
      pack: { ...RETAIL_ORDERS_PACK, id: 'own-shop' },
      from: resolve(good),
    });
    expect(scenarioPackOf(bad)).toEqual({
      refusal: expect.stringMatching(/is not a scenario pack:\n {2}version: /),
    });
  });

  it('refuses a word that is neither, naming the shipped packs', () => {
    expect(scenarioPackOf('retail')).toEqual({
      refusal:
        '--scenario takes the id of a scenario SandForge ships (retail-orders, broadband-support, ' +
        'saas-support) or a scenario file, not "retail".',
    });
  });
});

describe('scenarioPlanLines', () => {
  const preparation: SeedScenarioPreparation = {
    options: {
      seed: 2,
      caseStatus: { open: 'New', closed: 'Closed' },
      articleBodyField: 'Answer__c',
      articleBodyLength: 32768,
      articleBodyHtml: true,
    },
    objects: [
      { objectApiName: 'Account', recordCount: 10 },
      { objectApiName: 'Knowledge__kav', recordCount: 6, optional: true },
    ],
    tests: 14,
    caseStatusFrom: { from: 'default', reason: 'the org would not read its case statuses: X' },
    knowledge: { available: true, bodyFields: ['Answer__c'] },
  };

  it('says what the run writes, the statuses it writes cases with and where they come from, and where the body goes', () => {
    expect(scenarioPlanLines(RETAIL_ORDERS_PACK, preparation)).toEqual([
      'scenario: retail-orders (Retail orders), seed 2  (--scenario-seed 2 writes the same again)',
      '  Account: 10 record(s)',
      '  Knowledge__kav: 6 record(s), skipped by an org without it',
      '  cases: open "New", closed "Closed" (a new org\'s: the org would not read its case statuses: X)',
      '  articles: published once written, each closed case linked to the article of its ' +
        'topic, their body in Answer__c (32768 characters, every fact kept)',
      '  tests: 14, written to a file once the run has ended (--test-file)',
    ]);
  });
});

describe('scenarioKnowledgeLines', () => {
  it('says how many articles were published and closed cases linked, and each not, with why', () => {
    expect(
      scenarioKnowledgeLines({
        publish: {
          asked: 6,
          done: 5,
          notDone: [
            {
              key: 'retail-orders-article-refund',
              reason:
                'Left a draft: INSUFFICIENT_ACCESS: You do not have the permission to publish articles.',
            },
          ],
        },
        links: { asked: 20, done: 20, notDone: [] },
      }),
    ).toEqual([
      'articles published: 5 of 6',
      '  retail-orders-article-refund: Left a draft: INSUFFICIENT_ACCESS: You do not have the ' +
        'permission to publish articles.',
      'closed cases linked to their article: 20 of 20',
    ]);
  });

  it('says why none of it was done, in the words of the step, and nothing for a run asked neither', () => {
    expect(
      scenarioKnowledgeLines({
        skipped: 'The articles were neither published nor linked: socket hang up',
      }),
    ).toEqual(['articles: The articles were neither published nor linked: socket hang up']);
    expect(scenarioKnowledgeLines(undefined)).toEqual([]);
  });
});

describe('parseTestFileArgs — the line of --test-file', () => {
  afterEach(() => vi.restoreAllMocks());

  const exitOn = () => {
    const stderr: string[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    return stderr;
  };

  it('reads the agent, each topic with its actions, the guard topic and the engine', () => {
    const args = parseTestFileArgs([
      'node',
      's',
      '--test-file',
      'run-1',
      '--target',
      'TGT',
      '--agent',
      'Retail_Service_Agent',
      '--topic',
      'damaged-parcel=Order_Issues:Identify_Customer,Answer_Questions',
      '--topic',
      'refund=Refunds',
      '--guard-topic',
      'Off_Topic',
      '--test-runner',
      'agentforce-studio',
      '--project',
      'here',
      '--overwrite',
    ]);

    expect(args).toEqual({
      run: 'run-1',
      target: 'TGT',
      agent: 'Retail_Service_Agent',
      topics: [
        {
          packTopic: 'damaged-parcel',
          agentTopic: 'Order_Issues',
          actions: ['Identify_Customer', 'Answer_Questions'],
        },
        { packTopic: 'refund', agentTopic: 'Refunds', actions: [] },
      ],
      guardTopic: 'Off_Topic',
      runner: 'agentforce-studio',
      project: resolve('here'),
      overwrite: true,
      json: false,
    });
  });

  it('refuses a topic not written as a match, and an engine it does not know', () => {
    const stderr = exitOn();
    expect(() =>
      parseTestFileArgs(['node', 's', '--test-file', 'r', '--target', 'T', '--topic', 'refund']),
    ).toThrow('exit 2');
    expect(stderr.join('')).toContain('--topic wants "<scenario topic>=<agent topic>"');
    expect(() =>
      parseTestFileArgs(['node', 's', '--test-file', 'r', '--target', 'T', '--test-runner', 'x']),
    ).toThrow('exit 2');
  });

  it('refuses a line without the org the run wrote to', () => {
    const stderr = exitOn();
    expect(() => parseTestFileArgs(['node', 's', '--test-file', 'r'])).toThrow('exit 2');
    expect(stderr.join('')).toContain('--target the org it wrote to');
  });
});

describe('testFileRunOf', () => {
  it('takes a run id as kept under the journal folder', () => {
    expect(testFileRunOf('sandforge-seed-1', '/journals')).toEqual({
      runId: 'sandforge-seed-1',
      storagePath: '/journals',
    });
  });

  it("reads a run file's id and org, its companion beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-runs-'));
    const file = join(dir, 'seed-runs', 'run-7.ndjson');
    mkdirSync(join(dir, 'seed-runs'));
    writeFileSync(
      file,
      `${JSON.stringify({
        run: {
          runId: 'run-7',
          configId: 'sandforge-seed',
          configName: 'sandforge-seed',
          sourceOrgId: 'TGT',
          targetOrgId: 'TGT',
          startedAt: '2026-10-28T00:00:00.000Z',
        },
      })}\n`,
    );
    try {
      expect(testFileRunOf(file, '/journals')).toMatchObject({
        runId: 'run-7',
        storagePath: dir,
        targetOrgId: 'TGT',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what --test-file says', () => {
  it('gives the command with a placeholder for each topic of the pack', () => {
    expect(testFileCommand('/runs/r.ndjson', 'TGT', RETAIL_ORDERS_PACK)).toBe(
      'sandforge-seed --test-file /runs/r.ndjson --target TGT --agent <agent API name> ' +
        RETAIL_ORDERS_PACK.topics.map((topic) => `--topic ${topic.key}=<agent topic>`).join(' '),
    );
  });

  it('lists each agent with its topics and their actions', () => {
    const agents: AgentDefinition[] = [
      {
        id: '16j000000000001AAA',
        name: 'Retail_Service_Agent',
        label: 'Retail',
        topics: [
          {
            name: 'Order_Issues',
            described: true,
            actions: [{ name: 'Identify_Customer', described: true }],
            unnamedActions: 0,
          },
        ],
        unnamedTopics: 0,
        variables: [],
      },
    ];
    expect(agentLines(agents)).toEqual([
      '  Retail_Service_Agent (Retail)',
      '    topic Order_Issues: Identify_Customer',
    ]);
  });

  it("says the commands are the user's to run, and what was left out", () => {
    expect(
      testFileOutcomeLines({
        kind: 'written',
        path: '/p/specs/a.yaml',
        specPath: 'specs/a.yaml',
        apiName: 'A_SandForge',
        commands: { create: 'sf agent test create …', run: 'sf agent test run …' },
        leftOut: [{ test: 'out-1', reason: 'no-guard-topic', message: 'no guard topic' }],
      }),
    ).toEqual([
      'test file: /p/specs/a.yaml',
      '  left out out-1: no guard topic',
      "SandForge never deploys the test nor runs it, which spends the org's credits: from the project, run",
      '  sf agent test create …',
      '  sf agent test run …',
    ]);
    expect(testFileOutcomeLines({ kind: 'exists', path: '/p/a.yaml', specPath: 'a.yaml' })).toEqual(
      ['/p/a.yaml is there already: --overwrite writes over it.'],
    );
  });
});
