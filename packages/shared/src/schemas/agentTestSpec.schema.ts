import * as z from 'zod';
import { SCENARIO_PACK_LIMITS, scenarioKeySchema } from './scenario.schema.js';

/**
 * An Agentforce agent's tests as SandForge writes them: what the org says the
 * agent is made of (`AgentCatalog`), what the user matched a scenario's topics
 * to (`AgentTestChoice`), the tests themselves (`AgentTestSpecModel`), and the
 * two files a test is created from, one per engine that runs it.
 *
 * SandForge writes the file and stops there. A test is created in the org by
 * `sf agent test create`, which deploys it as metadata, and run by
 * `sf agent test run`, whose runs spend the org's credits: both are the
 * user's to start. So the file has to be one the CLI takes as it is, and each
 * shape here mirrors the CLI's own, field for field, strictly — a field the
 * CLI does not read is one the user would believe tested something.
 *
 * The shapes are read from the Salesforce CLI's agent library,
 * `@salesforce/agents` 2.3.2 (`lib/types.d.ts`, `TestSpec` and
 * `NgtTestSpec`; `lib/ngtScorerCatalog.js`; `lib/agentTest.js`,
 * `validateNgtSpec`), which `sf agent generate test-spec` and
 * `sf agent test create` write and read them with. The documented pages are
 * the Agentforce DX Developer Guide's "Generate a Test Spec File" and the
 * Metadata API Developer Guide's "AiEvaluationDefinition".
 */

/**
 * The engines an org runs an agent's tests with: the Testing Center, whose
 * tests are `AiEvaluationDefinition` metadata, and Agentforce Studio, whose
 * tests are `AiTestingDefinition` (`sf agent test create --test-runner`).
 */
export const AGENT_TEST_RUNNERS = ['testing-center', 'agentforce-studio'] as const;

/** An engine of {@link AGENT_TEST_RUNNERS}. */
export type AgentTestRunner = (typeof AGENT_TEST_RUNNERS)[number];

/**
 * The engine a file is written for unless the user picks the other: the one
 * `sf agent test create` creates a test for when it is not told.
 */
export const DEFAULT_AGENT_TEST_RUNNER: AgentTestRunner = 'testing-center';

// ---------------------------------------------------------------------------
// The agent's catalog, as the org describes it
// ---------------------------------------------------------------------------

/** The agents of an org, each with its topics, their actions and its variables. */
export interface AgentCatalog {
  agents: AgentDefinition[];
}

/** An agent, as `GenAiPlannerDefinition` holds it. */
export interface AgentDefinition {
  /** Its `GenAiPlannerDefinition` id. */
  id: string;
  /** Its API name: what a test names as the agent it tests (`subjectName`). */
  name: string;
  label?: string;
  /** The topics it routes to, by its `GenAiPlannerFunctionDef` rows, in name order. */
  topics: AgentTopic[];
  /**
   * Topics it routes to by an id the org gives no row for, so no name: none
   * of them can be expected by a test, and the page says how many.
   */
  unnamedTopics: number;
  /** The variables it declares (`GenAiPlannerAttrDefinition`): what a test can set before it speaks. */
  variables: AgentVariable[];
}

/** A topic of an agent (`GenAiPluginDefinition`). */
export interface AgentTopic {
  /** Its API name, as a test expects it (`expectedTopic`). */
  name: string;
  /** Its `LocalDeveloperName`, when the org gives one beside its API name. */
  localName?: string;
  label?: string;
  description?: string;
  /**
   * Whether the org describes it with a row of its own. An agent can name a
   * standard topic by its name alone, with no row to read a label from.
   */
  described: boolean;
  /** The actions it can take, by its `GenAiPluginFunctionDef` rows, in name order. */
  actions: AgentAction[];
  /** As {@link AgentDefinition.unnamedTopics}, of its actions. */
  unnamedActions: number;
}

/** An action a topic can take (`GenAiFunctionDefinition`). */
export interface AgentAction {
  /** Its API name, as a test expects it (`expectedActions`). */
  name: string;
  localName?: string;
  label?: string;
  description?: string;
  /** As {@link AgentTopic.described}. */
  described: boolean;
}

