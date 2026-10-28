/**
 * The test file as the Salesforce CLI reads it: parsed with `yaml`, the
 * package `@salesforce/agents` parses a spec with (`AgentTest.getMetadata`,
 * `yamlSpecTranslator.parseTestSpec`), then held to the mirrors of `TestSpec`
 * and `NgtTestSpec` — the shapes the Agentforce DX Developer Guide's
 * "Generate a Test Spec File" documents, and `sf agent test create
 * --test-runner agentforce-studio` reads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import {
  RETAIL_ORDERS_PACK,
  agentforceStudioTestSpecSchema,
  testingCenterTestSpecSchema,
  toAgentforceStudioSpec,
  toTestingCenterSpec,
} from '@sandforge/shared';
import type { AgentCatalog, AgentTestChoice, AgentTestSpecModel } from '@sandforge/shared';
import { compileScenario } from '../seed/scenario/compileScenario';
import { scenarioRunSidecar } from '../seed/scenario/scenarioRunSidecar';
import {
  agentTestApiName,
  agentTestCommands,
  agentTestSpecFileName,
  agentTestSpecYaml,
  nodeAgentTestSpecFiles,
  writeAgentTestSpec,
  writeScenarioTestSpec,
  yamlOf,
  type AgentTestSpecFiles,
} from './testSpecWriter';

function model(): AgentTestSpecModel {
  return {
    name: 'Retail orders (SandForge)',
    description: 'SandForge scenario retail-orders, seed 1.',
    subjectName: 'Retail_Service_Agent',
    testCases: [
      {
        key: 'retail-orders-test-damaged-parcel-1',
        utterance: 'Hi, my email is ada.lovelace@acme.example. Is it "damaged": yes # really',
        expectedTopic: 'Order_Issues',
        expectedActions: ['Identify_Customer', 'Answer_With_Knowledge'],
        expectedOutcome: 'The agent asks for photos.\nThen it offers a replacement.',
        contextVariables: [{ name: 'CaseId', value: '500000000000001AAA' }],
      },
      {
        key: 'retail-orders-out-1',
        utterance: 'Can you recommend a restaurant?',
        expectedTopic: 'Off_Topic',
        expectedActions: [],
        expectedOutcome: 'The agent says it cannot help with that.',
        contextVariables: [],
      },
    ],
  };
}

describe('agentTestSpecYaml', () => {
  it('writes the Testing Center file in the shape sf agent generate test-spec writes', () => {
    expect(agentTestSpecYaml(model(), 'testing-center')).toBe(
      [
        'name: "Retail orders (SandForge)"',
        'description: "SandForge scenario retail-orders, seed 1."',
        'subjectType: "AGENT"',
        'subjectName: "Retail_Service_Agent"',
        'testCases:',
        '  - utterance: "Hi, my email is ada.lovelace@acme.example. Is it \\"damaged\\": yes # really"',
        '    expectedTopic: "Order_Issues"',
        '    expectedActions:',
        '      - "Identify_Customer"',
        '      - "Answer_With_Knowledge"',
        '    expectedOutcome: "The agent asks for photos.\\nThen it offers a replacement."',
        '    contextVariables:',
        '      - name: "CaseId"',
        '        value: "500000000000001AAA"',
        '  - utterance: "Can you recommend a restaurant?"',
        '    expectedTopic: "Off_Topic"',
        '    expectedActions: []',
        '    expectedOutcome: "The agent says it cannot help with that."',
        '',
      ].join('\n'),
    );
  });

  it('is read by the CLI as the TestSpec it was written from, which the mirror takes', () => {
    const read = parse(agentTestSpecYaml(model(), 'testing-center'));
    expect(read).toEqual(toTestingCenterSpec(model()));
    expect(testingCenterTestSpecSchema.safeParse(read).success).toBe(true);
  });

  it('is read by the CLI as the NgtTestSpec of Agentforce Studio it was written from', () => {
    const read = parse(agentTestSpecYaml(model(), 'agentforce-studio'));
    expect(read).toEqual(toAgentforceStudioSpec(model()));
    expect(agentforceStudioTestSpecSchema.safeParse(read).success).toBe(true);
    expect(read.testCases[0].scorers[1]).toEqual({
      name: 'action_sequence_match',
      expected: "['Identify_Customer','Answer_With_Knowledge']",
    });
  });
});

describe('yamlOf', () => {
  /** A text of any characters, the ones YAML treats apart among them. */
  const textArb = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 40 }),
    fc
      .array(
        fc.constantFrom(
          ':',
          '#',
          '- ',
          '"',
          "'",
          '\\',
          '\n',
          '\r',
          '\t',
          ' ',
          '{',
          '}',
          '[',
          ']',
          '&',
          '*',
          '!',
          '|',
          '>',
          '%',
          '@',
          '`',
          '?',
          ',',
          'yes',
          'no',
          'null',
          '~',
          'true',
          '0x1F',
          '1e3',
          '\u0085',
          ' ',
          ' ',
          '﻿',
          '\u007f',
          ' ',
          'é',
          '組織',
          '😀',
        ),
        { maxLength: 12 },
      )
      .map((parts) => parts.join('')),
  );

  it('writes any text so that YAML reads it back as the same text', () => {
    fc.assert(
      fc.property(fc.array(textArb, { maxLength: 4 }), textArb, (list, text) => {
        const value = { text, list, nested: [{ text, list }] };
        expect(parse(yamlOf(value))).toEqual(value);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * What a YAML file may hold as it is (YAML 1.2.2, §5.1, `c-printable`),
   * less what a YAML 1.1 reader breaks a line on (§5.4 of 1.1: x85, x2028,
   * x2029) and the byte-order mark, which no document holds inside (§5.2).
   * The `yaml` package reads them all back; a stricter reader would not.
   */
  const PRINTABLE = /^[\t\n\r\x20-\x7e\xa0-‧‪-퟿-﻾＀-�\u{10000}-\u{10ffff}]*$/u;

  it('writes only what every YAML reader prints, escaping the rest', () => {
    fc.assert(
      fc.property(textArb, (text) => {
        expect(yamlOf({ text })).toMatch(PRINTABLE);
      }),
      { numRuns: 500 },
    );
    expect(yamlOf({ text: '\u007f\u0085 ﻿￾' })).toBe(
      'text: "\\u007f\\u0085\\u2028\\ufeff\\ufffe"\n',
    );
  });

  it('writes an empty list and an empty map as YAML reads them, and a key that is no word quoted', () => {
    const value = { none: [], empty: {}, items: [[], {}, 1, true, null], 'a key': 'x' };
    expect(parse(yamlOf(value))).toEqual(value);
  });
});

describe('agentTestSpecFileName', () => {
  it("names the file after the agent and the pack, with the CLI's suffix for each engine", () => {
    expect(agentTestSpecFileName('Retail_Service_Agent', 'retail-orders', 'testing-center')).toBe(
      'Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml',
    );
    expect(
      agentTestSpecFileName('Retail_Service_Agent', 'retail-orders', 'agentforce-studio'),
    ).toBe('Retail_Service_Agent-retail-orders-sandforge-ngtTestSpec.yaml');
  });

  it('writes no character a file name or a path cannot hold', () => {
    expect(agentTestSpecFileName('../ns__Agent v2', 'pack', 'testing-center')).toBe(
      '___ns__Agent_v2-pack-sandforge-testSpec.yaml',
    );
  });
});

describe('agentTestApiName', () => {
  /** What `sf agent test create` takes as a test's API name (`create.js`, FLAGGABLE_PROMPTS). */
  const takenByTheCli = (name: string) =>
    name.length <= 80 && /^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]+$/.test(name) && !name.includes('__');

  it('names the test after the agent and the pack, as the CLI takes an API name', () => {
    expect(agentTestApiName('Retail_Service_Agent', 'retail-orders')).toBe(
      'Retail_Service_Agent_retail_orders_SandForge',
    );
    expect(agentTestApiName('ns__Retail_Agent', 'saas-support')).toBe(
      'ns_Retail_Agent_saas_support_SandForge',
    );
  });

  it('cuts the agent part of a name past eighty characters, and starts one with a letter', () => {
    const long = agentTestApiName(`A${'b'.repeat(120)}`, 'broadband-support');
    expect(long).toHaveLength(80);
    expect(long.endsWith('_broadband_support_SandForge')).toBe(true);
    expect(agentTestApiName('2nd_Agent', 'retail-orders')).toBe(
      'Agent_2nd_Agent_retail_orders_SandForge',
    );
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}(?:-[a-z0-9]{1,8}){0,3}$/),
        (agent, pack) => {
          expect(takenByTheCli(agentTestApiName(agent, pack))).toBe(true);
        },
      ),
    );
  });
});

