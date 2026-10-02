/**
 * TargetAutomationReader reads, before a Forge run writes, what the target org
 * runs on the objects the run writes: its active record-triggered flows, its
 * active Apex triggers, and the custom permissions a flow's start condition
 * names.
 *
 * Run for real into a sandbox, a clone fired the target's record-triggered
 * flows on every record it created — on one object, flows that send an email
 * or a text message on creation — and nothing said so before the run. That
 * org kept its flows from starting for the users who held a custom permission,
 * `NOT({!$Permission.<name>})` in the start condition: assigned to the user
 * who cloned, it would have kept them quiet.
 *
 * Where each part comes from, as the orgs answered it:
 * - the flows from `FlowDefinitionView` over the regular API, whose
 *   `TriggerObjectOrEvent` names the object as an `EntityDefinition` —
 *   `TriggerObjectOrEventId` is the object's name for a standard one only;
 * - the triggers from `ApexTrigger` over the Tooling API, the one that gives
 *   it an `EntityDefinition`: the regular API's `ApexTrigger` has only
 *   `TableEnumOrId`;
 * - a start condition from the `Metadata` of the flow's active version,
 *   `Flow` over the Tooling API, which the org gives one row per query:
 *   asked for two, it refuses with `MALFORMED_QUERY`. Each costs a request,
 *   so the read takes {@link CONDITIONS_BOUND} at most.
 *
 * A part the org refuses — no access, an API turned off — is said, and the
 * others are read all the same: the read never stops a run.
 */

import type {
  ForgeFlowPermission,
  ForgeFlowStart,
  ForgeFlowTiming,
  ForgeGraph,
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
  ForgeTargetFlow,
  ForgeTargetObjectAutomation,
  ForgeTargetTrigger,
  ForgeTriggerEvent,
} from '@sandforge/shared';
import {
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_OBJECT,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  STATUS_NEEDS_CHILDREN,
  automationByWrite,
  bypassPermissionsOf,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryAllPages, type PagedQuerySource } from './queryAllPages.js';
import { resolveStageConfig } from './stages/ForgeStageConfig.js';
import { PRODUCT_OBJECT, catalogBeyond } from './stages/ScopeResolver.js';

/** What a query answered: the records of every page, and the requests that took. */
export interface QueryAnswer {
  records: Array<Record<string, unknown>>;
  requests: number;
}

/** Dependencies for {@link TargetAutomationReader}. */
export interface TargetAutomationDeps {
  /** A SOQL query on the regular API of an org, every page of it. */
  query: (orgId: string, soql: string) => Promise<QueryAnswer>;
  /** A SOQL query on the Tooling API of an org, every page of it. */
  toolingQuery: (orgId: string, soql: string) => Promise<QueryAnswer>;
}

/**
 * Every page of `soql` from a connection, or from its Tooling API, and the
 * requests that took: one a page.
 */
export async function answerOf(
  source: PagedQuerySource<Record<string, unknown>>,
  soql: string,
): Promise<QueryAnswer> {
  const { records, pages } = await queryAllPages(source, soql);
  return { records, requests: pages };
}

/**
 * The most start conditions a read reads. The org gives a flow's metadata one
 * row per request; an org that runs many flows on the objects of a clone
 * would otherwise cost as many requests before Review shows anything.
 */
export const CONDITIONS_BOUND = 25;

/**
 * Start conditions read at a time. Review compares the two orgs' metadata at
 * the same moment, two describes at a time: four more keep the target under
 * the six requests a Forge pass keeps in flight against an org
 * (`CONCURRENT_DESCRIBE_LIMIT`).
 */
const CONDITIONS_IN_FLIGHT = 4;

/** The active record-triggered flows of an org, every object's. */
export const FLOWS_SOQL =
  'SELECT ApiName, Label, TriggerType, RecordTriggerType, TriggerObjectOrEvent.QualifiedApiName, ' +
  'ActiveVersionId FROM FlowDefinitionView WHERE IsActive = true ' +
  "AND TriggerType IN ('RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete')";

