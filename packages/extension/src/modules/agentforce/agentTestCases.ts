/**
 * A scenario's tests made the tests of one agent: each topic of the pack
 * matched to a topic of the agent, the actions expected of it, and the open
 * case each test is said about by the id the run gave it.
 *
 * Every name written comes from the agent's catalog, as the org read it, and
 * one the catalog does not hold is refused with that name: a topic or an
 * action the agent does not have makes a test that can only fail, and the
 * user would read its failure as the agent's. Nothing is guessed — not a
 * topic from a topic's label, not an action from a scenario's words.
 *
 * Pure: the catalog, the user's choice and the run's ids are handed over.
 */

import type {
  AgentCatalog,
  AgentContextVariableValue,
  AgentDefinition,
  AgentTestCaseModel,
  AgentTestChoice,
  AgentTestSpecModel,
  CompiledScenario,
  ScenarioTestCase,
} from '@sandforge/shared';
import { agentTestChoiceSchema } from '@sandforge/shared';
import { agentNamed, declaresVariable } from './agentCatalog';

/**
 * The variable a test sets to the id of the case it is about, when the agent
 * declares one by that name: the one the CLI's help gives as its example of
 * a context variable (`sf agent generate test-spec`, "such as CaseId or
 * RoutableId"). An agent that declares none is told who speaks and of which
 * case by the utterance itself, which names the contact's address and the
 * case's subject as the scenario wrote them.
 */
export const CASE_ID_CONTEXT_VARIABLE = 'CaseId';

/** Longest label of a test in the org, as `sf agent test create` names it from the file. */
const MAX_SPEC_NAME = 80;

/** What a choice is refused for, with the name it is refused on. */
export type AgentTestRefusalCode =
  | 'choice-invalid'
  | 'pack-changed'
  | 'agent-absent'
  | 'pack-topic-unknown'
  | 'pack-topic-unmatched'
  | 'topic-absent'
  | 'action-absent'
  | 'action-not-of-topic'
  | 'no-test-left';

/** A refusal: its code, the name it is about, and what the page says. */
export interface AgentTestRefusal {
  code: AgentTestRefusalCode;
  /** The agent, topic or action refused, as the choice named it; the field, for an invalid choice. */
  name: string;
  message: string;
}

/** A test of the scenario the file leaves out, and why. */
export interface AgentTestLeftOut {
  /** The scenario's test, by its key. */
  test: string;
  /**
   * `case-not-written`: the open case it is about was not written by the
   * run, so the test would ask after a case that does not exist.
   * `no-guard-topic`: an utterance no topic covers, and no topic of the
   * agent chosen to decline it.
   */
  reason: 'case-not-written' | 'no-guard-topic';
  message: string;
}

/** The tests of an agent, or why the choice cannot make them. */
export type AgentTestCasesResult =
  | {
      ok: true;
      spec: AgentTestSpecModel;
      /** The choice the tests were made with, as it parsed. */
      choice: AgentTestChoice;
      /** Each test of the scenario not in the file, with why. */
      leftOut: AgentTestLeftOut[];
      /** The variable each case sets to its case's id; absent when the agent declares none. */
      contextVariable?: string;
    }
  | { ok: false; refusals: AgentTestRefusal[] };

/** What the tests of an agent are made from. */
export interface AgentTestCasesInput {
  /** The scenario as the run compiled it. */
  compiled: Pick<CompiledScenario, 'packId' | 'seed' | 'tests'> & {
    template: Pick<CompiledScenario['template'], 'name'>;
  };
  catalog: AgentCatalog;
  /** What the user matched the scenario to; checked here, as it comes from the page. */
  choice: unknown;
  /** The id of each open case the run wrote, by its row key. */
  openCaseIds: Readonly<Record<string, string>>;
  /** The seed run whose records the tests name. */
  runId?: string;
}

/**
 * The tests the choice makes of the scenario, or every refusal of it at
 * once, each with what it names: the page shows them all, not the first.
 */