describe('agentTestCommands', () => {
  it('creates the test from the file and runs it, always on the org named', () => {
    const commands = agentTestCommands({
      specPath: 'specs/Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml',
      apiName: 'Retail_Service_Agent_retail_orders_SandForge',
      alias: 'my-sandbox',
      runner: 'testing-center',
    });
    expect(commands.create.line).toBe(
      'sf agent test create --spec specs/Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml ' +
        '--api-name Retail_Service_Agent_retail_orders_SandForge -o my-sandbox',
    );
    expect(commands.run.line).toBe(
      'sf agent test run --api-name Retail_Service_Agent_retail_orders_SandForge --wait 10 -o my-sandbox',
    );
  });

  it('names Agentforce Studio to both commands for its file, and quotes an alias with a space', () => {
    const commands = agentTestCommands({
      specPath: 'specs/A-p-sandforge-ngtTestSpec.yaml',
      apiName: 'A_p_SandForge',
      alias: 'my "test" org',
      runner: 'agentforce-studio',
    });
    expect(commands.create.argv).toEqual([
      'sf',
      'agent',
      'test',
      'create',
      '--spec',
      'specs/A-p-sandforge-ngtTestSpec.yaml',
      '--api-name',
      'A_p_SandForge',
      '--test-runner',
      'agentforce-studio',
      '-o',
      'my "test" org',
    ]);
    expect(commands.run.line).toBe(
      'sf agent test run --api-name A_p_SandForge --wait 10 --test-runner agentforce-studio -o "my \\"test\\" org"',
    );
  });
});

