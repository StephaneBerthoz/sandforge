import { describe, it, expect } from 'vitest';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import type {
  AgentCatalog,
  AgentDefinition,
  AgentTestChoice,
  CompiledScenario,
} from '@sandforge/shared';
import { compileScenario } from '../seed/scenario/compileScenario';
import {
  agentTestCases,
  CASE_ID_CONTEXT_VARIABLE,
  type AgentTestCasesInput,
} from './agentTestCases';

const compiled: CompiledScenario = compileScenario(RETAIL_ORDERS_PACK);

/** The retail agent as an org's catalog describes it. */
function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  const topic = (name: string, actions: string[]) => ({
    name,
    described: true,
    actions: actions.map((action) => ({ name: action, described: true })),
    unnamedActions: 0,
  });
  return {
    id: '16j000000000001AAA',
    name: 'Retail_Service_Agent',
    topics: [
      topic('Order_Issues', ['Identify_Customer', 'Answer_With_Knowledge']),
      topic('Delivery', ['Identify_Customer', 'Track_Parcel']),
      topic('Off_Topic', []),
    ],
    unnamedTopics: 0,
    variables: [],
    ...overrides,
  };
}

function catalog(...agents: AgentDefinition[]): AgentCatalog {
  return { agents: agents.length > 0 ? agents : [agent()] };
}

/** Every topic of the retail pack matched to one of the agent's. */
function choice(overrides: Partial<AgentTestChoice> = {}): AgentTestChoice {
  return {
    agent: 'Retail_Service_Agent',
    runner: 'testing-center',
    topics: [
      { packTopic: 'damaged-parcel', agentTopic: 'Order_Issues', actions: ['Identify_Customer'] },
      { packTopic: 'refund', agentTopic: 'Order_Issues', actions: [] },
      { packTopic: 'late-delivery', agentTopic: 'Delivery', actions: ['Track_Parcel'] },
      { packTopic: 'address-change', agentTopic: 'Delivery', actions: [] },
      { packTopic: 'warranty', agentTopic: 'Order_Issues', actions: ['Answer_With_Knowledge'] },
    ],
    guardTopic: 'Off_Topic',
    ...overrides,
  };
}

/** An id for each open case of the compiled scenario, as the run would give them. */
function openCaseIds(): Record<string, string> {
  const ids: Record<string, string> = {};
  compiled.tests.forEach((test, index) => {
    if (test.openCase) ids[test.openCase.caseKey] = `500${String(index + 1).padStart(12, '0')}AAA`;
  });
  return ids;
}

function input(overrides: Partial<AgentTestCasesInput> = {}): AgentTestCasesInput {
  return {
    compiled,
    catalog: catalog(),
    choice: choice(),
    openCaseIds: openCaseIds(),
    runId: 'seed-run-1',
    ...overrides,
  };
}

function written(result: ReturnType<typeof agentTestCases>) {
  if (!result.ok) throw new Error(result.refusals.map((r) => r.message).join('; '));
  return result;
}

