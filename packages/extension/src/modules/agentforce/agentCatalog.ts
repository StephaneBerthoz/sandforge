/**
 * What an org says its Agentforce agents are made of: each agent, the topics
 * it routes to, the actions each topic can take, and the variables it
 * declares. A test file names them, and a name the org does not have is a
 * test that fails on its first line, so they are read from the org and never
 * written from what a topic of a scenario is called.
 *
 * Read by SOQL alone, from the catalog objects every org with Agentforce has
 * (`GenAiPlannerDefinition`, `GenAiPlannerFunctionDef`, `GenAiPluginDefinition`,
 * `GenAiPluginFunctionDef`, `GenAiFunctionDefinition`,
 * `GenAiPlannerAttrDefinition`), through a query the caller hands over. No
 * metadata is retrieved: a retrieve writes into the user's project, and the
 * page only needs names.
 *
 * Read on two Developer Editions with Agentforce, all six objects were there
 * and empty; on a scratch org without Agentforce, none was. Both say there is
 * no agent, with why, and neither throws: the seed writes its records all the
 * same, and the file is written once the org has an agent.
 */

import * as z from 'zod';
import type {
  AgentAction,
  AgentCatalog,
  AgentDefinition,
  AgentTopic,
  AgentVariable,
} from '@sandforge/shared';
import { extractErrorCode, extractErrorMessage } from '../../core/common/extractErrorMessage';
import { isSalesforceId } from '../../core/common/salesforceId';

