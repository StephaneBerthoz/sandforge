/**
 * What a scenario's seed reads of its org before it writes, read only, the
 * panel's and the command line's alike: the statuses the org files an open
 * case and a closed one under, what its Knowledge articles can hold, and the
 * Case picklist values a draft is told. Then the pack compiled with them,
 * which is the template the run writes.
 *
 * A pack names no status of its own: a closed case written "Closed" into an
 * org whose closed status is another word is an open case under a status the
 * org's picklist does not have, and the agent asked about the customer's
 * history finds it unresolved. The org's own words are read off `CaseStatus`,
 * whose rows say which are closed, and the defaults of a new org stand only
 * where the org will not say, and the preparation says so.
 */

import type {
  ScenarioCasePicklists,
  ScenarioPack,
  SeedScenarioKnowledge,
  SeedScenarioPreparation,
} from '@sandforge/shared';
import { SCENARIO_COMPILE_DEFAULTS } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage';
import type { SeedObjectAccess } from '../SeedOrchestrator';
import type { CatalogQuery } from '../../agentforce/agentCatalog';
import { compileScenario, ScenarioCompileError } from './compileScenario';

/** Every row a query selects, its pages read. */
export type ScenarioQuery = (soql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * The statuses of the org's cases, the ones a case is closed by marked, in
 * the org's order. `ApiName` is what a case's `Status` is written with; an
 * org that will not select it is read again by label, which a status keeps
 * as its value unless an administrator renamed one of the two.
 */
export const CASE_STATUS_SOQL =
  'SELECT ApiName, MasterLabel, IsClosed, IsDefault, SortOrder FROM CaseStatus ORDER BY SortOrder';

/** {@link CASE_STATUS_SOQL} without `ApiName`. */
export const CASE_STATUS_BY_LABEL_SOQL =
  'SELECT MasterLabel, IsClosed, IsDefault, SortOrder FROM CaseStatus ORDER BY SortOrder';

/** The status a closed case is written with when the org has it among its closed ones. */
const CLOSED = 'Closed';

/** The statuses an open case and a closed one are written with, and whose they are. */
export type ScenarioCaseStatus = {
  open: string;
  closed: string;
} & SeedScenarioPreparation['caseStatusFrom'];

/**
 * The org's open and closed statuses: an open case under its default status
 * when that one is open, else under its first open one; a closed case under
 * "Closed" when that is one of its closed statuses, else under its first
 * closed one. Never throws: an org that will not say is given a new org's
 * statuses, with why.
 */
export async function readScenarioCaseStatus(query: ScenarioQuery): Promise<ScenarioCaseStatus> {
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await query(CASE_STATUS_SOQL);
  } catch {
    try {
      rows = await query(CASE_STATUS_BY_LABEL_SOQL);
    } catch (err: unknown) {
      return byDefault(`the org would not read its case statuses: ${extractErrorMessage(err)}`);
    }
  }
  const statuses = rows.flatMap((row) => {
    const value = text(row.ApiName) ?? text(row.MasterLabel);
    return value === undefined
      ? []
      : [{ value, closed: row.IsClosed === true, isDefault: row.IsDefault === true }];
  });
  const open = statuses.filter((status) => !status.closed);
  const closed = statuses.filter((status) => status.closed);
  if (open.length === 0 || closed.length === 0) {
    return byDefault(
      open.length === 0
        ? 'the org has no case status that leaves a case open'
        : 'the org has no case status that closes a case',
    );
  }
  return {
    open: (open.find((status) => status.isDefault) ?? open[0]).value,
    closed: (closed.find((status) => status.value === CLOSED) ?? closed[0]).value,
    from: 'org',
  };
}

/** A new org's statuses, and why the org's own could not be told. */
function byDefault(reason: string): ScenarioCaseStatus {
  return { ...SCENARIO_COMPILE_DEFAULTS.caseStatus, from: 'default', reason };
}

/** A text of a row, when it holds one. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The object a scenario's articles are written to. */
export const ARTICLE_OBJECT = 'Knowledge__kav';