/** The active Apex triggers of an org, every object's, with the events each runs on. */
export const TRIGGERS_SOQL =
  'SELECT Name, NamespacePrefix, TableEnumOrId, EntityDefinition.QualifiedApiName, ' +
  'UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, ' +
  "UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger WHERE Status = 'Active'";

/** The metadata of one version of a flow: the only way the org gives its start condition. */
export function conditionSoql(versionId: string): string {
  return `SELECT Metadata FROM Flow WHERE Id = '${versionId}'`;
}

/** A 15- or 18-character Salesforce id, as a flow version's must be before it goes in a query. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

const TIMINGS: Readonly<Record<string, ForgeFlowTiming>> = {
  RecordBeforeSave: 'beforeSave',
  RecordAfterSave: 'afterSave',
  RecordBeforeDelete: 'beforeDelete',
};

const STARTS: Readonly<Record<string, ForgeFlowStart>> = {
  Create: 'create',
  Update: 'update',
  CreateAndUpdate: 'createAndUpdate',
  Delete: 'delete',
};

/** Each event of a trigger, by the `Usage…` flag that says it runs on it. */
const TRIGGER_EVENT_FLAGS: ReadonlyArray<[string, ForgeTriggerEvent]> = [
  ['UsageBeforeInsert', 'beforeInsert'],
  ['UsageAfterInsert', 'afterInsert'],
  ['UsageBeforeUpdate', 'beforeUpdate'],
  ['UsageAfterUpdate', 'afterUpdate'],
  ['UsageBeforeDelete', 'beforeDelete'],
  ['UsageAfterDelete', 'afterDelete'],
  ['UsageAfterUndelete', 'afterUndelete'],
];

/** A flow as the read holds it before its condition is read: with its object and version. */
interface ReadFlow {
  objectApiName: string;
  versionId: string | null;
  flow: ForgeTargetFlow;
}

/** The API name a relationship to an `EntityDefinition` names, if any. */
function entityName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = (value as { QualifiedApiName?: unknown }).QualifiedApiName;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A flow of `FlowDefinitionView`, or nothing for a row that names no object
 * or no timing the read knows. A save flow whose writes the org does not say
 * is taken as starting on both: said once too often rather than not at all.
 */
function flowOfRow(row: Record<string, unknown>): ReadFlow | undefined {
  const objectApiName = entityName(row.TriggerObjectOrEvent);
  const timing = TIMINGS[text(row.TriggerType)];
  if (!objectApiName || !timing) return undefined;
  const startsOn =
    timing === 'beforeDelete'
      ? 'delete'
      : (STARTS[text(row.RecordTriggerType)] ?? 'createAndUpdate');
  const versionId = text(row.ActiveVersionId);
  return {
    objectApiName,
    versionId: SF_ID_RE.test(versionId) ? versionId : null,
    flow: {
      apiName: text(row.ApiName),
      label: text(row.Label) || text(row.ApiName),
      timing,
      startsOn,
      condition: 'notRead',
      permissions: [],
    },
  };
}

/** A trigger of `ApexTrigger`, with its object, or nothing for a row that names neither. */
function triggerOfRow(
  row: Record<string, unknown>,
): { objectApiName: string; trigger: ForgeTargetTrigger } | undefined {
  const objectApiName = entityName(row.EntityDefinition) ?? (text(row.TableEnumOrId) || undefined);
  const name = text(row.Name);
  if (!objectApiName || !name) return undefined;
  const namespace = text(row.NamespacePrefix);
  return {
    objectApiName,
    trigger: {
      name: namespace ? `${namespace}.${name}` : name,
      events: TRIGGER_EVENT_FLAGS.filter(([flag]) => row[flag] === true).map(([, event]) => event),
    },
  };
}

/**
 * The order start conditions are read in, so the bound leaves out the least
 * telling: the flows after the save of a created record first — those send
 * the emails and the messages — then the ones before it, then the flows of an
 * update, then those of a delete.
 */
function conditionRank(flow: ForgeTargetFlow): number {
  const onInsert = flow.startsOn === 'create' || flow.startsOn === 'createAndUpdate';
  if (onInsert) return flow.timing === 'afterSave' ? 0 : 1;
  return flow.startsOn === 'update' ? 2 : 3;
}