/** Every row a SOQL query selects, all its pages read. */
export type CatalogQuery = (soql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * The API the catalog is read through: the Tooling API, which the Salesforce
 * CLI reads these objects through when it resolves an agent's metadata
 * (`@salesforce/source-deploy-retrieve`, `agentResolver.js`) and checks a
 * topic's or an action's name (`plugin-agent`, `agent generate template`).
 * The data API describes them too: read through it, the two Developer
 * Editions answered the same, with no rows.
 */
export const AGENT_CATALOG_API = 'tooling' as const;

/**
 * The fields read of each object. `Id`, `DeveloperName`, the planner's
 * topics by `PlannerId` and `Plugin`, are the fields the CLI selects itself.
 * `LocalDeveloperName`, `ParentId` and `ParameterName` are fields the
 * objects' describe lists. `MasterLabel`, `Description`, and `PluginId` and
 * `Function` of a topic's actions are named as the objects' metadata names
 * them (`GenAiPlugin`, `GenAiFunction`), not yet read from an org with an
 * agent: a field an org does not have is refused by name, and that refusal
 * is what the page says.
 */
export const AGENT_CATALOG_FIELDS = {
  GenAiPlannerDefinition: ['Id', 'DeveloperName', 'MasterLabel'],
  GenAiPlannerFunctionDef: ['PlannerId', 'Plugin'],
  GenAiPluginDefinition: [
    'Id',
    'DeveloperName',
    'LocalDeveloperName',
    'MasterLabel',
    'Description',
  ],
  GenAiPluginFunctionDef: ['PluginId', 'Function'],
  GenAiFunctionDefinition: [
    'Id',
    'DeveloperName',
    'LocalDeveloperName',
    'MasterLabel',
    'Description',
  ],
  GenAiPlannerAttrDefinition: ['ParentId', 'DeveloperName', 'ParameterName'],
} as const;

/** An object of the catalog. */
export type AgentCatalogObject = keyof typeof AGENT_CATALOG_FIELDS;

/**
 * The name a test gives a topic or an action: its `DeveloperName`. It is
 * what `sf agent generate test-spec` offers for both — a topic as the
 * `genAiPluginName` of the agent's planner bundle, an action as its
 * `functionName` — and what its help asks for ("Topic API name (DeveloperName
 * from a GenAiPlugin)"). `LocalDeveloperName` is kept beside it, as the org
 * gives it, should a topic of the agent's own copy be named by that one.
 */
export const AGENT_TEST_NAME_FIELD = 'DeveloperName' as const;

/** Ids a query names at most, so that no statement grows past what SOQL takes. */
const IDS_PER_QUERY = 200;

/** How the org answered for its agents. */
export type AgentCatalogRead =
  | { kind: 'agents'; catalog: AgentCatalog }
  /**
   * No agent to write a test for: `none` when the org has Agentforce and no
   * agent in it, `no-agentforce` when it has not even the catalog's objects.
   */
  | { kind: 'no-agent'; reason: 'none' | 'no-agentforce'; message: string }
  /** The org refused a query of the catalog: which object, and its words. */
  | { kind: 'unreadable'; object: AgentCatalogObject; message: string };

/** What the page says of an org with Agentforce and no agent. */
export const NO_AGENT_MESSAGE =
  'This org has no Agentforce agent: create one, then write the test file from this run.';

/** What the page says of an org without Agentforce. */
export const NO_AGENTFORCE_MESSAGE =
  'This org has no Agentforce: it has no GenAiPlannerDefinition, the object that lists its agents.';

/** A text field the org may leave empty. */
const optionalText = z
  .string()
  .nullish()
  .transform((value) =>
    value === null || value === undefined || value === '' ? undefined : value,
  );

const ROW_SCHEMAS = {
  GenAiPlannerDefinition: z.looseObject({
    Id: z.string().min(1),
    DeveloperName: z.string().min(1),
    MasterLabel: optionalText,
  }),
  GenAiPlannerFunctionDef: z.looseObject({
    PlannerId: z.string().min(1),
    Plugin: optionalText,
  }),
  GenAiPluginDefinition: z.looseObject({
    Id: z.string().min(1),
    DeveloperName: z.string().min(1),
    LocalDeveloperName: optionalText,
    MasterLabel: optionalText,
    Description: optionalText,
  }),
  GenAiPluginFunctionDef: z.looseObject({
    PluginId: z.string().min(1),
    Function: optionalText,
  }),
  GenAiFunctionDefinition: z.looseObject({
    Id: z.string().min(1),
    DeveloperName: z.string().min(1),
    LocalDeveloperName: optionalText,
    MasterLabel: optionalText,
    Description: optionalText,
  }),
  GenAiPlannerAttrDefinition: z.looseObject({
    ParentId: z.string().min(1),
    DeveloperName: z.string().min(1),
    ParameterName: optionalText,
  }),
} as const;

type RowOf<O extends AgentCatalogObject> = z.output<(typeof ROW_SCHEMAS)[O]>;

/** A query of the catalog the org refused, carried up to {@link readAgentCatalog}. */
class CatalogRefusal extends Error {
  constructor(
    readonly object: AgentCatalogObject,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogRefusal';
  }
}

/**
 * The org's agents, each with its topics, their actions and its variables;
 * or why there is none to test, or which object the org would not read.
 * Never throws: whatever the org answers is said.
 */
export async function readAgentCatalog(query: CatalogQuery): Promise<AgentCatalogRead> {
  try {
    const planners = await select(query, 'GenAiPlannerDefinition');
    if (planners.length === 0) {
      return { kind: 'no-agent', reason: 'none', message: NO_AGENT_MESSAGE };
    }
    const plannerIds = planners.map((planner) => planner.Id);
    const links = await selectWhereIn(query, 'GenAiPlannerFunctionDef', 'PlannerId', plannerIds);
    const variables = await selectWhereIn(
      query,
      'GenAiPlannerAttrDefinition',
      'ParentId',
      plannerIds,
    );
    // A topic or an action the agent names by a standard name has no row to
    // read: only the references that are ids are read (`selectWhereIn`), and
    // the others are listed by their names (`resolve`).
    const plugins = await selectWhereIn(
      query,
      'GenAiPluginDefinition',
      'Id',
      links.map((link) => link.Plugin),
    );
    const actionLinks = await selectWhereIn(
      query,
      'GenAiPluginFunctionDef',
      'PluginId',
      plugins.map((plugin) => plugin.Id),
    );
    const functions = await selectWhereIn(
      query,
      'GenAiFunctionDefinition',
      'Id',
      actionLinks.map((link) => link.Function),
    );

    const pluginById = byId(plugins);
    const functionById = byId(functions);
    const actionsOf = (pluginId: string): { actions: AgentAction[]; unnamedActions: number } => {
      const named = resolve(
        actionLinks.filter((link) => sameId(link.PluginId, pluginId)).map((link) => link.Function),
        functionById,
      );
      return { actions: named.items, unnamedActions: named.unnamed };
    };

    const agents: AgentDefinition[] = planners
      .map((planner): AgentDefinition => {
        const named = resolve(
          links.filter((link) => sameId(link.PlannerId, planner.Id)).map((link) => link.Plugin),
          pluginById,
        );
        const topics = named.items.map((topic, index): AgentTopic => {
          const row = named.rows[index];
          return row
            ? { ...topic, ...actionsOf(row.Id) }
            : { ...topic, actions: [], unnamedActions: 0 };
        });
        return {
          id: planner.Id,
          name: planner.DeveloperName,
          ...(planner.MasterLabel !== undefined ? { label: planner.MasterLabel } : {}),
          topics,
          unnamedTopics: named.unnamed,
          variables: variables
            .filter((variable) => sameId(variable.ParentId, planner.Id))
            .map((variable): AgentVariable => ({
              name: variable.DeveloperName,
              ...(variable.ParameterName !== undefined
                ? { parameterName: variable.ParameterName }
                : {}),
            })),
        };
      })
      .sort((a, b) => compare(a.name, b.name));
    return { kind: 'agents', catalog: { agents } };
  } catch (err: unknown) {
    if (!(err instanceof CatalogRefusal)) throw err;
    if (err.object === 'GenAiPlannerDefinition' && err.code === 'INVALID_TYPE') {
      return { kind: 'no-agent', reason: 'no-agentforce', message: NO_AGENTFORCE_MESSAGE };
    }
    return {
      kind: 'unreadable',
      object: err.object,
      message: `The org would not read ${err.object}: ${err.message}`,
    };
  }
}

/** The agent of the catalog by its API name. */
export function agentNamed(catalog: AgentCatalog, name: string): AgentDefinition | undefined {
  return catalog.agents.find((agent) => agent.name === name);
}

/**
 * The actions SandForge proposes for a topic of the agent: those the agent
 * attaches to it, in name order. The user keeps those the utterances should
 * make the agent take; none is written unless kept.
 */
export function proposedActions(agent: AgentDefinition, topicName: string): string[] {
  return agent.topics.find((topic) => topic.name === topicName)?.actions.map((a) => a.name) ?? [];
}

/**
 * The names of the topic a new service agent declines what it does not cover
 * with: offered as the topic of the utterances no topic of a scenario covers,
 * for the user to keep or change. No org with an agent has been read yet to
 * name it; an agent with none of these leaves the choice to the user.
 */
export const GUARD_TOPIC_NAMES: readonly string[] = ['Off_Topic'];

/** The agent's topic proposed for what no topic covers, by {@link GUARD_TOPIC_NAMES}. */
export function proposedGuardTopic(agent: AgentDefinition): string | undefined {
  return agent.topics.find(
    (topic) =>
      GUARD_TOPIC_NAMES.includes(topic.name) || GUARD_TOPIC_NAMES.includes(topic.localName ?? ''),
  )?.name;
}

/** Whether the agent declares a variable of that name, as its `DeveloperName` or its `ParameterName`. */
export function declaresVariable(agent: AgentDefinition, name: string): boolean {
  return agent.variables.some(
    (variable) => variable.name === name || variable.parameterName === name,
  );
}

/** Every row of an object, parsed; a row the schema refuses is a refusal of the object. */
async function select<O extends AgentCatalogObject>(
  query: CatalogQuery,
  object: O,
  where?: string,
): Promise<RowOf<O>[]> {
  const soql = `SELECT ${AGENT_CATALOG_FIELDS[object].join(', ')} FROM ${object}${where ? ` WHERE ${where}` : ''}`;
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await query(soql);
  } catch (err: unknown) {
    const message = extractErrorMessage(err);
    throw new CatalogRefusal(object, codeOf(err) ?? extractErrorCode(message), message);
  }
  const schema = ROW_SCHEMAS[object];
  return rows.map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CatalogRefusal(
        object,
        undefined,
        `a row has no ${issue.path.join('.')} the catalog can read (${issue.message})`,
      );
    }
    return parsed.data as RowOf<O>;
  });
}