/**
 * Whether a scenario's articles are published once written, closed to every
 * channel, and each closed case linked to the article of its topic
 * (`CompiledScenario.closedCaseArticles`, through `CaseArticle`). Not yet:
 * how an org with Knowledge answers — whether an article the API creates is
 * a draft, which fields an activation gives it, whether a published one can
 * be deleted, whether a link outlives its case — waits on probes P1 to P3 of
 * an org with Knowledge on. Until then the articles stay as the API writes
 * them, and the page and the command line say so: an agent's data library
 * indexes published articles. The publication goes where this is read, after
 * the run has written its articles and before its companion file is kept.
 */
export const SCENARIO_ARTICLES_PUBLISHED = false;

/** A field of an object as its describe gives it, of what is read here. */
export interface ScenarioDescribedField {
  name: string;
  type: string;
  length?: number;
  createable?: boolean;
  /** `richtextarea`, `plaintextarea`: what a `textarea` is. */
  extraTypeInfo?: string | null;
  picklistValues?: ReadonlyArray<{ value: string; active?: boolean }> | null;
}

/** What a describe of an object answers, of what is read here. */
export type ScenarioDescribe = (
  objectApiName: string,
) => Promise<{ fields: readonly ScenarioDescribedField[] }>;

/**
 * Fields of an article a body is not written to: those the article is
 * written with already, and its summary, which the article's summary takes.
 */
const NOT_A_BODY: ReadonlySet<string> = new Set([
  'Title',
  'UrlName',
  'Summary',
  'Language',
  'IsVisibleInPkb',
  'IsVisibleInCsp',
  'IsVisibleInPrm',
]);

/** A text area shorter than this is no body: a body runs to thousands of characters. */
const SHORTEST_BODY = 1_000;

/**
 * What the org offers a scenario's articles: nothing, without Knowledge —
 * the run then skips them, with why, and stays a success — or the fields of
 * an article a body can be written to, a rich text area first, then the
 * longest. An org whose article describe cannot be read is offered none: the
 * articles are written with their summary alone.
 */
export async function scenarioKnowledge(
  access: (objectApiName: string) => Promise<SeedObjectAccess>,
  describe: ScenarioDescribe,
): Promise<SeedScenarioKnowledge> {
  let answer: SeedObjectAccess;
  try {
    answer = await access(ARTICLE_OBJECT);
  } catch {
    answer = { access: 'createable' };
  }
  if (answer.access === 'absent') {
    return {
      available: false,
      reason: answer.reason ?? `the org has no ${ARTICLE_OBJECT}`,
    };
  }
  if (answer.access === 'readOnly') {
    return {
      available: false,
      reason:
        answer.reason ?? `the user this seed runs as may read ${ARTICLE_OBJECT} and not create it`,
    };
  }
  let fields: readonly ScenarioDescribedField[];
  try {
    fields = (await describe(ARTICLE_OBJECT)).fields;
  } catch {
    return { available: true, bodyFields: [] };
  }
  const bodies = fields
    .filter(
      (field) =>
        field.createable === true &&
        field.type === 'textarea' &&
        !NOT_A_BODY.has(field.name) &&
        (field.extraTypeInfo === 'richtextarea' || (field.length ?? 0) >= SHORTEST_BODY),
    )
    .sort(
      (a, b) =>
        Number(b.extraTypeInfo === 'richtextarea') - Number(a.extraTypeInfo === 'richtextarea') ||
        (b.length ?? 0) - (a.length ?? 0) ||
        a.name.localeCompare(b.name),
    );
  return { available: true, bodyFields: bodies.map((field) => field.name) };
}

/** The Case picklists a draft is told the values of. */
const DRAFT_PICKLISTS = ['Status', 'Origin', 'Priority', 'Type'] as const;

/**
 * The active values of the org's Case `Status`, `Origin`, `Priority` and
 * `Type`, in the org's order: the words its cases are written with, and the
 * only words of the org a draft is told. Undefined when Case cannot be described.
 */