/** A variable an agent declares. */
export interface AgentVariable {
  /** Its `DeveloperName`. */
  name: string;
  /** Its `ParameterName`, when the org gives one. */
  parameterName?: string;
}

// ---------------------------------------------------------------------------
// What the user matched the scenario to
// ---------------------------------------------------------------------------

/**
 * An agent's topic or action as the user picks it: an API name the catalog
 * read. Whether the agent has it is checked against the catalog, where the
 * refusal can name it; here, only that it is a name.
 */
const agentApiNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s\p{Cc}]+$/u, 'An API name has no space and no control character');

/** Most actions a test expects of one topic. */
export const MAX_EXPECTED_ACTIONS = 10;

/**
 * What the user matched a scenario to: one agent, each topic of the pack to a
 * topic of the agent with the actions expected of it, and the agent's topic
 * that declines what no topic covers — none when the agent has no such topic,
 * and then the utterances none covers are left out of the file, and said.
 */
export const agentTestChoiceSchema = z
  .strictObject({
    agent: agentApiNameSchema,
    runner: z.enum(AGENT_TEST_RUNNERS),
    topics: z
      .array(
        z.strictObject({
          packTopic: scenarioKeySchema,
          agentTopic: agentApiNameSchema,
          actions: z.array(agentApiNameSchema).max(MAX_EXPECTED_ACTIONS),
        }),
      )
      .min(1)
      .max(SCENARIO_PACK_LIMITS.topics.max),
    guardTopic: agentApiNameSchema.nullable(),
  })
  .superRefine((choice, ctx) => {
    const seen = new Set<string>();
    choice.topics.forEach((match, index) => {
      if (seen.has(match.packTopic)) {
        ctx.addIssue({
          code: 'custom',
          path: ['topics', index, 'packTopic'],
          message: `The topic "${match.packTopic}" of the scenario is matched twice`,
        });
      }
      seen.add(match.packTopic);
      const actions = new Set<string>();
      match.actions.forEach((action, at) => {
        if (actions.has(action)) {
          ctx.addIssue({
            code: 'custom',
            path: ['topics', index, 'actions', at],
            message: `The action "${action}" is expected twice of the topic "${match.packTopic}"`,
          });
        }
        actions.add(action);
      });
    });
  });

/** What the user matched a scenario to (`agentTestChoiceSchema`). */
export type AgentTestChoice = z.infer<typeof agentTestChoiceSchema>;

// ---------------------------------------------------------------------------
// The tests, whatever engine runs them
// ---------------------------------------------------------------------------

/** A variable a test sets before its utterance is said. */
export interface AgentContextVariableValue {
  name: string;
  value: string;
}

/**
 * One test: what is said to the agent and what it should do. Both engines'
 * files are written from it, so neither can say more than the other.
 */
export interface AgentTestCaseModel {
  /** The scenario's test it is written from, by its key. */
  key: string;
  utterance: string;
  /** The agent's topic it should answer from; absent, the test asserts no topic. */
  expectedTopic?: string;
  /** The actions it should take, in order; none expected when empty. */
  expectedActions: string[];
  /** What it should say or do, in plain words, for the engine's judge to rate the answer against. */
  expectedOutcome: string;
  /** The variables set before the utterance; none when empty. */
  contextVariables: AgentContextVariableValue[];
}

/** The tests of one file. */
export interface AgentTestSpecModel {
  /** The test's label once it is created in the org. */
  name: string;
  description?: string;
  /** The agent it tests, by its API name. */
  subjectName: string;
  testCases: AgentTestCaseModel[];
}

// ---------------------------------------------------------------------------
// The Testing Center's file (`TestSpec`)
// ---------------------------------------------------------------------------

/**
 * The quality metrics a Testing Center test can ask for beside its
 * expectations (`metric` of `@salesforce/agents`, `lib/utils.js`).
 */
export const TESTING_CENTER_METRICS = [
  'completeness',
  'coherence',
  'conciseness',
  'output_latency_milliseconds',
] as const;

const nameValueSchema = z.strictObject({ name: z.string().min(1), value: z.string() });

const conversationTurnSchema = z.union([
  z.strictObject({
    role: z.literal('user'),
    message: z.string(),
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    role: z.literal('agent'),
    message: z.string(),
    topic: z.string(),
    index: z.number().int().min(0).optional(),
  }),
]);

