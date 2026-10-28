import { describe, it, expect } from 'vitest';
import { to18 } from '../../core/common/salesforceId';
import {
  AGENT_CATALOG_FIELDS,
  NO_AGENT_MESSAGE,
  NO_AGENTFORCE_MESSAGE,
  agentNamed,
  declaresVariable,
  proposedActions,
  proposedGuardTopic,
  readAgentCatalog,
  type AgentCatalogObject,
  type CatalogQuery,
} from './agentCatalog';

type Row = Record<string, unknown>;

/** An error as jsforce throws one for an org's refusal: its code on `name` and `errorCode`. */
function orgError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: errorCode, errorCode });
}

/**
 * An org's catalog objects, answering the statements the reader sends as the
 * org would: the fields an object has, the rows a `WHERE <field> IN (...)`
 * selects — an id compared by its fifteen characters, whichever form it is
 * written in — and the refusals of an object it has not or of a field it has
 * not, in the org's words.
 */
function fakeOrg(
  tables: Partial<Record<AgentCatalogObject, Row[]>>,
  options: { fields?: Partial<Record<AgentCatalogObject, readonly string[]>> } = {},
): { query: CatalogQuery; statements: string[] } {
  const statements: string[] = [];
  const query: CatalogQuery = async (soql) => {
    statements.push(soql);
    const parsed = /^SELECT (.+) FROM (\w+)(?: WHERE (\w+) IN \((.*)\))?$/.exec(soql);
    if (!parsed) throw orgError('MALFORMED_QUERY', `unexpected statement: ${soql}`);
    const [, fieldList, object, whereField, list] = parsed;
    const table = tables[object as AgentCatalogObject];
    if (!table) throw orgError('INVALID_TYPE', `sObject type '${object}' is not supported.`);
    const fields = fieldList.split(', ');
    const has =
      options.fields?.[object as AgentCatalogObject] ??
      AGENT_CATALOG_FIELDS[object as AgentCatalogObject];
    const missing = fields.find((field) => !has.includes(field));
    if (missing) {
      throw orgError('INVALID_FIELD', `No such column '${missing}' on entity '${object}'.`);
    }
    const wanted = list?.split(', ').map((quoted) => quoted.slice(1, -1).slice(0, 15));
    return table
      .filter((row) => !whereField || wanted?.includes(String(row[whereField]).slice(0, 15)))
      .map((row) => ({
        attributes: { type: object },
        ...Object.fromEntries(fields.map((field) => [field, row[field] ?? null])),
      }));
  };
  return { query, statements };
}

const AGENT = '16j000000000001';
const OTHER_AGENT = '16j000000000002';
const ORDERS = '179000000000001';
const BILLING = '179000000000002';
const UNDESCRIBED = '179000000000009';
const LOOKUP = '172000000000001';
const ANSWER = '172000000000002';
const REFUND = '172000000000003';

/** Two agents: one with two topics of its own, a standard one and one the org gives no row for. */
function catalogTables(): Partial<Record<AgentCatalogObject, Row[]>> {
  return {
    GenAiPlannerDefinition: [
      { Id: to18(OTHER_AGENT), DeveloperName: 'Billing_Agent', MasterLabel: null },
      {
        Id: to18(AGENT),
        DeveloperName: 'Retail_Service_Agent',
        MasterLabel: 'Retail Service Agent',
      },
    ],
    GenAiPlannerFunctionDef: [
      // The link names its topic by an 18-character id, or a 15-character one.
      { PlannerId: to18(AGENT), Plugin: to18(ORDERS) },
      { PlannerId: to18(AGENT), Plugin: BILLING },
      { PlannerId: to18(AGENT), Plugin: 'GeneralFAQ' },
      { PlannerId: to18(AGENT), Plugin: to18(UNDESCRIBED) },
      { PlannerId: to18(OTHER_AGENT), Plugin: to18(BILLING) },
    ],
    GenAiPluginDefinition: [
      {
        Id: to18(ORDERS),
        DeveloperName: 'Order_Issues',
        LocalDeveloperName: 'Order_Issues',
        MasterLabel: 'Order issues',
        Description: 'Damaged parcels, late deliveries and refunds.',
      },
      {
        Id: to18(BILLING),
        DeveloperName: 'Off_Topic',
        LocalDeveloperName: null,
        MasterLabel: 'Off Topic',
      },
    ],
    GenAiPluginFunctionDef: [
      { PluginId: to18(ORDERS), Function: to18(LOOKUP) },
      { PluginId: to18(ORDERS), Function: ANSWER },
      { PluginId: to18(ORDERS), Function: 'EmployeeCopilot__AnswerQuestionsWithKnowledge' },
      { PluginId: to18(ORDERS), Function: to18(LOOKUP) },
      { PluginId: to18(BILLING), Function: to18(REFUND) },
    ],
    GenAiFunctionDefinition: [
      { Id: to18(LOOKUP), DeveloperName: 'Identify_Customer', MasterLabel: 'Identify customer' },
      {
        Id: to18(ANSWER),
        DeveloperName: 'Answer_With_Knowledge',
        Description: 'Answers from articles.',
      },
      { Id: to18(REFUND), DeveloperName: 'Issue_Refund' },
    ],
    GenAiPlannerAttrDefinition: [
      { ParentId: to18(AGENT), DeveloperName: 'CaseId', ParameterName: 'caseId' },
      { ParentId: to18(OTHER_AGENT), DeveloperName: 'RoutableId', ParameterName: null },
    ],
  };
}