export async function scenarioCasePicklists(
  describe: ScenarioDescribe,
): Promise<ScenarioCasePicklists | undefined> {
  let fields: readonly ScenarioDescribedField[];
  try {
    fields = (await describe('Case')).fields;
  } catch {
    return undefined;
  }
  const picklists: ScenarioCasePicklists = {};
  for (const name of DRAFT_PICKLISTS) {
    const field = fields.find((f) => f.name === name);
    const values = (field?.picklistValues ?? [])
      .filter((entry) => entry.active !== false)
      .map((entry) => entry.value);
    if (values.length > 0) picklists[name] = values;
  }
  return picklists;
}

/** What a pack is compiled for an org with, read of the org. */
export interface ScenarioPreparationInput {
  caseStatus: ScenarioCaseStatus;
  knowledge: SeedScenarioKnowledge;
  /** The seed asked for; the default one when absent. */
  seed?: number;
  /** The article field asked for the body; the first the org offers when absent. */
  articleBodyField?: string;
}

/**
 * The pack compiled for an org: the options the run is sent with, the org's
 * statuses and article field among them, and what it writes; or every issue
 * of the pack, and of a body field the org does not offer, before anything.
 */
export function prepareScenario(
  pack: ScenarioPack,
  input: ScenarioPreparationInput,
): { preparation: SeedScenarioPreparation } | { issues: string[] } {
  const { knowledge } = input;
  const offered = knowledge.available ? knowledge.bodyFields : [];
  if (input.articleBodyField !== undefined && !offered.includes(input.articleBodyField)) {
    return {
      issues: [
        `options.articleBodyField: ${input.articleBodyField} is not a field of ${ARTICLE_OBJECT} ` +
          `this org lets a body be written to` +
          (offered.length > 0 ? ` (${offered.join(', ')})` : ''),
      ],
    };
  }
  const articleBodyField = input.articleBodyField ?? offered[0];
  const options: SeedScenarioPreparation['options'] = {
    seed: input.seed ?? SCENARIO_COMPILE_DEFAULTS.seed,
    caseStatus: { open: input.caseStatus.open, closed: input.caseStatus.closed },
    ...(articleBodyField !== undefined ? { articleBodyField } : {}),
  };
  let compiled: ReturnType<typeof compileScenario>;
  try {
    compiled = compileScenario(pack, options);
  } catch (err: unknown) {
    if (err instanceof ScenarioCompileError) return { issues: err.issues };
    throw err;
  }
  return {
    preparation: {
      options,
      objects: [...compiled.template.objects]
        .sort((a, b) => a.insertOrder - b.insertOrder)
        .map((object) => ({
          objectApiName: object.objectApiName,
          recordCount: object.recordCount,
          ...(object.optional === true ? { optional: true } : {}),
        })),
      tests: compiled.tests.length,
      caseStatusFrom:
        input.caseStatus.from === 'org'
          ? { from: 'org' }
          : { from: 'default', reason: input.caseStatus.reason },
      knowledge,
    },
  };
}

/** A page of a query's answer. */
export interface QueryPage {
  records: Array<Record<string, unknown>>;
  done: boolean;
  nextRecordsUrl?: string;
}

/** The Tooling API's query and its next pages, as a connection reads them. */
export interface ToolingQueries {
  query: (soql: string) => Promise<QueryPage>;
  queryMore: (url: string) => Promise<QueryPage>;
}

/**
 * A query of the Tooling API that reads every page: what an agent's catalog
 * is read through (`AGENT_CATALOG_API`).
 */
export function toolingQueryAll(tooling: ToolingQueries): CatalogQuery {
  return async (soql) => {
    let answer = await tooling.query(soql);
    const rows = [...answer.records];
    while (!answer.done && answer.nextRecordsUrl) {
      answer = await tooling.queryMore(answer.nextRecordsUrl);
      rows.push(...answer.records);
    }
    return rows;
  };
}