/**
 * The rows of an object whose `field` is one of the ids among `refs`, a
 * query per {@link IDS_PER_QUERY} ids. Ids alone are written into a
 * statement, each checked as one first: a reference that is no id — a
 * standard name, which the CLI leaves out of the ids it reads the same way —
 * is no value to write into SOQL.
 */
async function selectWhereIn<O extends AgentCatalogObject>(
  query: CatalogQuery,
  object: O,
  field: string,
  refs: ReadonlyArray<string | undefined>,
): Promise<RowOf<O>[]> {
  const valid = [
    ...new Set(refs.filter((ref): ref is string => ref !== undefined && isSalesforceId(ref))),
  ];
  const rows: RowOf<O>[] = [];
  for (let from = 0; from < valid.length; from += IDS_PER_QUERY) {
    const list = valid.slice(from, from + IDS_PER_QUERY).map((id) => `'${id}'`);
    rows.push(...(await select(query, object, `${field} IN (${list.join(', ')})`)));
  }
  return rows;
}

/** The error code jsforce puts on what it throws, when it puts one. */
function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { errorCode, name } = err as { errorCode?: unknown; name?: unknown };
  if (typeof errorCode === 'string' && errorCode !== '') return errorCode;
  if (typeof name === 'string' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return name;
  return undefined;
}

