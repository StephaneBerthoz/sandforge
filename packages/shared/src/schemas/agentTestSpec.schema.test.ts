/**
 * The test files SandForge writes, against the shapes the Salesforce CLI
 * writes and reads them in: `TestSpec` and `NgtTestSpec` of
 * `@salesforce/agents` 2.3.2 (`lib/types.d.ts`), as the Agentforce DX
 * Developer Guide's "Generate a Test Spec File" documents the first and
 * `sf agent generate test-spec --test-runner agentforce-studio` writes the
 * second. The specs written "as the CLI writes them" below are built as
 * `plugin-agent` 2.2.2 builds them (`lib/commands/agent/generate/test-spec.js`,
 * then `AgentTest.writeTestSpec`).
 */
import { describe, it, expect } from 'vitest';
import {
  AGENTFORCE_STUDIO_SCORERS,
  agentTestChoiceSchema,
  agentTestSpecFor,
  agentforceStudioTestSpecSchema,
  studioActionSequence,
  testingCenterTestSpecSchema,
  toAgentforceStudioSpec,
  toTestingCenterSpec,
  type AgentTestSpecModel,
} from './agentTestSpec.schema.js';

/** Two tests of an agent: one on a topic with two actions and a case id, one that expects nothing done. */
function model(): AgentTestSpecModel {
  return {
    name: 'Retail orders (SandForge)',
    description: 'SandForge scenario retail-orders, seed 1.',
    subjectName: 'Retail_Service_Agent',
    testCases: [
      {
        key: 'retail-orders-test-damaged-parcel-1',
        utterance: 'Hi, my email is ada.lovelace@acme.example. The parcel I received is damaged.',
        expectedTopic: 'Order_Issues',
        expectedActions: ['Identify_Customer', 'Answer_With_Knowledge'],
        expectedOutcome: 'The agent asks for photos of the damaged items.',
        contextVariables: [{ name: 'CaseId', value: '500000000000001AAA' }],
      },
      {
        key: 'retail-orders-out-1',
        utterance: 'Can you recommend a good restaurant near your warehouse?',
        expectedTopic: 'Off_Topic',
        expectedActions: [],
        expectedOutcome: 'The agent says it cannot help with that.',
        contextVariables: [],
      },
    ],
  };
}