/**
 * The custom permissions a flow's start condition names, each with whether it
 * keeps the flow from starting for the user who holds it.
 *
 * Any `$Permission.<name>` in the start counts as named: in its formula, or as
 * the value of a condition. One is a bypass when the formula requires it not
 * held: negated — `NOT({!$Permission.X})`, alone or among the terms the
 * formula requires together, or `NOT(OR(…))` over permissions — or compared
 * with false. Named any other way — `{!$Permission.X}` alone starts the flow
 * for the users who hold it — assigning it would not keep the flow quiet.
 */
export function permissionsNamed(start: unknown): ForgeFlowPermission[] {
  const named = new Set(
    [...JSON.stringify(start ?? null).matchAll(PERMISSION_NAME)].map((match) => match[1]),
  );
  if (named.size === 0) return [];
  const formula =
    typeof start === 'object' && start !== null
      ? (start as { filterFormula?: unknown }).filterFormula
      : undefined;
  const bypassing = typeof formula === 'string' ? bypassesIn(formula) : new Set<string>();
  return [...named]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, bypass: bypassing.has(name) }));
}

/** `$Permission.<name>` wherever it stands. */
const PERMISSION_NAME = /\$Permission\.([A-Za-z][A-Za-z0-9_]*)/g;

/** A permission as a formula writes it, merge field braces or not; its name captured. */
const PERMISSION_TERM = String.raw`(?:\{!\s*)?\$Permission\.([A-Za-z][A-Za-z0-9_]*)\s*\}?`;

/** A term that is one permission and nothing else. */
const ONE_PERMISSION = new RegExp(`^${PERMISSION_TERM}$`, 'i');

/** One permission after a NOT with no parentheses. */
const BARE_NOT = new RegExp(`^NOT\\s+${PERMISSION_TERM}$`, 'i');

/** A permission compared with a boolean, either way round. */
const COMPARED = new RegExp(
  `^(?:${PERMISSION_TERM}\\s*(==?|<>|!=)\\s*(TRUE|FALSE)|(TRUE|FALSE)\\s*(==?|<>|!=)\\s*${PERMISSION_TERM})$`,
  'i',
);

/** The permissions a formula requires not held, read from the terms it requires together. */
function bypassesIn(formula: string): Set<string> {
  const found = new Set<string>();
  for (const term of conjuncts(formula)) {
    for (const name of negatedPermissions(term)) found.add(name);
  }
  return found;
}

/**
 * The terms a formula requires together: the arguments of a top-level
 * `AND(…)`, the operands of `&&`, each read again the same way.
 */
function conjuncts(expression: string): string[] {
  const term = unwrapped(expression);
  const call = callOf(term, 'AND');
  if (call) return splitTopLevel(call, ',').flatMap(conjuncts);
  const operands = splitTopLevel(term, '&&');
  if (operands.length > 1) return operands.flatMap(conjuncts);
  return [term];
}

/** The names a term keeps from starting the flow when held, none for any other term. */
function negatedPermissions(term: string): string[] {
  const compared = COMPARED.exec(term);
  if (compared) {
    const [, leftName, leftOp, leftValue, rightValue, rightOp, rightName] = compared;
    const name = leftName ?? rightName;
    const op = leftOp ?? rightOp;
    const value = (leftValue ?? rightValue).toUpperCase();
    const negates = op.startsWith('=') ? value === 'FALSE' : value === 'TRUE';
    return negates ? [name] : [];
  }
  const negated = callOf(term, 'NOT');
  if (negated === undefined) {
    // `NOT {!$Permission.X}`, as the condition is sometimes quoted: the
    // platform's NOT takes parentheses, and without them it is read for one
    // permission only.
    const bare = BARE_NOT.exec(term);
    return bare ? [bare[1]] : [];
  }
  const inner = unwrapped(negated);
  const alternatives = callOf(inner, 'OR');
  const terms = alternatives
    ? splitTopLevel(alternatives, ',')
    : splitTopLevel(inner, '||').length > 1
      ? splitTopLevel(inner, '||')
      : [inner];
  const names = terms.map((t) => ONE_PERMISSION.exec(unwrapped(t))?.[1]);
  return names.every((name): name is string => name !== undefined) ? names : [];
}