describe('readAgentCatalog', () => {
  it('reads each agent with its topics, their actions and its variables, by their API names', async () => {
    const read = await readAgentCatalog(fakeOrg(catalogTables()).query);
    expect(read).toEqual({
      kind: 'agents',
      catalog: {
        agents: [
          {
            id: to18(OTHER_AGENT),
            name: 'Billing_Agent',
            topics: [
              {
                name: 'Off_Topic',
                label: 'Off Topic',
                described: true,
                actions: [{ name: 'Issue_Refund', described: true }],
                unnamedActions: 0,
              },
            ],
            unnamedTopics: 0,
            variables: [{ name: 'RoutableId' }],
          },
          {
            id: to18(AGENT),
            name: 'Retail_Service_Agent',
            label: 'Retail Service Agent',
            topics: [
              { name: 'GeneralFAQ', described: false, actions: [], unnamedActions: 0 },
              {
                name: 'Off_Topic',
                label: 'Off Topic',
                described: true,
                actions: [{ name: 'Issue_Refund', described: true }],
                unnamedActions: 0,
              },
              {
                name: 'Order_Issues',
                localName: 'Order_Issues',
                label: 'Order issues',
                description: 'Damaged parcels, late deliveries and refunds.',
                described: true,
                actions: [
                  {
                    name: 'Answer_With_Knowledge',
                    description: 'Answers from articles.',
                    described: true,
                  },
                  {
                    name: 'EmployeeCopilot__AnswerQuestionsWithKnowledge',
                    described: false,
                  },
                  { name: 'Identify_Customer', label: 'Identify customer', described: true },
                ],
                unnamedActions: 0,
              },
            ],
            unnamedTopics: 1,
            variables: [{ name: 'CaseId', parameterName: 'caseId' }],
          },
        ],
      },
    });
  });

  it('selects the fields it names of each object, and filters every object after the agents by the ids read', async () => {
    const org = fakeOrg(catalogTables());
    await readAgentCatalog(org.query);
    expect(org.statements.map((soql) => soql.replace(/ WHERE .*/, ''))).toEqual([
      `SELECT ${AGENT_CATALOG_FIELDS.GenAiPlannerDefinition.join(', ')} FROM GenAiPlannerDefinition`,
      `SELECT ${AGENT_CATALOG_FIELDS.GenAiPlannerFunctionDef.join(', ')} FROM GenAiPlannerFunctionDef`,
      `SELECT ${AGENT_CATALOG_FIELDS.GenAiPlannerAttrDefinition.join(', ')} FROM GenAiPlannerAttrDefinition`,
      `SELECT ${AGENT_CATALOG_FIELDS.GenAiPluginDefinition.join(', ')} FROM GenAiPluginDefinition`,
      `SELECT ${AGENT_CATALOG_FIELDS.GenAiPluginFunctionDef.join(', ')} FROM GenAiPluginFunctionDef`,
      `SELECT ${AGENT_CATALOG_FIELDS.GenAiFunctionDefinition.join(', ')} FROM GenAiFunctionDefinition`,
    ]);
    expect(org.statements[1]).toMatch(/ WHERE PlannerId IN \('16j\w{15}', '16j\w{15}'\)$/);
  });

  it('answers no agent, said, for an org with Agentforce and no agent, reading nothing more', async () => {
    const org = fakeOrg({ ...catalogTables(), GenAiPlannerDefinition: [] });
    expect(await readAgentCatalog(org.query)).toEqual({
      kind: 'no-agent',
      reason: 'none',
      message: NO_AGENT_MESSAGE,
    });
    expect(org.statements).toHaveLength(1);
  });

  it('answers no agent, said, for an org that has not the objects of Agentforce', async () => {
    const org = fakeOrg({});
    expect(await readAgentCatalog(org.query)).toEqual({
      kind: 'no-agent',
      reason: 'no-agentforce',
      message: NO_AGENTFORCE_MESSAGE,
    });
  });

  it('names the object and the org words of a query refused for a field the org has not', async () => {
    const org = fakeOrg(catalogTables(), {
      fields: { GenAiPluginFunctionDef: ['Id', 'Function'] },
    });
    expect(await readAgentCatalog(org.query)).toEqual({
      kind: 'unreadable',
      object: 'GenAiPluginFunctionDef',
      message:
        "The org would not read GenAiPluginFunctionDef: INVALID_FIELD: No such column 'PluginId' on " +
        "entity 'GenAiPluginFunctionDef'.",
    });
  });

  it('names the object of a row it cannot read, rather than leaving the row out', async () => {
    const tables = catalogTables();
    tables.GenAiPluginDefinition?.push({ Id: to18('179000000000005'), DeveloperName: null });
    tables.GenAiPlannerFunctionDef?.push({
      PlannerId: to18(AGENT),
      Plugin: to18('179000000000005'),
    });
    const read = await readAgentCatalog(fakeOrg(tables).query);
    expect(read).toEqual({
      kind: 'unreadable',
      object: 'GenAiPluginDefinition',
      message: expect.stringMatching(
        /^The org would not read GenAiPluginDefinition: a row has no DeveloperName/,
      ),
    });
  });

  it('writes ids alone into a statement, never a reference that is not one', async () => {
    const tables = catalogTables();
    tables.GenAiPlannerFunctionDef?.push({ PlannerId: to18(AGENT), Plugin: "x') OR Id != ('" });
    const org = fakeOrg(tables);
    const read = await readAgentCatalog(org.query);
    expect(org.statements.join('\n')).not.toContain('OR Id');
    expect(
      read.kind === 'agents' &&
        agentNamed(read.catalog, 'Retail_Service_Agent')?.topics.map((t) => t.name),
    ).toContain("x') OR Id != ('");
  });

  it('reads the ids of many topics in statements of two hundred ids at most', async () => {
    const tables = catalogTables();
    const many = Array.from({ length: 450 }, (_, i) => `179${String(i + 100).padStart(12, '0')}`);
    tables.GenAiPlannerFunctionDef = many.map((id) => ({
      PlannerId: to18(AGENT),
      Plugin: to18(id),
    }));
    tables.GenAiPluginDefinition = many.map((id, i) => ({
      Id: to18(id),
      DeveloperName: `Topic_${i}`,
    }));
    const org = fakeOrg(tables);
    const read = await readAgentCatalog(org.query);
    const pluginStatements = org.statements.filter((s) => s.includes('FROM GenAiPluginDefinition'));
    expect(pluginStatements.map((s) => (s.match(/'/g)?.length ?? 0) / 2)).toEqual([200, 200, 50]);
    expect(
      read.kind === 'agents' && agentNamed(read.catalog, 'Retail_Service_Agent')?.topics,
    ).toHaveLength(450);
  });

  it('says what it cannot tell of an error that carries no code, as the org worded it', async () => {
    const read = await readAgentCatalog(async () => {
      throw new Error('socket hang up');
    });
    expect(read).toEqual({
      kind: 'unreadable',
      object: 'GenAiPlannerDefinition',
      message: 'The org would not read GenAiPlannerDefinition: socket hang up',
    });
  });
});

describe('the proposals of a catalog', () => {
  async function retailAgent() {
    const read = await readAgentCatalog(fakeOrg(catalogTables()).query);
    if (read.kind !== 'agents') throw new Error(read.kind);
    const agent = agentNamed(read.catalog, 'Retail_Service_Agent');
    if (!agent) throw new Error('no agent');
    return agent;
  }

  it('proposes for a topic the actions the agent attaches to it, and none for a topic it has not', async () => {
    const agent = await retailAgent();
    expect(proposedActions(agent, 'Order_Issues')).toEqual([
      'Answer_With_Knowledge',
      'EmployeeCopilot__AnswerQuestionsWithKnowledge',
      'Identify_Customer',
    ]);
    expect(proposedActions(agent, 'Shipping')).toEqual([]);
  });

  it('proposes the topic named as a new service agent declines with, by its name or its local name', async () => {
    const agent = await retailAgent();
    expect(proposedGuardTopic(agent)).toBe('Off_Topic');
    const renamed = {
      ...agent,
      topics: agent.topics.map((t) =>
        t.name === 'Off_Topic'
          ? { ...t, name: 'Off_Topic_16j000000000001', localName: 'Off_Topic' }
          : t,
      ),
    };
    expect(proposedGuardTopic(renamed)).toBe('Off_Topic_16j000000000001');
    expect(
      proposedGuardTopic({ ...agent, topics: agent.topics.filter((t) => t.name !== 'Off_Topic') }),
    ).toBe(undefined);
  });

  it('tells a variable the agent declares by its name or its parameter name', async () => {
    const agent = await retailAgent();
    expect(declaresVariable(agent, 'CaseId')).toBe(true);
    expect(declaresVariable(agent, 'caseId')).toBe(true);
    expect(declaresVariable(agent, 'RoutableId')).toBe(false);
  });
});