/** What a schema says of a value: each issue as `path: message`. */
function issuesOf(
  schema: typeof testingCenterTestSpecSchema | typeof agentforceStudioTestSpecSchema,
  value: unknown,
): string[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('testingCenterTestSpecSchema, the mirror of TestSpec', () => {
  it('takes a spec as sf agent generate test-spec writes one, with the default metrics', () => {
    const spec = {
      name: 'Resort Manager Tests',
      description: 'Tests of the resort agent',
      subjectType: 'AGENT',
      subjectName: 'Resort_Manager',
      testCases: [
        {
          utterance: 'Book a massage for tomorrow at 10',
          expectedTopic: 'Reservation_Management',
          expectedActions: ['Create_Reservation'],
          expectedOutcome: 'The agent books the massage and confirms the time.',
          customEvaluations: [
            {
              label: 'Mentions the time',
              name: 'string_comparison',
              parameters: [
                { name: 'operator', value: 'contains', isReference: false },
                { name: 'actual', value: '$.generatedData.outcome', isReference: true },
                { name: 'expected', value: '10', isReference: false },
              ],
            },
          ],
          conversationHistory: [
            { role: 'user', message: 'example user message' },
            { role: 'agent', message: 'example agent message', topic: 'Example_agent_topic' },
          ],
          metrics: ['completeness', 'coherence', 'conciseness', 'output_latency_milliseconds'],
        },
        {
          // "No Actions" is written as an empty list (test-spec.js, promptForTestCase).
          utterance: 'Hello',
          expectedTopic: 'General_FAQ',
          expectedActions: [],
          expectedOutcome: 'The agent greets the guest.',
          contextVariables: [{ name: 'RoutableId', value: '0Mw000000000001' }],
        },
      ],
    };
    expect(issuesOf(testingCenterTestSpecSchema, spec)).toEqual([]);
  });

  it('refuses a field the CLI does not read, so that a misspelt expectation is not taken for one', () => {
    const spec = toTestingCenterSpec(model()) as unknown as {
      testCases: Array<Record<string, unknown>>;
    };
    spec.testCases[0].expectedTopics = spec.testCases[0].expectedTopic;
    delete spec.testCases[0].expectedTopic;
    expect(issuesOf(testingCenterTestSpecSchema, spec)).toEqual([
      expect.stringMatching(/^testCases\.0: .*expectedTopics/),
    ]);
  });

  it('refuses a spec of no test case, or of another subject than an agent', () => {
    const spec = toTestingCenterSpec(model());
    expect(issuesOf(testingCenterTestSpecSchema, { ...spec, testCases: [] })).toEqual([
      expect.stringMatching(/^testCases: /),
    ]);
    expect(issuesOf(testingCenterTestSpecSchema, { ...spec, subjectType: 'PROMPT' })).toEqual([
      expect.stringMatching(/^subjectType: /),
    ]);
  });
});

describe('agentforceStudioTestSpecSchema, the mirror of NgtTestSpec', () => {
  it('takes a spec as sf agent generate test-spec --test-runner agentforce-studio writes one', () => {
    const spec = {
      name: 'Returns Checkout',
      subjectType: 'AGENT',
      subjectName: 'Returns_Agent',
      subjectVersion: 'v1',
      testCases: [
        {
          inputs: [
            {
              utterance: 'I want to return my order',
              contextVariables: [{ name: 'CaseId', value: 'x' }],
            },
            { utterance: 'Start a return please' },
          ],
          scorers: [
            { name: 'topic_sequence_match', expected: 'Returns' },
            { name: 'action_sequence_match', expected: "['Verify_Customer','Get_Order_Status']" },
            { name: 'bot_response_rating', expected: 'Agent confirms the return.' },
            { name: 'coherence' },
          ],
        },
      ],
    };
    expect(issuesOf(agentforceStudioTestSpecSchema, spec)).toEqual([]);
  });

  it('refuses a known scorer that needs a value and has none, as validateNgtSpec refuses it', () => {
    const spec = toAgentforceStudioSpec(model());
    spec.testCases[0].scorers[0] = { name: 'topic_sequence_match' };
    expect(issuesOf(agentforceStudioTestSpecSchema, spec)).toEqual([
      'testCases.0.scorers.0.expected: The scorer topic_sequence_match needs the value it scores against',
    ]);
  });

  it('refuses task_resolution without a conversation history, and takes a scorer it does not know', () => {
    const spec = toAgentforceStudioSpec(model());
    spec.testCases[0].scorers.push({ name: 'task_resolution' }, { name: 'a_future_scorer' });
    expect(issuesOf(agentforceStudioTestSpecSchema, spec)).toEqual([
      'testCases.0.scorers: The scorer task_resolution needs a conversation history on an input',
    ]);
  });

  it('refuses a Testing Center case, whose utterance stands outside any input', () => {
    const legacy = toTestingCenterSpec(model());
    expect(issuesOf(agentforceStudioTestSpecSchema, legacy)).not.toEqual([]);
  });

  it('holds the scorers the CLI holds to a value to one', () => {
    const needing = Object.entries(AGENTFORCE_STUDIO_SCORERS)
      .filter(([, scorer]) => scorer.needsExpected)
      .map(([name]) => name);
    expect(needing).toEqual([
      'topic_sequence_match',
      'action_sequence_match',
      'agent_handoff_match',
      'bot_response_rating',
      'response_match',
    ]);
  });
});

describe('toTestingCenterSpec', () => {
  it('writes each case with its topic, its actions, its outcome and, when it has any, its variables', () => {
    expect(toTestingCenterSpec(model())).toEqual({
      name: 'Retail orders (SandForge)',
      description: 'SandForge scenario retail-orders, seed 1.',
      subjectType: 'AGENT',
      subjectName: 'Retail_Service_Agent',
      testCases: [
        {
          utterance: 'Hi, my email is ada.lovelace@acme.example. The parcel I received is damaged.',
          expectedTopic: 'Order_Issues',
          expectedActions: ['Identify_Customer', 'Answer_With_Knowledge'],
          expectedOutcome: 'The agent asks for photos of the damaged items.',
          contextVariables: [{ name: 'CaseId', value: '500000000000001AAA' }],
        },
        {
          utterance: 'Can you recommend a good restaurant near your warehouse?',
          expectedTopic: 'Off_Topic',
          expectedActions: [],
          expectedOutcome: 'The agent says it cannot help with that.',
        },
      ],
    });
  });

  it('writes no topic for a case that expects none', () => {
    const tests = model();
    delete tests.testCases[1].expectedTopic;
    expect(toTestingCenterSpec(tests).testCases[1]).not.toHaveProperty('expectedTopic');
  });

  it('throws on a model no file can be written from, such as a case with nothing said', () => {
    const tests = model();
    tests.testCases[0].utterance = '';
    expect(() => toTestingCenterSpec(tests)).toThrow();
  });
});

describe('toAgentforceStudioSpec', () => {
  it('scores each case, one input, on its topic, its actions and its answer', () => {
    expect(toAgentforceStudioSpec(model()).testCases).toEqual([
      {
        inputs: [
          {
            utterance:
              'Hi, my email is ada.lovelace@acme.example. The parcel I received is damaged.',
            contextVariables: [{ name: 'CaseId', value: '500000000000001AAA' }],
          },
        ],
        scorers: [
          { name: 'topic_sequence_match', expected: 'Order_Issues' },
          {
            name: 'action_sequence_match',
            expected: "['Identify_Customer','Answer_With_Knowledge']",
          },
          {
            name: 'bot_response_rating',
            expected: 'The agent asks for photos of the damaged items.',
          },
        ],
      },
      {
        inputs: [{ utterance: 'Can you recommend a good restaurant near your warehouse?' }],
        scorers: [
          { name: 'topic_sequence_match', expected: 'Off_Topic' },
          { name: 'bot_response_rating', expected: 'The agent says it cannot help with that.' },
        ],
      },
    ]);
  });

  it('writes one action by its name, as the CLI help asks for a single action', () => {
    expect(studioActionSequence(['Get_Order_Status'])).toBe('Get_Order_Status');
    expect(studioActionSequence(['Verify_Customer', 'Get_Order_Status'])).toBe(
      "['Verify_Customer','Get_Order_Status']",
    );
  });

  it('scores no topic for a case that expects none', () => {
    const tests = model();
    delete tests.testCases[1].expectedTopic;
    expect(toAgentforceStudioSpec(tests).testCases[1].scorers.map((s) => s.name)).toEqual([
      'bot_response_rating',
    ]);
  });
});

describe('agentTestSpecFor', () => {
  it('writes the file of the engine asked for', () => {
    expect(agentTestSpecFor(model(), 'testing-center')).toEqual(toTestingCenterSpec(model()));
    expect(agentTestSpecFor(model(), 'agentforce-studio')).toEqual(toAgentforceStudioSpec(model()));
  });
});

describe('agentTestChoiceSchema', () => {
  const choice = {
    agent: 'Retail_Service_Agent',
    runner: 'testing-center',
    topics: [
      { packTopic: 'damaged-parcel', agentTopic: 'Order_Issues', actions: ['Identify_Customer'] },
      { packTopic: 'refund', agentTopic: 'Order_Issues', actions: [] },
    ],
    guardTopic: null,
  };

  it('takes two topics of a scenario matched to one topic of the agent', () => {
    expect(agentTestChoiceSchema.safeParse(choice).success).toBe(true);
  });

  it('refuses a topic of the scenario matched twice, naming it', () => {
    const twice = { ...choice, topics: [...choice.topics, choice.topics[0]] };
    const parsed = agentTestChoiceSchema.safeParse(twice);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([
      'The topic "damaged-parcel" of the scenario is matched twice',
    ]);
  });

  it('refuses an action expected twice of one topic, naming it', () => {
    const topics = [{ ...choice.topics[0], actions: ['Identify_Customer', 'Identify_Customer'] }];
    const parsed = agentTestChoiceSchema.safeParse({ ...choice, topics });
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([
      'The action "Identify_Customer" is expected twice of the topic "damaged-parcel"',
    ]);
  });

  it('refuses an engine the CLI has not, and a name with a space', () => {
    expect(agentTestChoiceSchema.safeParse({ ...choice, runner: 'studio' }).success).toBe(false);
    expect(agentTestChoiceSchema.safeParse({ ...choice, agent: 'Retail Agent' }).success).toBe(
      false,
    );
  });
});