/** The arguments of `name(…)` when the whole term is that call. */
function callOf(term: string, name: string): string | undefined {
  const match = new RegExp(`^${name}\\s*\\(([\\s\\S]*)\\)$`, 'i').exec(term);
  return match && balanced(match[1]) ? match[1] : undefined;
}

/** The term without the parentheses that wrap the whole of it. */
function unwrapped(expression: string): string {
  let term = expression.trim();
  while (term.startsWith('(') && term.endsWith(')') && balanced(term.slice(1, -1))) {
    term = term.slice(1, -1).trim();
  }
  return term;
}

/** Whether no parenthesis outside a string closes one not opened before it, and all are closed. */
function balanced(expression: string): boolean {
  let depth = 0;
  for (const { char, quoted } of characters(expression)) {
    if (quoted) continue;
    if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** The parts of `expression` between the separators outside any parenthesis or string. */
function splitTopLevel(expression: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (const { char, index, quoted } of characters(expression)) {
    if (quoted) continue;
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && expression.startsWith(separator, index)) {
      parts.push(expression.slice(from, index).trim());
      from = index + separator.length;
    }
  }
  parts.push(expression.slice(from).trim());
  return parts.filter((part) => part !== '');
}

/** Each character of a formula, and whether it stands inside a string literal. */
function* characters(
  expression: string,
): Generator<{ char: string; index: number; quoted: boolean }> {
  let quote: string | null = null;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = null;
      yield { char, index, quoted: true };
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      yield { char, index, quoted: true };
      continue;
    }
    yield { char, index, quoted: false };
  }
}

/** The price a line names, and what that price names: what a line cannot be written without. */
const PRICE_OBJECTS: readonly string[] = [
  PRICEBOOK_ENTRY_OBJECT,
  PRODUCT_OBJECT,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  PRICEBOOK_OBJECT,
];

/** The category a product's assignment names, and the catalog that holds it. */
const CATEGORY_OBJECTS: readonly string[] = ['ProductCategory', 'ProductCatalog'];

/**
 * The objects a run of `graph` writes, as far as the graph tells before a row
 * is read: those it includes, but the reference data it matches by name and
 * never inserts; the items of its orders when discovery stopped before them,
 * which the run adds for the orders past Draft; and the catalog past the graph
 * when a record it writes cannot be written without a row of it — a line's
 * price, and that price's product, book and selling model, or an assignment's
 * category and its catalog — which the run adds wherever discovery stopped.
 *
 * @param leftOut - The objects the run leaves out by name.
 */
export function objectsTheRunWrites(
  graph: Pick<ForgeGraph, 'nodes' | 'edges'>,
  leftOut: ReadonlySet<string> = new Set(),
): string[] {
  const { referenceDataObjects } = resolveStageConfig(undefined);
  const written = graph.nodes
    .filter(
      (node) =>
        node.included &&
        !leftOut.has(node.objectApiName) &&
        !referenceDataObjects.has(node.objectApiName),
    )
    .map((node) => node.objectApiName);
  const writing = new Set(written);
  const held = new Set(graph.nodes.map((node) => node.objectApiName));
  const items = Object.entries(STATUS_NEEDS_CHILDREN)
    .filter(
      ([parent, { object }]) => writing.has(parent) && !held.has(object) && !leftOut.has(object),
    )
    .map(([, { object }]) => object);
  const beyond = catalogBeyond(graph, leftOut);
  const needed = (family: readonly string[]): boolean =>
    graph.edges.some(
      (edge) =>
        edge.required === true &&
        family.includes(edge.sourceObject) &&
        beyond.has(edge.sourceObject) &&
        writing.has(edge.targetObject),
    );
  // An order's items cannot be written without their price either.
  const prices = items.length > 0 || needed(PRICE_OBJECTS);
  return [
    ...new Set([
      ...written,
      ...items,
      ...(prices ? PRICE_OBJECTS.filter((object) => beyond.has(object)) : []),
      ...(needed(CATEGORY_OBJECTS) ? CATEGORY_OBJECTS.filter((object) => beyond.has(object)) : []),
    ]),
  ];
}

