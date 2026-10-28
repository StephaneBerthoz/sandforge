import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { RETAIL_ORDERS_PACK, testingCenterTestSpecSchema } from '@sandforge/shared';
import type { AgentCatalog, AgentTestChoice } from '@sandforge/shared';
import { nodeAgentTestSpecFiles } from '../../agentforce/testSpecWriter';
import { NO_AGENT_MESSAGE } from '../../agentforce/agentCatalog';
import { compileScenario } from './compileScenario';
import {
  nodeScenarioSidecarFiles,
  readScenarioRunSidecar,
  scenarioRunSidecar,
  writeScenarioRunSidecar,
} from './scenarioRunSidecar';
import { DX_PROJECT_FILE, scenarioProjectOf, writeRunTestFile } from './scenarioTestFile';

const RUN = 'seed-run-1';
const compiled = compileScenario(RETAIL_ORDERS_PACK);
const caseIds = Object.fromEntries(
  (compiled.template.objects.find((o) => o.objectApiName === 'Case')?.rows ?? []).map((row, i) => [
    row.key,
    `500${String(i + 1).padStart(12, '0')}AAA`,
  ]),
);

const catalog: AgentCatalog = {
  agents: [
    {
      id: '16j000000000001AAA',
      name: 'Retail_Service_Agent',
      topics: [
        {
          name: 'Order_Issues',
          described: true,
          actions: [{ name: 'Identify_Customer', described: true }],
          unnamedActions: 0,
        },
        { name: 'Off_Topic', described: true, actions: [], unnamedActions: 0 },
      ],
      unnamedTopics: 0,
      variables: [],
    },
  ],
};

const choice: AgentTestChoice = {
  agent: 'Retail_Service_Agent',
  runner: 'testing-center',
  topics: RETAIL_ORDERS_PACK.topics.map((topic) => ({
    packTopic: topic.key,
    agentTopic: 'Order_Issues',
    actions: ['Identify_Customer'],
  })),
  guardTopic: 'Off_Topic',
};

describe('writeRunTestFile — the test file of a scenario run', () => {
  let storage: string;
  let project: string;
  const files = { sidecar: nodeScenarioSidecarFiles(), spec: nodeAgentTestSpecFiles() };

  beforeEach(async () => {
    storage = mkdtempSync(join(tmpdir(), 'sandforge-storage-'));
    project = mkdtempSync(join(tmpdir(), 'sandforge-project-'));
    await writeScenarioRunSidecar(
      files.sidecar,
      storage,
      scenarioRunSidecar({ runId: RUN, pack: RETAIL_ORDERS_PACK, compiled, caseIds }),
    );
  });
  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const input = (overrides: Partial<Parameters<typeof writeRunTestFile>[1]> = {}) => ({
    runId: RUN,
    storagePath: storage,
    project: { kind: 'dx' as const, dir: project },
    alias: 'my-sandbox',
    choice,
    readCatalog: async () => ({ kind: 'agents' as const, catalog }),
    findPack: async () => RETAIL_ORDERS_PACK,
    ...overrides,
  });

  it('writes the file the CLI reads in a DX project, gives the two commands, and keeps the agent beside the run', async () => {
    const outcome = await writeRunTestFile(files, input());

    if (outcome.kind !== 'written') throw new Error(outcome.kind);
    expect(outcome.specPath).toBe(
      'specs/Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml',
    );
    expect(outcome.commands).toEqual({
      create:
        'sf agent test create --spec specs/Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml ' +
        `--api-name ${outcome.apiName} -o my-sandbox`,
      run: `sf agent test run --api-name ${outcome.apiName} --wait 10 -o my-sandbox`,
    });
    expect(outcome.notDxProject).toBeUndefined();
    const spec = testingCenterTestSpecSchema.parse(parse(readFileSync(outcome.path, 'utf8')));
    expect(spec.subjectName).toBe('Retail_Service_Agent');
    expect(spec.testCases).toHaveLength(compiled.tests.length);
    const kept = await readScenarioRunSidecar(files.sidecar, storage, RUN);
    expect(kept.kind === 'read' && kept.sidecar.agent).toEqual(choice);
  });

  it('writes the file outside a DX project and offers no command, saying why', async () => {
    const outcome = await writeRunTestFile(
      files,
      input({ project: { kind: 'folder', dir: project } }),
    );

    expect(outcome).toMatchObject({ kind: 'written', notDxProject: true });
    expect(outcome).not.toHaveProperty('commands');
  });

  it('writes nothing over a file there unless told to', async () => {
    await writeRunTestFile(files, input());
    const second = await writeRunTestFile(files, input());

    expect(second).toMatchObject({
      kind: 'exists',
      specPath: 'specs/Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml',
    });
    expect((await writeRunTestFile(files, input({ overwrite: true }))).kind).toBe('written');
  });

  it('writes nothing for an org with no agent, and says to create one first', async () => {
    const outcome = await writeRunTestFile(
      files,
      input({
        readCatalog: async () => ({ kind: 'no-agent', reason: 'none', message: NO_AGENT_MESSAGE }),
      }),
    );

    expect(outcome).toEqual({ kind: 'no-agent', reason: 'none', message: NO_AGENT_MESSAGE });
    expect(existsSync(join(project, 'specs'))).toBe(false);
  });

  it("writes nothing when the run's pack is no longer in the workspace as it was", async () => {
    const findPack = vi.fn(async () => undefined);
    const outcome = await writeRunTestFile(files, input({ findPack }));

    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'pack-not-found' });
    expect(findPack).toHaveBeenCalledWith('retail-orders', expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it('writes nothing for a run that kept no companion file, nor with no folder open', async () => {
    expect(await writeRunTestFile(files, input({ runId: 'seed-run-2' }))).toMatchObject({
      kind: 'unavailable',
      reason: 'no-companion',
    });
    expect(await writeRunTestFile(files, input({ project: { kind: 'none' } }))).toMatchObject({
      kind: 'unavailable',
      reason: 'no-workspace',
    });
  });

  it('writes nothing for a choice that names a topic the agent has not', async () => {
    const outcome = await writeRunTestFile(
      files,
      input({ choice: { ...choice, guardTopic: 'Small_Talk' } }),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      refusals: [expect.objectContaining({ code: 'topic-absent', name: 'Small_Talk' })],
    });
  });

  it('says what an unreadable catalog answered', async () => {
    const outcome = await writeRunTestFile(
      files,
      input({
        readCatalog: async () => ({
          kind: 'unreadable',
          object: 'GenAiPluginDefinition',
          message: 'The org would not read GenAiPluginDefinition: INVALID_FIELD',
        }),
      }),
    );

    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'catalog-unreadable',
      message: 'The org would not read GenAiPluginDefinition: INVALID_FIELD',
    });
  });
});

describe('scenarioProjectOf', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-folders-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the first folder that is a DX project, else the first folder, else none', async () => {
    const plain = join(dir, 'plain');
    const dx = join(dir, 'dx');
    mkdirSync(plain);
    mkdirSync(dx);
    writeFileSync(join(dx, DX_PROJECT_FILE), '{}');

    expect(await scenarioProjectOf([plain, dx])).toEqual({ kind: 'dx', dir: dx });
    expect(await scenarioProjectOf([plain])).toEqual({ kind: 'folder', dir: plain });
    expect(await scenarioProjectOf([])).toEqual({ kind: 'none' });
  });
});