/** An id as two answers compare it: its fifteen case-sensitive characters, whichever form it came in. */
function idKey(id: string): string {
  return id.slice(0, 15);
}

function sameId(a: string, b: string): boolean {
  return idKey(a) === idKey(b);
}

function byId<R extends { Id: string }>(rows: readonly R[]): Map<string, R> {
  return new Map(rows.map((row) => [idKey(row.Id), row]));
}

/** A row of a topic or an action, as both objects give one. */
interface NamedRow {
  Id: string;
  DeveloperName: string;
  LocalDeveloperName?: string;
  MasterLabel?: string;
  Description?: string;
}

/**
 * The topics or the actions a link's references name, each once, in name
 * order, with the row each was read from, if any. A reference to a row the
 * org does describe is named as the row names it; one that is no id is a
 * standard name, listed as it is. An id with no row to read is counted, not
 * named: the CLI meets such ids too — its query of `GenAiPluginDefinition`
 * "returns customized plugins only" (`agentResolver.js`) — and an id is no
 * name a test can expect.
 */
function resolve<R extends NamedRow>(
  refs: ReadonlyArray<string | undefined>,
  rowsById: ReadonlyMap<string, R>,
): { items: AgentAction[]; rows: Array<R | undefined>; unnamed: number } {
  const found = new Map<string, { item: AgentAction; row?: R }>();
  let unnamed = 0;
  for (const ref of refs) {
    if (ref === undefined) continue;
    if (!isSalesforceId(ref)) {
      if (!found.has(ref)) found.set(ref, { item: { name: ref, described: false } });
      continue;
    }
    const row = rowsById.get(idKey(ref));
    if (!row) {
      unnamed++;
      continue;
    }
    const name = row[AGENT_TEST_NAME_FIELD];
    if (found.has(name)) continue;
    found.set(name, {
      row,
      item: {
        name,
        ...(row.LocalDeveloperName !== undefined ? { localName: row.LocalDeveloperName } : {}),
        ...(row.MasterLabel !== undefined ? { label: row.MasterLabel } : {}),
        ...(row.Description !== undefined ? { description: row.Description } : {}),
        described: true,
      },
    });
  }
  const sorted = [...found.values()].sort((a, b) => compare(a.item.name, b.item.name));
  return { items: sorted.map((s) => s.item), rows: sorted.map((s) => s.row), unnamed };
}

/** Two names in code-point order: the same on every machine, whatever its locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