export function agentTestCases(input: AgentTestCasesInput): AgentTestCasesResult {
  const parsed = agentTestChoiceSchema.safeParse(input.choice);
  if (!parsed.success) {
    return {
      ok: false,
      refusals: parsed.error.issues.map((issue) => ({
        code: 'choice-invalid',
        name: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const choice = parsed.data;
  const agent = agentNamed(input.catalog, choice.agent);
  if (!agent) {
    return {
      ok: false,
      refusals: [
        {
          code: 'agent-absent',
          name: choice.agent,
          message: `"${choice.agent}" is not one of this org's agents`,
        },
      ],
    };
  }

  const refusals = refusalsOf(choice, agent, packTopicsOf(input.compiled.tests));
  if (refusals.length > 0) return { ok: false, refusals };

  const matchOf = new Map(choice.topics.map((match) => [match.packTopic, match]));
  const contextVariable = declaresVariable(agent, CASE_ID_CONTEXT_VARIABLE)
    ? CASE_ID_CONTEXT_VARIABLE
    : undefined;
  const testCases: AgentTestCaseModel[] = [];
  const leftOut: AgentTestLeftOut[] = [];

  for (const test of input.compiled.tests) {
    if (test.topicKey === null) {
      if (choice.guardTopic === null) {
        leftOut.push({
          test: test.key,
          reason: 'no-guard-topic',
          message:
            `"${test.utterance}" is on no topic of the scenario, and no topic of the agent ` +
            'is chosen to decline it: the test is left out',
        });
        continue;
      }
      testCases.push({
        key: test.key,
        utterance: test.utterance,
        expectedTopic: choice.guardTopic,
        expectedActions: [],
        expectedOutcome: test.expectedOutcome,
        contextVariables: [],
      });
      continue;
    }
    // Every topic of the pack is matched once the refusals are none.
    const match = matchOf.get(test.topicKey) as AgentTestChoice['topics'][number];
    const variables: AgentContextVariableValue[] = [];
    if (test.openCase) {
      const caseId = input.openCaseIds[test.openCase.caseKey];
      if (caseId === undefined) {
        leftOut.push({
          test: test.key,
          reason: 'case-not-written',
          message:
            `The case ${test.openCase.caseKey} the test is about was not written by the run: ` +
            'the test is left out',
        });
        continue;
      }
      if (contextVariable !== undefined) variables.push({ name: contextVariable, value: caseId });
    }
    testCases.push({
      key: test.key,
      utterance: test.utterance,
      expectedTopic: match.agentTopic,
      expectedActions: [...match.actions],
      expectedOutcome: outcomeOf(test),
      contextVariables: variables,
    });
  }

  if (testCases.length === 0) {
    return {
      ok: false,
      refusals: [
        {
          code: 'no-test-left',
          name: input.compiled.packId,
          message:
            'No test of the scenario is left to write: ' + leftOut.map((l) => l.message).join('; '),
        },
      ],
    };
  }

  return {
    ok: true,
    spec: {
      name: specName(input.compiled.template.name),
      description: specDescription(input.compiled.packId, input.compiled.seed, input.runId),
      subjectName: agent.name,
      testCases,
    },
    choice,
    leftOut,
    ...(contextVariable !== undefined ? { contextVariable } : {}),
  };
}

/** The topics of the pack the tests are on, each once, in the tests' order. */
function packTopicsOf(tests: readonly ScenarioTestCase[]): string[] {
  return [...new Set(tests.flatMap((test) => (test.topicKey === null ? [] : [test.topicKey])))];
}

/** Every refusal of a choice against the agent's catalog and the pack's topics. */
function refusalsOf(
  choice: AgentTestChoice,
  agent: AgentDefinition,
  packTopics: readonly string[],
): AgentTestRefusal[] {
  const refusals: AgentTestRefusal[] = [];
  const topicNamed = new Map(agent.topics.map((topic) => [topic.name, topic]));
  const anyAction = new Set(agent.topics.flatMap((topic) => topic.actions.map((a) => a.name)));
  const topicAbsent = (name: string): AgentTestRefusal => ({
    code: 'topic-absent',
    name,
    message: `"${name}" is not a topic of the agent ${agent.name}`,
  });

  for (const match of choice.topics) {
    if (!packTopics.includes(match.packTopic)) {
      refusals.push({
        code: 'pack-topic-unknown',
        name: match.packTopic,
        message: `"${match.packTopic}" is not a topic of the scenario`,
      });
    }
    const topic = topicNamed.get(match.agentTopic);
    if (!topic) {
      refusals.push(topicAbsent(match.agentTopic));
      continue;
    }
    const ofTopic = new Set(topic.actions.map((action) => action.name));
    for (const action of match.actions) {
      if (ofTopic.has(action)) continue;
      refusals.push(
        anyAction.has(action)
          ? {
              code: 'action-not-of-topic',
              name: action,
              message: `"${action}" is not an action of the topic ${topic.name}, which the agent answers "${match.packTopic}" from`,
            }
          : {
              code: 'action-absent',
              name: action,
              message: `"${action}" is not an action of the agent ${agent.name}`,
            },
      );
    }
  }
  const matched = new Set(choice.topics.map((match) => match.packTopic));
  for (const packTopic of packTopics) {
    if (matched.has(packTopic)) continue;
    refusals.push({
      code: 'pack-topic-unmatched',
      name: packTopic,
      message: `The topic "${packTopic}" of the scenario is matched to no topic of the agent`,
    });
  }
  if (choice.guardTopic !== null && !topicNamed.has(choice.guardTopic)) {
    refusals.push(topicAbsent(choice.guardTopic));
  }
  return refusals;
}

/**
 * What the agent should answer: the scenario's words, and the article the
 * answer is drawn from, by its title, with what the article states that the
 * answer can cite. A judge that rates the answer reads them all.
 */
function outcomeOf(test: ScenarioTestCase): string {
  if (!test.article) return test.expectedOutcome;
  const facts =
    test.article.facts.length > 0 ? `, which states: ${test.article.facts.join('; ')}` : '';
  return `${test.expectedOutcome} The answer draws on the article "${test.article.title}"${facts}.`;
}

/** The test's label in the org: the scenario's name, marked as SandForge's. */
function specName(scenarioName: string): string {
  const mark = ' (SandForge)';
  const room = MAX_SPEC_NAME - mark.length;
  const name = scenarioName.length > room ? scenarioName.slice(0, room).trimEnd() : scenarioName;
  return `${name}${mark}`;
}

/**
 * What the test says of itself in the org: the scenario and the seed it was
 * written from, and that its cases name the run's records, which a removal
 * of the run takes with it.
 */
function specDescription(packId: string, seed: number, runId: string | undefined): string {
  const run = runId !== undefined ? `, written by the seed run ${runId}` : '';
  return (
    `SandForge scenario ${packId}, seed ${seed}${run}. Its cases are about the records that run ` +
    'wrote: once it is removed, they are about none.'
  );
}