const customEvaluationSchema = z.strictObject({
  label: z.string(),
  name: z.string(),
  parameters: z.array(
    z.union([
      z.strictObject({
        name: z.literal('operator'),
        value: z.string(),
        isReference: z.literal(false),
      }),
      z.strictObject({
        name: z.literal('actual'),
        value: z.string(),
        isReference: z.literal(true),
      }),
      z.strictObject({
        name: z.literal('expected'),
        value: z.string(),
        isReference: z.boolean(),
      }),
    ]),
  ),
});

/** A test case of the Testing Center's file (`TestCase` of `@salesforce/agents`). */
export const testingCenterTestCaseSchema = z.strictObject({
  utterance: z.string().min(1),
  expectedTopic: z.string().min(1).optional(),
  expectedActions: z.array(z.string().min(1)).optional(),
  expectedOutcome: z.string().min(1).optional(),
  metrics: z.array(z.enum(TESTING_CENTER_METRICS)).optional(),
  contextVariables: z.array(nameValueSchema).optional(),
  conversationHistory: z.array(conversationTurnSchema).optional(),
  customEvaluations: z.array(customEvaluationSchema).optional(),
});

/**
 * The Testing Center's file (`TestSpec` of `@salesforce/agents`), from which
 * `sf agent test create` deploys an `AiEvaluationDefinition`.
 */
export const testingCenterTestSpecSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  subjectType: z.literal('AGENT'),
  subjectName: z.string().min(1),
  subjectVersion: z.string().optional(),
  testCases: z.array(testingCenterTestCaseSchema).min(1),
});

/** The Testing Center's file (`testingCenterTestSpecSchema`). */
export type TestingCenterTestSpec = z.infer<typeof testingCenterTestSpecSchema>;

// ---------------------------------------------------------------------------
// Agentforce Studio's file (`NgtTestSpec`)
// ---------------------------------------------------------------------------

/**
 * The scorers Agentforce Studio knows, and whether each needs the value it
 * scores against (`NgtScorerCatalog` of `@salesforce/agents`): the CLI refuses
 * a known scorer that needs one and has none, before it deploys anything.
 */
export const AGENTFORCE_STUDIO_SCORERS = {
  topic_sequence_match: { needsExpected: true },
  action_sequence_match: { needsExpected: true },
  agent_handoff_match: { needsExpected: true },
  bot_response_rating: { needsExpected: true },
  response_match: { needsExpected: true },
  coherence: { needsExpected: false },
  conciseness: { needsExpected: false },
  factuality: { needsExpected: false },
  completeness: { needsExpected: false },
  task_resolution: { needsExpected: false },
  output_latency_milliseconds: { needsExpected: false },
} as const satisfies Record<string, { needsExpected: boolean }>;

/** A scorer of {@link AGENTFORCE_STUDIO_SCORERS}. */
export type AgentforceStudioScorer = keyof typeof AGENTFORCE_STUDIO_SCORERS;

function isKnownScorer(name: string): name is AgentforceStudioScorer {
  return Object.prototype.hasOwnProperty.call(AGENTFORCE_STUDIO_SCORERS, name);
}

const studioInputSchema = z.strictObject({
  utterance: z.string().min(1),
  contextVariables: z.array(nameValueSchema).optional(),
  conversationHistory: z.array(conversationTurnSchema).optional(),
});

/**
 * A test case of Agentforce Studio's file (`NgtTestCase`). A scorer name the
 * catalog does not know passes, as the CLI lets it pass to the server; one it
 * knows is held to its rules, as the CLI holds it (`validateNgtSpec`).
 */
export const agentforceStudioTestCaseSchema = z
  .strictObject({
    inputs: z.array(studioInputSchema).min(1),
    scorers: z
      .array(z.strictObject({ name: z.string().min(1), expected: z.string().optional() }))
      .min(1),
  })
  .superRefine((testCase, ctx) => {
    testCase.scorers.forEach((scorer, index) => {
      if (!isKnownScorer(scorer.name)) return;
      if (
        AGENTFORCE_STUDIO_SCORERS[scorer.name].needsExpected &&
        (scorer.expected === undefined || scorer.expected === '')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['scorers', index, 'expected'],
          message: `The scorer ${scorer.name} needs the value it scores against`,
        });
      }
    });
    const resolution = testCase.scorers.some((scorer) => scorer.name === 'task_resolution');
    const history = testCase.inputs.some((input) => (input.conversationHistory?.length ?? 0) > 0);
    if (resolution && !history) {
      ctx.addIssue({
        code: 'custom',
        path: ['scorers'],
        message: 'The scorer task_resolution needs a conversation history on an input',
      });
    }
  });