describe('writeAgentTestSpec', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const write = (projectDir: string, overwrite?: boolean) =>
    writeAgentTestSpec(nodeAgentTestSpecFiles(), {
      projectDir,
      model: model(),
      runner: 'testing-center',
      packId: 'retail-orders',
      alias: 'my-sandbox',
      ...(overwrite !== undefined ? { overwrite } : {}),
    });

  it('writes the file under specs and gives the commands that name it', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sandforge-test-spec-'));
    const result = await write(root);
    const name = 'Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml';
    expect(result).toEqual({
      kind: 'written',
      path: path.join(root, 'specs', name),
      specPath: `specs/${name}`,
      apiName: 'Retail_Service_Agent_retail_orders_SandForge',
      commands: agentTestCommands({
        specPath: `specs/${name}`,
        apiName: 'Retail_Service_Agent_retail_orders_SandForge',
        alias: 'my-sandbox',
        runner: 'testing-center',
      }),
    });
    expect(await readFile(path.join(root, 'specs', name), 'utf8')).toBe(
      agentTestSpecYaml(model(), 'testing-center'),
    );
  });

  it('never writes over a file there unless told to, and then leaves no temporary file', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sandforge-test-spec-'));
    const name = 'Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml';
    const file = path.join(root, 'specs', name);
    await write(root);
    await writeFile(file, 'edited by hand\n');
    expect(await write(root)).toEqual({ kind: 'exists', path: file, specPath: `specs/${name}` });
    expect(await readFile(file, 'utf8')).toBe('edited by hand\n');
    expect((await write(root, true)).kind).toBe('written');
    expect(await readFile(file, 'utf8')).toBe(agentTestSpecYaml(model(), 'testing-center'));
    expect(await readdir(path.join(root, 'specs'))).toEqual([name]);
  });
});