describe('agentTestCases', () => {
  it('writes every test of the scenario, on the topics and with the actions the user matched', () => {
    const result = written(agentTestCases(input()));
    expect(result.leftOut).toEqual([]);
    expect(result.spec.testCases.map((t) => t.key)).toEqual(compiled.tests.map((t) => t.key));
    const damaged = result.spec.testCases.find(
      (t) => t.key === 'retail-orders-test-damaged-parcel-1',
    );
    expect(damaged).toMatchObject({
      expectedTopic: 'Order_Issues',
      expectedActions: ['Identify_Customer'],
    });
    const late = result.spec.testCases.find((t) => t.key === 'retail-orders-test-late-delivery-1');
    expect(late).toMatchObject({ expectedTopic: 'Delivery', expectedActions: ['Track_Parcel'] });
  });

  it('expects an answer that cites the article of the topic by its title, and what it states', () => {
    const result = written(agentTestCases(input()));
    const test = compiled.tests[0];
    const outcome = result.spec.testCases[0].expectedOutcome;
    expect(outcome.startsWith(test.expectedOutcome)).toBe(true);
    expect(outcome).toContain(`the article "${test.article?.title}"`);
    for (const fact of test.article?.facts ?? []) expect(outcome).toContain(fact);
  });

  it('expects the utterances no topic covers on the topic chosen to decline them, with no action', () => {
    const result = written(agentTestCases(input()));
    const outOfScope = result.spec.testCases.filter((t) => t.key.startsWith('retail-orders-out-'));
    expect(outOfScope).toHaveLength(RETAIL_ORDERS_PACK.outOfScope.length);
    for (const test of outOfScope) {
      expect(test).toMatchObject({
        expectedTopic: 'Off_Topic',
        expectedActions: [],
        contextVariables: [],
      });
    }
  });

  it('sets the case id of each test when the agent declares CaseId', () => {
    const declaring = agent({ variables: [{ name: CASE_ID_CONTEXT_VARIABLE }] });
    const ids = openCaseIds();
    const result = written(
      agentTestCases(input({ catalog: catalog(declaring), openCaseIds: ids })),
    );
    expect(result.contextVariable).toBe('CaseId');
    result.spec.testCases.forEach((testCase) => {
      const test = compiled.tests.find((t) => t.key === testCase.key);
      expect(testCase.contextVariables).toEqual(
        test?.openCase ? [{ name: 'CaseId', value: ids[test.openCase.caseKey] }] : [],
      );
    });
  });

  it('sets no variable when the agent declares none, the utterance naming who speaks as the scenario wrote it', () => {
    const result = written(agentTestCases(input()));
    expect(result.contextVariable).toBeUndefined();
    expect(result.spec.testCases.every((t) => t.contextVariables.length === 0)).toBe(true);
    const first = compiled.tests[0];
    expect(result.spec.testCases[0].utterance).toBe(first.utterance);
    expect(result.spec.testCases[0].utterance).toContain(first.openCase?.contactEmail);
  });

  it('names the agent and the scenario: the label, at most eighty characters, and where its cases come from', () => {
    const result = written(agentTestCases(input()));
    expect(result.spec.subjectName).toBe('Retail_Service_Agent');
    expect(result.spec.name).toBe('Retail orders (SandForge)');
    expect(result.spec.description).toBe(
      'SandForge scenario retail-orders, seed 1, written by the seed run seed-run-1. Its cases are ' +
        'about the records that run wrote: once it is removed, they are about none.',
    );
    const long = { ...compiled, template: { ...compiled.template, name: 'x'.repeat(80) } };
    expect(written(agentTestCases(input({ compiled: long }))).spec.name).toHaveLength(80);
  });

  it('leaves out, and says, a test about a case the run did not write; the others are written', () => {
    const ids = openCaseIds();
    const refused = compiled.tests[0].openCase?.caseKey as string;
    delete ids[refused];
    const result = written(agentTestCases(input({ openCaseIds: ids })));
    const about = compiled.tests.filter((t) => t.openCase?.caseKey === refused).map((t) => t.key);
    expect(result.leftOut).toEqual(
      about.map((test) => ({
        test,
        reason: 'case-not-written',
        message: `The case ${refused} the test is about was not written by the run: the test is left out`,
      })),
    );
    expect(result.spec.testCases).toHaveLength(compiled.tests.length - about.length);
  });

  it('leaves out, and says, the utterances no topic covers when no topic of the agent declines them', () => {
    const result = written(agentTestCases(input({ choice: choice({ guardTopic: null }) })));
    expect(result.leftOut.map((l) => [l.test, l.reason])).toEqual(
      RETAIL_ORDERS_PACK.outOfScope.map((_, i) => [`retail-orders-out-${i + 1}`, 'no-guard-topic']),
    );
  });

  it('refuses an agent the org has not, naming it', () => {
    expect(agentTestCases(input({ choice: choice({ agent: 'Sales_Agent' }) }))).toEqual({
      ok: false,
      refusals: [
        {
          code: 'agent-absent',
          name: 'Sales_Agent',
          message: '"Sales_Agent" is not one of this org\'s agents',
        },
      ],
    });
  });

  it('refuses every name the catalog does not hold, each named, all at once', () => {
    const topics = choice().topics.map((match) =>
      match.packTopic === 'refund'
        ? { ...match, agentTopic: 'Refunds' }
        : match.packTopic === 'late-delivery'
          ? { ...match, actions: ['Track_Parcel', 'Cancel_Order', 'Answer_With_Knowledge'] }
          : match,
    );
    const result = agentTestCases(input({ choice: choice({ topics, guardTopic: 'Small_Talk' }) }));
    expect(result).toEqual({
      ok: false,
      refusals: [
        {
          code: 'topic-absent',
          name: 'Refunds',
          message: '"Refunds" is not a topic of the agent Retail_Service_Agent',
        },
        {
          code: 'action-absent',
          name: 'Cancel_Order',
          message: '"Cancel_Order" is not an action of the agent Retail_Service_Agent',
        },
        {
          code: 'action-not-of-topic',
          name: 'Answer_With_Knowledge',
          message:
            '"Answer_With_Knowledge" is not an action of the topic Delivery, which the agent answers ' +
            '"late-delivery" from',
        },
        {
          code: 'topic-absent',
          name: 'Small_Talk',
          message: '"Small_Talk" is not a topic of the agent Retail_Service_Agent',
        },
      ],
    });
  });

  it('refuses a topic of the scenario left unmatched, and one the scenario has not, naming each', () => {
    const topics = [
      ...choice().topics.filter((match) => match.packTopic !== 'warranty'),
      { packTopic: 'returns', agentTopic: 'Order_Issues', actions: [] },
    ];
    const result = agentTestCases(input({ choice: choice({ topics }) }));
    expect(result.ok === false && result.refusals.map((r) => [r.code, r.name])).toEqual([
      ['pack-topic-unknown', 'returns'],
      ['pack-topic-unmatched', 'warranty'],
    ]);
  });

  it('refuses a choice the page could not have sent, with the field', () => {
    const result = agentTestCases(input({ choice: { ...choice(), runner: 'studio' } }));
    expect(result.ok === false && result.refusals.map((r) => [r.code, r.name])).toEqual([
      ['choice-invalid', 'runner'],
    ]);
  });

  it('refuses to write a file of no test, saying why each was left out', () => {
    const result = agentTestCases(input({ openCaseIds: {}, choice: choice({ guardTopic: null }) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ code: 'no-test-left', name: 'retail-orders' });
    expect(result.refusals[0].message).toContain('was not written by the run');
    expect(result.refusals[0].message).toContain('no topic of the agent is chosen to decline it');
  });
});