/**
 * Agentforce Studio's file (`NgtTestSpec` of an agent), from which
 * `sf agent test create --test-runner agentforce-studio` deploys an
 * `AiTestingDefinition`.
 */
export const agentforceStudioTestSpecSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  subjectType: z.literal('AGENT'),
  subjectName: z.string().min(1),
  subjectVersion: z.string().optional(),
  testCases: z.array(agentforceStudioTestCaseSchema).min(1),
});

/** Agentforce Studio's file (`agentforceStudioTestSpecSchema`). */
export type AgentforceStudioTestSpec = z.infer<typeof agentforceStudioTestSpecSchema>;

// ---------------------------------------------------------------------------
// The tests written for each engine
// ---------------------------------------------------------------------------

/**
 * The Testing Center's file of the tests. Each case carries its expected
 * actions, none as an empty list, as `sf agent generate test-spec` writes a
 * case that expects none; its variables only when it has some.
 *
 * @throws When the file would not be one the CLI takes: a model no mapping
 *   can make, never the user's input.
 */
export function toTestingCenterSpec(model: AgentTestSpecModel): TestingCenterTestSpec {
  return testingCenterTestSpecSchema.parse({
    name: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
    subjectType: 'AGENT',
    subjectName: model.subjectName,
    testCases: model.testCases.map((testCase) => ({
      utterance: testCase.utterance,
      ...(testCase.expectedTopic !== undefined ? { expectedTopic: testCase.expectedTopic } : {}),
      expectedActions: [...testCase.expectedActions],
      expectedOutcome: testCase.expectedOutcome,
      ...(testCase.contextVariables.length > 0
        ? { contextVariables: testCase.contextVariables.map((v) => ({ ...v })) }
        : {}),
    })),
  });
}

/**
 * The value `action_sequence_match` scores against: one action by its name,
 * several as the list the CLI's help writes, `['Verify_Customer','Get_Order_Status']`.
 */
export function studioActionSequence(actions: readonly string[]): string {
  return actions.length === 1 ? actions[0] : `[${actions.map((a) => `'${a}'`).join(',')}]`;
}

/**
 * Agentforce Studio's file of the tests: each case one input, scored on its
 * topic, its actions and its answer. A case that expects no topic, or no
 * action, is not scored on it: Studio scores a sequence against the value it
 * is given, and an empty one is not a value the CLI documents.
 *
 * @throws As {@link toTestingCenterSpec}.
 */
export function toAgentforceStudioSpec(model: AgentTestSpecModel): AgentforceStudioTestSpec {
  return agentforceStudioTestSpecSchema.parse({
    name: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
    subjectType: 'AGENT',
    subjectName: model.subjectName,
    testCases: model.testCases.map((testCase) => ({
      inputs: [
        {
          utterance: testCase.utterance,
          ...(testCase.contextVariables.length > 0
            ? { contextVariables: testCase.contextVariables.map((v) => ({ ...v })) }
            : {}),
        },
      ],
      scorers: [
        ...(testCase.expectedTopic !== undefined
          ? [{ name: 'topic_sequence_match', expected: testCase.expectedTopic }]
          : []),
        ...(testCase.expectedActions.length > 0
          ? [
              {
                name: 'action_sequence_match',
                expected: studioActionSequence(testCase.expectedActions),
              },
            ]
          : []),
        { name: 'bot_response_rating', expected: testCase.expectedOutcome },
      ],
    })),
  });
}

/** The file of the tests for one engine. */
export function agentTestSpecFor(
  model: AgentTestSpecModel,
  runner: AgentTestRunner,
): TestingCenterTestSpec | AgentforceStudioTestSpec {
  return runner === 'agentforce-studio'
    ? toAgentforceStudioSpec(model)
    : toTestingCenterSpec(model);
}