/**
 * Reads what the target org runs on the objects a Forge run writes.
 */
export class TargetAutomationReader {
  private readonly deps: TargetAutomationDeps;

  constructor(deps: TargetAutomationDeps) {
    this.deps = deps;
  }

  /**
   * What `targetOrgId` runs on the objects a run of `graph` writes
   * ({@link objectsTheRunWrites}).
   *
   * @param leftOut - The objects the run leaves out by name.
   */
  async readForGraph(
    targetOrgId: string,
    graph: Pick<ForgeGraph, 'nodes' | 'edges'>,
    leftOut: ReadonlySet<string> = new Set(),
  ): Promise<ForgeTargetAutomation> {
    return this.read(targetOrgId, objectsTheRunWrites(graph, leftOut));
  }

  /**
   * What `targetOrgId` runs on `objectApiNames`.
   *
   * @param targetOrgId - The org the run writes to.
   * @param objectApiNames - The objects the run writes ({@link objectsTheRunWrites}).
   */
  async read(
    targetOrgId: string,
    objectApiNames: readonly string[],
  ): Promise<ForgeTargetAutomation> {
    const unread: ForgeTargetAutomationUnread[] = [];
    let requests = 0;
    // API names are the org's to spell: matched whatever their case.
    const wanted = new Map(objectApiNames.map((name) => [name.toLowerCase(), name]));
    const ofTheRun = (name: string): string | undefined => wanted.get(name.toLowerCase());

    const ask = async (
      part: ForgeTargetAutomationUnread['part'],
      run: () => Promise<QueryAnswer>,
    ): Promise<Array<Record<string, unknown>>> => {
      try {
        const answer = await run();
        requests += answer.requests;
        return answer.records;
      } catch (err: unknown) {
        requests++;
        unread.push({ part, reason: extractErrorMessage(err) });
        return [];
      }
    };

    const [flowRows, triggerRows] = await Promise.all([
      ask('flows', () => this.deps.query(targetOrgId, FLOWS_SOQL)),
      ask('triggers', () => this.deps.toolingQuery(targetOrgId, TRIGGERS_SOQL)),
    ]);

    const flows = flowRows
      .map(flowOfRow)
      .filter((read): read is ReadFlow => read !== undefined)
      .flatMap((read) => {
        const objectApiName = ofTheRun(read.objectApiName);
        return objectApiName ? [{ ...read, objectApiName }] : [];
      });
    // A trigger that runs on an undelete alone fires on no write a run makes.
    const triggers = triggerRows
      .map(triggerOfRow)
      .filter((read) => read !== undefined)
      .flatMap((read) => {
        const objectApiName = ofTheRun(read.objectApiName);
        const fires = read.trigger.events.some((event) => event !== 'afterUndelete');
        return objectApiName && fires ? [{ ...read, objectApiName }] : [];
      });

    const order = new Map(objectApiNames.map((name, index) => [name, index]));
    const toRead = flows
      .filter((read) => read.versionId !== null)
      .sort(
        (a, b) =>
          conditionRank(a.flow) - conditionRank(b.flow) ||
          (order.get(a.objectApiName) ?? 0) - (order.get(b.objectApiName) ?? 0) ||
          a.flow.label.localeCompare(b.flow.label),
      );
    const reading = toRead.slice(0, CONDITIONS_BOUND);
    let refusal: string | undefined;
    for (let i = 0; i < reading.length; i += CONDITIONS_IN_FLIGHT) {
      const wave = reading.slice(i, i + CONDITIONS_IN_FLIGHT);
      const settled = await Promise.allSettled(
        wave.map((read) => this.deps.toolingQuery(targetOrgId, conditionSoql(read.versionId!))),
      );
      settled.forEach((answer, j) => {
        const { flow } = wave[j];
        if (answer.status === 'rejected') {
          requests++;
          flow.condition = 'unreadable';
          refusal ??= extractErrorMessage(answer.reason);
          return;
        }
        requests += answer.value.requests;
        const metadata = answer.value.records[0]?.Metadata as { start?: unknown } | undefined;
        flow.condition = 'read';
        flow.permissions = permissionsNamed(metadata?.start);
      });
    }
    if (refusal !== undefined) unread.push({ part: 'conditions', reason: refusal });
    // A version the org named in no form an id takes cannot be read either.
    for (const read of flows) if (read.versionId === null) read.flow.condition = 'unreadable';

    const objects: ForgeTargetObjectAutomation[] = objectApiNames
      .map((objectApiName) => ({
        objectApiName,
        flows: flows
          .filter((read) => read.objectApiName === objectApiName)
          .map((read) => read.flow)
          .sort((a, b) => a.label.localeCompare(b.label)),
        triggers: triggers
          .filter((read) => read.objectApiName === objectApiName)
          .map((read) => read.trigger)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((object) => object.flows.length > 0 || object.triggers.length > 0);

    return {
      objectsRead: [...objectApiNames],
      objects,
      unread,
      conditionsNotRead: toRead.length - reading.length,
      conditionsBound: CONDITIONS_BOUND,
      requests,
    };
  }
}

/** How each write and timing reads in the command's lines. */
const WRITE_WORDS = { insert: 'on insert', update: 'on update', delete: 'on delete' } as const;
const WHEN_WORDS = {
  insert: { before: 'before save', after: 'after save', beforeAndAfter: 'before and after save' },
  update: { before: 'before save', after: 'after save', beforeAndAfter: 'before and after save' },
  delete: {
    before: 'before delete',
    after: 'after delete',
    beforeAndAfter: 'before and after delete',
  },
} as const;
const PART_WORDS = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  conditions: 'the start conditions of some flows',
} as const;

/**
 * What the clone command says of the target's automation before it writes:
 * per object, what each write fires — the inserts of the records it creates,
 * the updates of those it writes again, the deletes of a removal of the run —
 * the custom permissions that keep a flow quiet, and what the read could not
 * read or left unread, and what it cost.
 *
 * @param target - The alias of the target, as the command names it.
 */
export function automationLines(automation: ForgeTargetAutomation, target: string): string[] {
  const lines = [
    `target automation: what ${target} runs on the ${automation.objectsRead.length} object(s) the run writes`,
  ];
  for (const object of automation.objects) {
    lines.push(`  ${object.objectApiName}`);
    for (const { write, fired } of automationByWrite(object)) {
      const entries = fired.map((entry) => {
        const what = entry.kind === 'flow' ? `flow "${entry.name}"` : `Apex trigger ${entry.name}`;
        const bypass = (entry.flow?.permissions ?? []).filter((p) => p.bypass).map((p) => p.name);
        const named = (entry.flow?.permissions ?? []).filter((p) => !p.bypass).map((p) => p.name);
        const notes = [
          WHEN_WORDS[write][entry.when],
          ...(bypass.length > 0 ? [`not for a user with ${bypass.join(', ')}`] : []),
          ...(named.length > 0 ? [`its start condition names ${named.join(', ')}`] : []),
          ...(entry.flow?.condition === 'notRead' ? ['start condition not read'] : []),
          ...(entry.flow?.condition === 'unreadable' ? ['start condition unreadable'] : []),
        ];
        return `${what} (${notes.join('; ')})`;
      });
      lines.push(`    ${WRITE_WORDS[write]}: ${entries.join(', ')}`);
    }
  }
  const readEverything = !automation.unread.some((u) => u.part !== 'conditions');
  if (automation.objects.length === 0) {
    lines.push(
      readEverything
        ? '  no active flow or Apex trigger fires on them'
        : '  nothing found in what could be read',
    );
  }
  const bypass = bypassPermissionsOf(automation);
  if (bypass.length > 0) {
    lines.push(
      `  bypass: assign ${bypass.join(', ')} to the user the run writes as, and the flows ` +
        'whose start condition excludes them stay quiet',
    );
  }
  if (automation.conditionsNotRead > 0) {
    lines.push(
      `  ${automation.conditionsNotRead} start condition(s) not read: the read takes ` +
        `${automation.conditionsBound} at most, one request each`,
    );
  }
  for (const { part, reason } of automation.unread) {
    lines.push(`  ${PART_WORDS[part]} could not be read: ${reason}`);
  }
  lines.push(`  read in ${automation.requests} request(s) to ${target}`);
  return lines;
}