describe('writeScenarioTestSpec', () => {
  const compiled = compileScenario(RETAIL_ORDERS_PACK);
  const caseIds = Object.fromEntries(
    (compiled.template.objects.find((o) => o.objectApiName === 'Case')?.rows ?? []).map(
      (row, i) => [row.key, `500${String(i + 1).padStart(12, '0')}AAA`],
    ),
  );
  const sidecar = scenarioRunSidecar({
    runId: 'seed-run-1',
    pack: RETAIL_ORDERS_PACK,
    compiled,
    caseIds,
  });
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
        variables: [{ name: 'CaseId' }],
      },
    ],
  };
  const choice: AgentTestChoice = {
    agent: 'Retail_Service_Agent',
    runner: 'agentforce-studio',
    topics: RETAIL_ORDERS_PACK.topics.map((topic) => ({
      packTopic: topic.key,
      agentTopic: 'Order_Issues',
      actions: ['Identify_Customer'],
    })),
    guardTopic: 'Off_Topic',
  };

  /** Files in memory: what was written, by path. */
  function memoryFiles(): AgentTestSpecFiles & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      mkdir: async () => undefined,
      writeNew: async (file, content) => {
        if (files.has(file)) return false;
        files.set(file, content);
        return true;
      },
      replace: async (file, content) => {
        files.set(file, content);
      },
    };
  }

  it("writes the run's tests for the agent chosen, each about the case the run wrote, and keeps the choice", async () => {
    const files = memoryFiles();
    const result = await writeScenarioTestSpec(files, {
      sidecar,
      pack: RETAIL_ORDERS_PACK,
      catalog,
      choice,
      projectDir: 'project',
      alias: 'my-sandbox',
    });
    if (result.kind !== 'written') throw new Error(result.kind);
    expect(result.specPath).toBe(
      'specs/Retail_Service_Agent-retail-orders-sandforge-ngtTestSpec.yaml',
    );
    expect(result.sidecar.agent).toEqual(choice);
    expect(result.leftOut).toEqual([]);
    const spec = agentforceStudioTestSpecSchema.parse(
      parse(files.files.get(result.path) as string),
    );
    expect(spec.testCases).toHaveLength(compiled.tests.length);
    const first = compiled.tests[0];
    expect(spec.testCases[0].inputs[0]).toEqual({
      utterance: first.utterance,
      contextVariables: [{ name: 'CaseId', value: caseIds[first.openCase?.caseKey as string] }],
    });
  });

  it('writes nothing for a pack edited since the run', async () => {
    const files = memoryFiles();
    const edited = structuredClone(RETAIL_ORDERS_PACK);
    edited.topics[0].label = 'Damaged parcels';
    const result = await writeScenarioTestSpec(files, {
      sidecar,
      pack: edited,
      catalog,
      choice,
      projectDir: 'project',
      alias: 'my-sandbox',
    });
    expect(result).toEqual({
      kind: 'refused',
      refusals: [expect.objectContaining({ code: 'pack-changed', name: 'retail-orders' })],
    });
    expect(files.files.size).toBe(0);
  });

  it('writes nothing for a choice that names what the agent has not', async () => {
    const files = memoryFiles();
    const result = await writeScenarioTestSpec(files, {
      sidecar,
      pack: RETAIL_ORDERS_PACK,
      catalog,
      choice: { ...choice, guardTopic: 'Small_Talk' },
      projectDir: 'project',
      alias: 'my-sandbox',
    });
    expect(result).toEqual({
      kind: 'refused',
      refusals: [expect.objectContaining({ code: 'topic-absent', name: 'Small_Talk' })],
    });
    expect(files.files.size).toBe(0);
  });
});
