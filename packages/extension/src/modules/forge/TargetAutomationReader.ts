/**
 * TargetAutomationReader reads, before a Forge run writes, what the target org
 * runs on the objects the run writes: its active record-triggered flows, Apex
 * triggers, Process Builder processes, workflow rules, assignment rules and
 * duplicate rules; what of them runs once the save is committed, or sends
 * emails, notifications or text messages; and what keeps a flow quiet for the
 * user the run writes as.
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
 *   `TriggerObjectOrEventId` is the object's name for a standard one only —
 *   and whose `HasAsyncAfterCommitPath` says whether a flow has an
 *   asynchronous path before its metadata is read;
 * - the processes from the same view, `ProcessType = 'Workflow'`, in a query
 *   of their own: the view refuses an `OR` (`MALFORMED_QUERY`). A process
 *   keeps its object in its version's variables (`FlowVariableView`, the
 *   object of `myVariable_current`) and in its metadata;
 * - the triggers from `ApexTrigger` over the Tooling API, the one that gives
 *   it an `EntityDefinition`: the regular API's `ApexTrigger` has only
 *   `TableEnumOrId`;
 * - the workflow rules from `WorkflowRule` over the Tooling API, which names
 *   a standard object by its name and a custom one by its id, and has no
 *   `Active` of its own: active or not, and what a rule does, is in its
 *   `Metadata`;
 * - a start condition, the paths after commit and the actions of a flow from
 *   the `Metadata` of its active version, `Flow` over the Tooling API, and a
 *   rule's from its own `Metadata`. The org gives `Metadata` one row per
 *   query: asked for two, it refuses with `MALFORMED_QUERY`. Each costs a
 *   request, so the read takes {@link CONDITIONS_BOUND} flows and
 *   {@link DEFINITIONS_BOUND} processes and rules at most;
 * - the assignment rules from `AssignmentRule` (Case and Lead only), the
 *   duplicate rules from `DuplicateRule`, and the custom permissions of the
 *   user the read runs as — the user the run writes as — from
 *   `UserSetupEntityAccess`, all over the regular API.
 *
 * A part the org refuses — no access, an API turned off — is said, and the
 * others are read all the same: the read never stops a run.
 */

import type {
  ForgeAutomationFired,
  ForgeAutomationWrite,
  ForgeFlowPath,
  ForgeFlowPermission,
  ForgeFlowStart,
  ForgeFlowSwitch,
  ForgeFlowTiming,
  ForgeGraph,
  ForgeMessageAction,
  ForgeTargetAssignmentRule,
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
  ForgeTargetDuplicateRule,
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
  blindedBy,
  bypassPermissionsOf,
  heldBypassPermissionsOf,
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
 * The most definitions of processes and workflow rules a read reads, one
 * request each, beside the start conditions of the flows: an org that still
 * runs its old automation often has dozens of rules on a case, many of them
 * inactive, which only a rule's definition tells.
 */
export const DEFINITIONS_BOUND = 15;

/**
 * Requests in flight at a time. Review compares the two orgs' metadata at the
 * same moment, two describes at a time: four more keep the target under the
 * six requests a Forge pass keeps in flight against an org
 * (`CONCURRENT_DESCRIBE_LIMIT`).
 */
const REQUESTS_IN_FLIGHT = 4;

/** The active record-triggered flows of an org, every object's. */
export const FLOWS_SOQL =
  'SELECT ApiName, Label, TriggerType, RecordTriggerType, TriggerObjectOrEvent.QualifiedApiName, ' +
  'ActiveVersionId, HasAsyncAfterCommitPath FROM FlowDefinitionView WHERE IsActive = true ' +
  "AND TriggerType IN ('RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete')";

/** The active Apex triggers of an org, every object's, with the events each runs on. */
export const TRIGGERS_SOQL =
  'SELECT Name, NamespacePrefix, TableEnumOrId, EntityDefinition.QualifiedApiName, ' +
  'UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, ' +
  "UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger WHERE Status = 'Active'";

/** The active Process Builder processes of an org, every object's. */
export const PROCESSES_SOQL =
  'SELECT ApiName, Label, TriggerObjectOrEvent.QualifiedApiName, ActiveVersionId ' +
  "FROM FlowDefinitionView WHERE IsActive = true AND ProcessType = 'Workflow'";

/** The workflow rules of an org, every object's, active or not. */
export const WORKFLOW_RULES_SOQL =
  'SELECT Id, Name, NamespacePrefix, TableEnumOrId FROM WorkflowRule';

/** The active assignment rules of an org: Case and Lead have them. */
export const ASSIGNMENT_RULES_SOQL =
  'SELECT Name, SobjectType FROM AssignmentRule WHERE Active = true';

/** The active duplicate rules of an org, every object's. */
export const DUPLICATE_RULES_SOQL =
  'SELECT DeveloperName, MasterLabel, SobjectType FROM DuplicateRule WHERE IsActive = true';

/** The custom permissions the user the query runs as holds, `0CF` being theirs. */
export const USER_PERMISSIONS_SOQL =
  "SELECT DeveloperName, NamespacePrefix FROM UserSetupEntityAccess WHERE KeyPrefix = '0CF'";

/** The metadata of one version of a flow: the only way the org gives its start condition. */
export function conditionSoql(versionId: string): string {
  return `SELECT Metadata FROM Flow WHERE Id = '${versionId}'`;
}

/** The metadata of one workflow rule: the only way the org says whether it is active. */
export function ruleDefinitionSoql(ruleId: string): string {
  return `SELECT Metadata FROM WorkflowRule WHERE Id = '${ruleId}'`;
}

/** The variables of process versions, among which the object each process runs on. */
export function processObjectsSoql(versionIds: readonly string[]): string {
  const ids = versionIds.map((id) => `'${id}'`).join(', ');
  return `SELECT FlowVersionViewId, ApiName, ObjectType FROM FlowVariableView WHERE FlowVersionViewId IN (${ids})`;
}

/** The ids of custom objects, by which `WorkflowRule.TableEnumOrId` names them. */
export function customObjectIdsSoql(objectApiNames: readonly string[]): string {
  const names = objectApiNames.map((name) => `'${name}'`).join(', ');
  return `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${names})`;
}

/** A 15- or 18-character Salesforce id, as a flow version's must be before it goes in a query. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** An API name as it may go in a query: a custom object's, a namespace's included. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The variable a process holds the record that started it in, of the process's object. */
const PROCESS_RECORD_VARIABLE = 'myvariable_current';

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

/**
 * The writes that start a process (its `TriggerType` metadata value) or a
 * workflow rule (its `triggerType`): an insert alone, or an insert and the
 * updates after it.
 */
const RULE_STARTS: Readonly<Record<string, ForgeFlowStart>> = {
  onCreateOnly: 'create',
  onAllChanges: 'createAndUpdate',
  onCreateOrTriggeringUpdate: 'createAndUpdate',
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

/** What a flow's or a process's action sends, by its `actionType`. */
const MESSAGE_ACTIONS: Readonly<Record<string, ForgeMessageAction['kind']>> = {
  emailAlert: 'email',
  emailSimple: 'email',
  customNotificationAction: 'notification',
  outboundMessage: 'outbound',
};

/** What a workflow rule's action sends, by its `type`. */
const RULE_MESSAGE_ACTIONS: Readonly<Record<string, ForgeMessageAction['kind']>> = {
  Alert: 'email',
  OutboundMessage: 'outbound',
};

/**
 * Words of an Apex action's name that say it sends text messages: the
 * platform has no action of its own for one, so an org sends them from a
 * class, often named after what it does or the provider it calls.
 */
const TEXT_MESSAGE_WORDS = new Set([
  'sms',
  'mms',
  'twilio',
  'whatsapp',
  'vonage',
  'nexmo',
  'messagebird',
  'plivo',
  'sinch',
]);

/** A flow, a process or a rule as the read holds it before its metadata is read. */
interface ReadFlow {
  /** The object it runs on; unknown for a process until its variables or metadata say. */
  objectApiName: string | undefined;
  /** The id its metadata is read by: a flow's or a process's version, a rule's own. */
  id: string | null;
  flow: ForgeTargetFlow;
}

/** The API name a relationship to an `EntityDefinition` names, if any. */
function entityName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = (value as { QualifiedApiName?: unknown }).QualifiedApiName;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The value of `key` on what may be an object, unknown otherwise. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** What may be a list of objects, as a list; none for anything else. */
function listOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item)
    : [];
}

/** A flow, a process or a rule as nothing of it has been read but its row. */
function unreadFlow(
  apiName: string,
  label: string,
  timing: ForgeFlowTiming,
  startsOn: ForgeFlowStart,
): ForgeTargetFlow {
  return {
    apiName,
    label: label || apiName,
    timing,
    startsOn,
    condition: 'notRead',
    permissions: [],
    paths: [],
    messages: [],
    switches: [],
  };
}

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
  const flow = unreadFlow(text(row.ApiName), text(row.Label), timing, startsOn);
  // Known before the metadata is read: said of a flow past the bound too.
  if (row.HasAsyncAfterCommitPath === true) flow.paths = [{ kind: 'async' }];
  return { objectApiName, id: SF_ID_RE.test(versionId) ? versionId : null, flow };
}

/**
 * A process of `FlowDefinitionView`. Taken as starting on a record created or
 * updated until its definition says which: said once too often rather than
 * not at all.
 */
function processOfRow(row: Record<string, unknown>): ReadFlow {
  const versionId = text(row.ActiveVersionId);
  return {
    objectApiName: entityName(row.TriggerObjectOrEvent),
    id: SF_ID_RE.test(versionId) ? versionId : null,
    flow: unreadFlow(text(row.ApiName), text(row.Label), 'afterSave', 'createAndUpdate'),
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
 * formula requires together, or `NOT(OR(…))` over alternatives one of which
 * is the permission — or compared with false. Named any other way —
 * `{!$Permission.X}` alone starts the flow for the users who hold it —
 * assigning it would not keep the flow quiet.
 */
export function permissionsNamed(start: unknown): ForgeFlowPermission[] {
  const named = new Set(
    globalsIn(JSON.stringify(start ?? null))
      .filter((reference) => kindOf(reference) === 'Permission')
      .map(permissionName),
  );
  if (named.size === 0) return [];
  const formula = field(start, 'filterFormula');
  const bypassing = new Set(
    (typeof formula === 'string' ? deniedIn(formula) : [])
      .filter((test) => kindOf(test.reference) === 'Permission' && test.value === undefined)
      .map((test) => permissionName(test.reference)),
  );
  return [...named]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, bypass: bypassing.has(name) }));
}

/**
 * What else than a custom permission keeps a flow from starting, as its start
 * formula requires it — or a workflow rule's criteria: a custom setting, a
 * field of the user, the user's profile or a custom metadata record, negated
 * or compared, among the terms the formula requires together. One the start
 * only names — `$User.Id` in a filter on the owner — keeps nothing quiet, and
 * is left out.
 */
export function switchesNamed(formula: unknown): ForgeFlowSwitch[] {
  if (typeof formula !== 'string') return [];
  return dedupe(deniedIn(formula))
    .filter((test) => kindOf(test.reference) !== 'Permission')
    .map((test) => ({ ...test, where: 'start' as const, bypass: true }));
}

/** The kinds of global a condition tests of the user who writes or of the org's settings. */
type GlobalKind = 'Permission' | 'Setup' | 'User' | 'Profile' | 'CustomMetadata';

const GLOBAL_KINDS: Readonly<Record<string, GlobalKind>> = {
  permission: 'Permission',
  setup: 'Setup',
  user: 'User',
  profile: 'Profile',
  custommetadata: 'CustomMetadata',
};

/**
 * A global and the value that makes a test of it pass or fail: absent for a
 * checkbox, or a permission, held — true.
 */
interface GlobalTest {
  reference: string;
  value?: string;
}

/** The path of a global after its kind: `Bypass__c.Flows__c`, `Name`, `X`. */
const GLOBAL_PATH = String.raw`[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*`;

/** A global wherever it stands. */
const GLOBAL_REFERENCE = new RegExp(
  String.raw`\$(?:Permission|Setup|User|Profile|CustomMetadata)\.${GLOBAL_PATH}`,
  'gi',
);

/** A global as a formula writes it, merge field braces or not; the global captured. */
const GLOBAL_TERM = String.raw`(?:\{!\s*)?(\$(?:Permission|Setup|User|Profile|CustomMetadata)\.${GLOBAL_PATH})\s*\}?`;

/** A term that is one global and nothing else. */
const ONE_GLOBAL = new RegExp(`^${GLOBAL_TERM}$`, 'i');

/** One global after a NOT with no parentheses. */
const BARE_NOT = new RegExp(`^NOT\\s+${GLOBAL_TERM}$`, 'i');

/** A global compared with a boolean, either way round. */
const COMPARED = new RegExp(
  `^(?:${GLOBAL_TERM}\\s*(==?|<>|!=)\\s*(TRUE|FALSE)|(TRUE|FALSE)\\s*(==?|<>|!=)\\s*${GLOBAL_TERM})$`,
  'i',
);

/** A text a formula writes, in either quotes. */
const QUOTED = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;

/** A global compared with a text, either way round. */
const COMPARED_TEXT = new RegExp(
  `^(?:${GLOBAL_TERM}\\s*(==?|<>|!=)\\s*${QUOTED}|${QUOTED}\\s*(==?|<>|!=)\\s*${GLOBAL_TERM})$`,
  'i',
);

/** A global with its kind spelled as Salesforce spells it, its path as the flow wrote it. */
function canonical(reference: string): string {
  const dot = reference.indexOf('.');
  const kind = GLOBAL_KINDS[reference.slice(1, dot).toLowerCase()];
  return kind ? `$${kind}${reference.slice(dot)}` : reference;
}

/** The kind of a global, once canonical. */
function kindOf(reference: string): GlobalKind | undefined {
  return GLOBAL_KINDS[reference.slice(1, reference.indexOf('.')).toLowerCase()];
}

/** The name of a custom permission a `$Permission` global names. */
function permissionName(reference: string): string {
  return reference.slice(reference.indexOf('.') + 1);
}

/** Every global named in `source`, each once, canonical. */
function globalsIn(source: string): string[] {
  return [...new Set([...source.matchAll(GLOBAL_REFERENCE)].map((match) => canonical(match[0])))];
}

/** A value that is one global and nothing else. */
const ONLY_A_GLOBAL = new RegExp(`^${GLOBAL_REFERENCE.source}$`, 'i');

/** Whether `name` is a global. */
function isGlobal(name: unknown): name is string {
  return typeof name === 'string' && ONLY_A_GLOBAL.test(name);
}

/** Whether two globals are the same: a formula's merge fields are not case-sensitive. */
function sameGlobal(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The text a formula's quoted literal holds. */
function unquoted(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

/** The same tests, each once. */
function dedupe(tests: readonly GlobalTest[]): GlobalTest[] {
  const seen = new Map<string, GlobalTest>();
  for (const test of tests) seen.set(`${test.reference.toLowerCase()}=${test.value ?? ''}`, test);
  return [...seen.values()];
}

/** Whether `tests` hold `test`: the same global, the same value. */
function holds(tests: readonly GlobalTest[], test: GlobalTest): boolean {
  return tests.some((t) => sameGlobal(t.reference, test.reference) && t.value === test.value);
}

/**
 * The tests each of which, holding, makes `expression` false: a test denied
 * by one of the terms the expression requires together.
 */
function deniedIn(expression: string): GlobalTest[] {
  return conjuncts(expression).flatMap(denied);
}

/**
 * The tests each of which, holding, makes `expression` true: a test one of
 * its alternatives is alone.
 */
function affirmedIn(expression: string): GlobalTest[] {
  return disjuncts(expression).flatMap(affirmed);
}

/** The tests that, holding, make a single term false. */
function denied(term: string): GlobalTest[] {
  const compared = COMPARED.exec(term);
  if (compared) {
    const [, leftName, leftOp, leftValue, rightValue, rightOp, rightName] = compared;
    const op = leftOp ?? rightOp;
    const value = (leftValue ?? rightValue).toUpperCase();
    const negates = op.startsWith('=') ? value === 'FALSE' : value === 'TRUE';
    return negates ? [{ reference: canonical(leftName ?? rightName) }] : [];
  }
  const comparedText = COMPARED_TEXT.exec(term);
  if (comparedText) {
    const [, leftName, leftOp, leftText, rightText, rightOp, rightName] = comparedText;
    const op = leftOp ?? rightOp;
    return op.startsWith('=')
      ? []
      : [{ reference: canonical(leftName ?? rightName), value: unquoted(leftText ?? rightText) }];
  }
  const negated = callOf(term, 'NOT');
  if (negated === undefined) {
    // `NOT {!$Permission.X}`, as the condition is sometimes quoted: the
    // platform's NOT takes parentheses, and without them it is read for one
    // global only.
    const bare = BARE_NOT.exec(term);
    return bare ? [{ reference: canonical(bare[1]) }] : [];
  }
  return affirmedIn(negated);
}

/** The tests that, holding, make a single term true. */
function affirmed(term: string): GlobalTest[] {
  const one = ONE_GLOBAL.exec(term);
  if (one) return [{ reference: canonical(one[1]) }];
  const compared = COMPARED.exec(term);
  if (compared) {
    const [, leftName, leftOp, leftValue, rightValue, rightOp, rightName] = compared;
    const op = leftOp ?? rightOp;
    const value = (leftValue ?? rightValue).toUpperCase();
    const affirms = op.startsWith('=') ? value === 'TRUE' : value === 'FALSE';
    return affirms ? [{ reference: canonical(leftName ?? rightName) }] : [];
  }
  const comparedText = COMPARED_TEXT.exec(term);
  if (comparedText) {
    const [, leftName, leftOp, leftText, rightText, rightOp, rightName] = comparedText;
    const op = leftOp ?? rightOp;
    return op.startsWith('=')
      ? [{ reference: canonical(leftName ?? rightName), value: unquoted(leftText ?? rightText) }]
      : [];
  }
  const negated = callOf(term, 'NOT');
  return negated === undefined ? [] : deniedIn(negated);
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

/**
 * The alternatives of a formula: the arguments of a top-level `OR(…)`, the
 * operands of `||`, each read again the same way.
 */
function disjuncts(expression: string): string[] {
  const term = unwrapped(expression);
  const call = callOf(term, 'OR');
  if (call) return splitTopLevel(call, ',').flatMap(disjuncts);
  const operands = splitTopLevel(term, '||');
  if (operands.length > 1) return operands.flatMap(disjuncts);
  return [term];
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

/** A condition of a Decision's outcome, as a flow's metadata writes it. */
interface FlowCondition {
  leftValueReference?: unknown;
  operator?: unknown;
  rightValue?: unknown;
}

/** What a condition, a rule or a formula comes to while a global holds a value. */
type Verdict = 'true' | 'false' | 'unknown';

/**
 * The element a flow runs first, and whether every path of it starts there:
 * its immediate path's, unless a scheduled or asynchronous path starts
 * elsewhere. A process starts at its `startElementReference`, or at its
 * start's connector in a newer form of its metadata, and has no other path.
 */
function firstElementOf(metadata: unknown): { name: string | undefined; everyPath: boolean } {
  const start = field(metadata, 'start');
  if (typeof start === 'object' && start !== null) {
    const name = text(field(field(start, 'connector'), 'targetReference')) || undefined;
    const others = listOf(field(start, 'scheduledPaths')).map(
      (path) => text(field(field(path, 'connector'), 'targetReference')) || undefined,
    );
    return { name, everyPath: others.every((other) => other === name) };
  }
  return { name: text(field(metadata, 'startElementReference')) || undefined, everyPath: true };
}

/** The tests a condition can come to: the global it compares with a value, or its formula's. */
function testsOfCondition(condition: FlowCondition, formulas: Map<string, string>): GlobalTest[] {
  const left = condition.leftValueReference;
  const right = condition.rightValue;
  if (isGlobal(left)) {
    const reference = canonical(left);
    if (typeof field(right, 'booleanValue') === 'boolean') return [{ reference }];
    const value = field(right, 'stringValue');
    return typeof value === 'string' ? [{ reference, value }] : [];
  }
  const expression = typeof left === 'string' ? formulas.get(left) : undefined;
  return expression === undefined ? [] : [...affirmedIn(expression), ...deniedIn(expression)];
}

/** Every global a condition names: compared, compared with, or in its formula. */
function globalsOfCondition(condition: FlowCondition, formulas: Map<string, string>): string[] {
  const left = condition.leftValueReference;
  const expression = typeof left === 'string' ? formulas.get(left) : undefined;
  return globalsIn(
    [
      typeof left === 'string' ? left : '',
      text(field(condition.rightValue, 'elementReference')),
      expression ?? '',
    ].join(' '),
  );
}

/** What a condition comes to while `test` holds. */
function conditionVerdict(
  condition: FlowCondition,
  test: GlobalTest,
  formulas: Map<string, string>,
): Verdict {
  const { leftValueReference: left, operator, rightValue: right } = condition;
  if (operator !== 'EqualTo' && operator !== 'NotEqualTo') return 'unknown';
  const equal = operator === 'EqualTo';
  const booleanValue = field(right, 'booleanValue');
  if (isGlobal(left)) {
    if (!sameGlobal(left, test.reference)) return 'unknown';
    if (typeof booleanValue === 'boolean' && test.value === undefined) {
      return booleanValue === equal ? 'true' : 'false';
    }
    const stringValue = field(right, 'stringValue');
    if (typeof stringValue === 'string' && test.value !== undefined) {
      return (stringValue === test.value) === equal ? 'true' : 'false';
    }
    return 'unknown';
  }
  const expression = typeof left === 'string' ? formulas.get(left) : undefined;
  if (expression === undefined || typeof booleanValue !== 'boolean') return 'unknown';
  // The condition asks the formula to be true, or false.
  const wantsTrue = booleanValue === equal;
  if (holds(affirmedIn(expression), test)) return wantsTrue ? 'true' : 'false';
  if (holds(deniedIn(expression), test)) return wantsTrue ? 'false' : 'true';
  return 'unknown';
}

/** What an outcome's conditions come to while `test` holds, as their logic joins them. */
function ruleVerdict(
  rule: Record<string, unknown>,
  test: GlobalTest,
  formulas: Map<string, string>,
): Verdict {
  const conditions = listOf(rule.conditions);
  if (conditions.length === 0) return 'unknown';
  const verdicts = conditions.map((condition) => conditionVerdict(condition, test, formulas));
  const logic = text(rule.conditionLogic).toLowerCase() || 'and';
  if (logic === 'and') {
    if (verdicts.includes('false')) return 'false';
    return verdicts.every((verdict) => verdict === 'true') ? 'true' : 'unknown';
  }
  if (logic === 'or') {
    if (verdicts.includes('true')) return 'true';
    return verdicts.every((verdict) => verdict === 'false') ? 'false' : 'unknown';
  }
  // A logic of its own — `1 AND (2 OR 3)` — is not read.
  return 'unknown';
}

/**
 * Whether the Decision ends the flow while `test` holds: the outcomes are
 * taken in order, the first that holds wins, and one with nowhere to go ends
 * the flow — as does the default outcome when it has nowhere to go. An
 * outcome that may or may not hold and ends the flow either way decides
 * nothing; one that may hold and leads somewhere keeps the answer unknown.
 */
function endsWhile(
  decision: Record<string, unknown>,
  test: GlobalTest,
  formulas: Map<string, string>,
): boolean {
  for (const rule of listOf(decision.rules)) {
    const verdict = ruleVerdict(rule, test, formulas);
    const ends = !text(field(rule.connector, 'targetReference'));
    if (verdict === 'false') continue;
    if (verdict === 'true') return ends;
    if (!ends) return false;
  }
  return !text(field(decision.defaultConnector, 'targetReference'));
}

/**
 * What a flow's Decisions test of the user who writes and of the org: every
 * custom permission, custom setting, user field, profile and custom metadata
 * a condition of theirs names, and those the flow's first Decision ends it on
 * — when every path of the flow starts with it, the flow does nothing while
 * the global holds that value. Any other is only named: a Decision further on
 * may or may not be a way out.
 */
export function decisionChecks(metadata: unknown): {
  permissions: ForgeFlowPermission[];
  switches: ForgeFlowSwitch[];
} {
  const decisions = listOf(field(metadata, 'decisions'));
  const formulas = new Map(
    listOf(field(metadata, 'formulas'))
      .filter((formula) => typeof formula.expression === 'string')
      .map((formula) => [text(formula.name), text(formula.expression)]),
  );
  const conditionsOf = (decision: Record<string, unknown>): FlowCondition[] =>
    listOf(decision.rules).flatMap((rule) => listOf(rule.conditions));

  const named = [
    ...new Set(
      decisions.flatMap((decision) =>
        conditionsOf(decision).flatMap((condition) => globalsOfCondition(condition, formulas)),
      ),
    ),
  ];
  if (named.length === 0) return { permissions: [], switches: [] };

  const { name: first, everyPath } = firstElementOf(metadata);
  const firstDecision = everyPath ? decisions.find((d) => text(d.name) === first) : undefined;
  const bypasses = firstDecision
    ? dedupe(
        conditionsOf(firstDecision).flatMap((condition) => testsOfCondition(condition, formulas)),
      ).filter((test) => endsWhile(firstDecision, test, formulas))
    : [];

  const permissions = named
    .filter((reference) => kindOf(reference) === 'Permission')
    .map((reference) => ({
      name: permissionName(reference),
      bypass: bypasses.some((b) => sameGlobal(b.reference, reference) && b.value === undefined),
      where: 'decision' as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const switches = named
    .filter((reference) => kindOf(reference) !== 'Permission')
    .flatMap((reference): ForgeFlowSwitch[] => {
      const ways = bypasses.filter((b) => sameGlobal(b.reference, reference));
      return ways.length > 0
        ? ways.map((b) => ({ ...b, where: 'decision', bypass: true }))
        : [{ reference, where: 'decision', bypass: false }];
    })
    .sort((a, b) => a.reference.localeCompare(b.reference));
  return { permissions, switches };
}

/** The words of a name, split at its separators and where its case changes. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/** Whether an Apex action's name says it sends text messages. */
function soundsLikeTextMessages(...names: string[]): boolean {
  return names.some((name) => {
    const words = wordsOf(name);
    return (
      words.some((word) => TEXT_MESSAGE_WORDS.has(word)) ||
      words.some((word, i) => word === 'text' && /^messages?$/.test(words[i + 1] ?? ''))
    );
  });
}

/** The actions of a flow or a process that send something out of the org. */
export function messagesOf(metadata: unknown): ForgeMessageAction[] {
  return listOf(field(metadata, 'actionCalls')).flatMap((call): ForgeMessageAction[] => {
    const type = text(call.actionType);
    const name = text(call.label) || text(call.name) || text(call.actionName);
    const kind = MESSAGE_ACTIONS[type];
    if (kind) return [{ kind, name }];
    if (type === 'apex' && soundsLikeTextMessages(text(call.actionName), text(call.name), name)) {
      return [{ kind: 'sms', name, guessed: true }];
    }
    return [];
  });
}

/** What of a flow runs once the save is committed, as its start's paths say. */
export function pathsOf(metadata: unknown): ForgeFlowPath[] {
  return listOf(field(field(metadata, 'start'), 'scheduledPaths')).map((path): ForgeFlowPath => {
    const label = text(path.label) || text(path.name) || undefined;
    if (text(path.pathType) === 'AsyncAfterCommit') return { kind: 'async', label };
    const offset = Number(path.offsetNumber);
    const recordField = text(path.timeSource) === 'RecordField' ? text(path.recordField) : '';
    return {
      kind: 'scheduled',
      label,
      ...(Number.isFinite(offset) ? { offset } : {}),
      ...(text(path.offsetUnit) ? { unit: text(path.offsetUnit) } : {}),
      ...(recordField ? { field: recordField } : {}),
    };
  });
}

/**
 * A flow's start condition, Decisions, paths and actions, read from its
 * version's metadata. A version the org answered without one leaves the
 * asynchronous path the definition view said.
 */
function readFlowMetadata(flow: ForgeTargetFlow, metadata: unknown): void {
  if (typeof metadata !== 'object' || metadata === null) return;
  const start = field(metadata, 'start');
  const decisions = decisionChecks(metadata);
  flow.permissions = [...permissionsNamed(start), ...decisions.permissions];
  flow.switches = [...switchesNamed(field(start, 'filterFormula')), ...decisions.switches];
  // The asynchronous path the definition view said is among the start's paths.
  flow.paths = pathsOf(metadata);
  flow.messages = messagesOf(metadata);
}

/**
 * A process's writes, Decisions and actions, read from its version's
 * metadata; the object it runs on, as the metadata names it.
 */
function readProcessMetadata(flow: ForgeTargetFlow, metadata: unknown): string | undefined {
  const values = new Map(
    listOf(field(metadata, 'processMetadataValues')).map((value) => [
      text(value.name),
      text(field(value.value, 'stringValue')),
    ]),
  );
  flow.startsOn = RULE_STARTS[values.get('TriggerType') ?? ''] ?? 'createAndUpdate';
  const decisions = decisionChecks(metadata);
  flow.permissions = decisions.permissions;
  flow.switches = decisions.switches;
  flow.messages = messagesOf(metadata);
  return values.get('ObjectType') || undefined;
}

/**
 * A workflow rule's writes, criteria and actions, read from its metadata;
 * whether it is active, which only the metadata says.
 */
function readRuleMetadata(flow: ForgeTargetFlow, metadata: unknown): boolean {
  flow.startsOn = RULE_STARTS[text(field(metadata, 'triggerType'))] ?? 'createAndUpdate';
  const formula = field(metadata, 'formula');
  flow.permissions =
    typeof formula === 'string' ? permissionsNamed({ filterFormula: formula }) : [];
  flow.switches = switchesNamed(formula);
  const triggers = listOf(field(metadata, 'workflowTimeTriggers'));
  // A time-dependent action runs once its time comes, long after the save.
  flow.paths = triggers.map((trigger): ForgeFlowPath => {
    const offset = Number(trigger.timeLength);
    return {
      kind: 'scheduled',
      ...(Number.isFinite(offset) ? { offset } : {}),
      ...(text(trigger.workflowTimeTriggerUnit)
        ? { unit: text(trigger.workflowTimeTriggerUnit) }
        : {}),
      ...(text(trigger.offsetFromField) ? { field: text(trigger.offsetFromField) } : {}),
    };
  });
  flow.messages = [field(metadata, 'actions'), ...triggers.map((trigger) => trigger.actions)]
    .flatMap(listOf)
    .flatMap((action): ForgeMessageAction[] => {
      const kind = RULE_MESSAGE_ACTIONS[text(action.type)];
      return kind ? [{ kind, name: text(action.name) }] : [];
    });
  return field(metadata, 'active') === true;
}

/** The key a custom permission is held under: its namespace's prefix before its name. */
export function permissionKey(namespace: string, name: string): string {
  return (namespace ? `${namespace}__${name}` : name).toLowerCase();
}

/** Each task run, `limit` at a time at most, their answers in the order of the tasks. */
export async function inFlight<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const answers: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      answers[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return answers;
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
    const ofTheRun = (name: string | undefined): string | undefined =>
      name === undefined ? undefined : wanted.get(name.toLowerCase());

    const ask =
      (
        part: ForgeTargetAutomationUnread['part'],
        run: () => Promise<QueryAnswer>,
      ): (() => Promise<Array<Record<string, unknown>>>) =>
      async () => {
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
    const query = (soql: string) => () => this.deps.query(targetOrgId, soql);
    const tooling = (soql: string) => () => this.deps.toolingQuery(targetOrgId, soql);
    const none = async (): Promise<Array<Record<string, unknown>>> => [];

    // Only Case and Lead take assignment rules: a run that writes neither
    // sends no request for them.
    const assigned = objectApiNames.some((name) => /^(case|lead)$/i.test(name));
    const [flowRows, triggerRows, processRows, ruleRows, assignmentRows, duplicateRows] =
      await inFlight(
        [
          ask('flows', query(FLOWS_SOQL)),
          ask('triggers', tooling(TRIGGERS_SOQL)),
          ask('processes', query(PROCESSES_SOQL)),
          ask('workflowRules', tooling(WORKFLOW_RULES_SOQL)),
          assigned ? ask('assignmentRules', query(ASSIGNMENT_RULES_SOQL)) : none,
          ask('duplicateRules', query(DUPLICATE_RULES_SOQL)),
        ],
        REQUESTS_IN_FLIGHT,
      );

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

    // A process the definition view names no object for is matched by the
    // object of its version's record variable, every version in one request.
    const processes = processRows.map(processOfRow);
    const unplaced = processes
      .filter((read) => read.objectApiName === undefined && read.id !== null)
      .map((read) => read.id!);
    // Custom objects are named by their ids in the rules: asked only when a
    // rule names one and the run writes a custom object.
    const customWritten = objectApiNames.filter(
      (name) => name.includes('__') && API_NAME_RE.test(name),
    );
    const rulesById = ruleRows.some((row) => /^01I/.test(text(row.TableEnumOrId)));
    const [variableRows, entityRows] = await inFlight(
      [
        unplaced.length > 0 ? ask('processes', query(processObjectsSoql(unplaced))) : none,
        rulesById && customWritten.length > 0
          ? ask('workflowRules', query(customObjectIdsSoql(customWritten)))
          : none,
      ],
      REQUESTS_IN_FLIGHT,
    );
    const objectOfVersion = new Map(
      variableRows
        .filter((row) => text(row.ApiName).toLowerCase() === PROCESS_RECORD_VARIABLE)
        .map((row) => [text(row.FlowVersionViewId), text(row.ObjectType)]),
    );
    for (const read of processes) {
      if (read.objectApiName === undefined && read.id !== null) {
        read.objectApiName = objectOfVersion.get(read.id) || undefined;
      }
    }
    const nameOfEntity = new Map(
      entityRows.map((row) => [text(row.DurableId), text(row.QualifiedApiName)]),
    );
    const rules = ruleRows.flatMap((row): ReadFlow[] => {
      const table = text(row.TableEnumOrId);
      const objectApiName = ofTheRun(nameOfEntity.get(table) ?? table);
      const name = text(row.Name);
      const id = text(row.Id);
      if (!objectApiName || !name) return [];
      const namespace = text(row.NamespacePrefix);
      const label = namespace ? `${namespace}.${name}` : name;
      return [
        {
          objectApiName,
          id: SF_ID_RE.test(id) ? id : null,
          flow: unreadFlow(label, label, 'afterSave', 'createAndUpdate'),
        },
      ];
    });
    // A process placed on an object the run does not write is none of its
    // business; one still unplaced is read, its metadata naming its object.
    const candidates = processes.filter(
      (read) => read.objectApiName === undefined || ofTheRun(read.objectApiName) !== undefined,
    );

    // Nearest the record first: the run's objects come in the order discovery
    // reached them, and what is not placed yet comes last.
    const order = new Map(objectApiNames.map((name, index) => [name, index]));
    const objectRank = (read: ReadFlow): number =>
      order.get(ofTheRun(read.objectApiName) ?? '') ?? objectApiNames.length;
    const toRead = flows
      .filter((read) => read.id !== null)
      .sort(
        (a, b) =>
          conditionRank(a.flow) - conditionRank(b.flow) ||
          objectRank(a) - objectRank(b) ||
          a.flow.label.localeCompare(b.flow.label),
      );
    const reading = toRead.slice(0, CONDITIONS_BOUND);
    // The root's processes and rules first, a process before a rule: a rule
    // may well be inactive, which only its definition says.
    const definitionsToRead = [
      ...candidates.map((read) => ({ read, kind: 'process' as const })),
      ...rules.map((read) => ({ read, kind: 'rule' as const })),
    ]
      .filter(({ read }) => read.id !== null)
      .sort(
        (a, b) =>
          objectRank(a.read) - objectRank(b.read) ||
          (a.kind === b.kind ? 0 : a.kind === 'process' ? -1 : 1) ||
          a.read.flow.label.localeCompare(b.read.flow.label),
      );
    const definitionsReading = definitionsToRead.slice(0, DEFINITIONS_BOUND);

    let refusal: string | undefined;
    let definitionRefusal: string | undefined;
    const inactive = new Set<ForgeTargetFlow>();
    const metadataOf = (answer: QueryAnswer): unknown => answer.records[0]?.Metadata;
    await inFlight(
      [
        ...reading.map((read) => async () => {
          try {
            const answer = await this.deps.toolingQuery(targetOrgId, conditionSoql(read.id!));
            requests += answer.requests;
            read.flow.condition = 'read';
            readFlowMetadata(read.flow, metadataOf(answer));
          } catch (err: unknown) {
            requests++;
            read.flow.condition = 'unreadable';
            refusal ??= extractErrorMessage(err);
          }
        }),
        ...definitionsReading.map(({ read, kind }) => async () => {
          try {
            const soql =
              kind === 'process' ? conditionSoql(read.id!) : ruleDefinitionSoql(read.id!);
            const answer = await this.deps.toolingQuery(targetOrgId, soql);
            requests += answer.requests;
            const metadata = metadataOf(answer);
            if (typeof metadata !== 'object' || metadata === null) {
              read.flow.condition = 'unreadable';
              return;
            }
            read.flow.condition = 'read';
            if (kind === 'process') {
              const objectOfMetadata = readProcessMetadata(read.flow, metadata);
              read.objectApiName ??= objectOfMetadata;
            } else if (!readRuleMetadata(read.flow, metadata)) {
              inactive.add(read.flow);
            }
          } catch (err: unknown) {
            requests++;
            read.flow.condition = 'unreadable';
            definitionRefusal ??= extractErrorMessage(err);
          }
        }),
      ],
      REQUESTS_IN_FLIGHT,
    );
    if (refusal !== undefined) unread.push({ part: 'conditions', reason: refusal });
    if (definitionRefusal !== undefined) {
      unread.push({ part: 'definitions', reason: definitionRefusal });
    }
    // A version the org named in no form an id takes cannot be read either.
    for (const read of [...flows, ...candidates, ...rules]) {
      if (read.id === null) read.flow.condition = 'unreadable';
    }

    const placedProcesses = candidates.flatMap((read) => {
      const objectApiName = ofTheRun(read.objectApiName);
      return objectApiName ? [{ ...read, objectApiName }] : [];
    });
    const activeRules = rules.filter((read) => !inactive.has(read.flow));

    // Whether the user the run writes as holds the permissions named: one
    // request, sent only when a condition names one.
    const named = [...flows, ...placedProcesses, ...activeRules].flatMap(
      (read) => read.flow.permissions,
    );
    if (named.length > 0) {
      const [held] = await inFlight(
        [ask('userPermissions', query(USER_PERMISSIONS_SOQL))],
        REQUESTS_IN_FLIGHT,
      );
      if (!unread.some((u) => u.part === 'userPermissions')) {
        const keys = new Set(
          held.map((row) => permissionKey(text(row.NamespacePrefix), text(row.DeveloperName))),
        );
        for (const permission of named) {
          permission.held = keys.has(permission.name.toLowerCase());
        }
      }
    }

    const assignmentRules = (object: string): ForgeTargetAssignmentRule[] =>
      assignmentRows
        .filter((row) => text(row.SobjectType).toLowerCase() === object.toLowerCase())
        .map((row) => ({ name: text(row.Name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const duplicateRules = (object: string): ForgeTargetDuplicateRule[] =>
      duplicateRows
        .filter((row) => text(row.SobjectType).toLowerCase() === object.toLowerCase())
        .map((row) => ({
          name: text(row.MasterLabel) || text(row.DeveloperName),
          developerName: text(row.DeveloperName),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const byLabel = (a: ForgeTargetFlow, b: ForgeTargetFlow): number =>
      a.label.localeCompare(b.label);
    const on = (list: readonly ReadFlow[], objectApiName: string): ForgeTargetFlow[] =>
      list
        .filter((read) => read.objectApiName === objectApiName)
        .map((read) => read.flow)
        .sort(byLabel);

    const objects: ForgeTargetObjectAutomation[] = objectApiNames
      .map((objectApiName) => ({
        objectApiName,
        flows: on(flows, objectApiName),
        triggers: triggers
          .filter((read) => read.objectApiName === objectApiName)
          .map((read) => read.trigger)
          .sort((a, b) => a.name.localeCompare(b.name)),
        processes: on(placedProcesses, objectApiName),
        workflowRules: on(activeRules, objectApiName),
        assignmentRules: assignmentRules(objectApiName),
        duplicateRules: duplicateRules(objectApiName),
      }))
      .filter(
        (object) =>
          object.flows.length > 0 ||
          object.triggers.length > 0 ||
          object.processes.length > 0 ||
          object.workflowRules.length > 0 ||
          object.assignmentRules.length > 0 ||
          object.duplicateRules.length > 0,
      );

    return {
      objectsRead: [...objectApiNames],
      objects,
      unread,
      conditionsNotRead: toRead.length - reading.length,
      conditionsBound: CONDITIONS_BOUND,
      definitionsNotRead: definitionsToRead.length - definitionsReading.length,
      definitionsBound: DEFINITIONS_BOUND,
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
const KIND_WORDS: Readonly<Record<ForgeAutomationFired['kind'], (name: string) => string>> = {
  flow: (name) => `flow "${name}"`,
  trigger: (name) => `Apex trigger ${name}`,
  process: (name) => `process "${name}"`,
  workflowRule: (name) => `workflow rule "${name}"`,
};
const PART_WORDS: Readonly<Record<ForgeTargetAutomationUnread['part'], string>> = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  conditions: 'the start conditions of some flows',
  processes: 'the Process Builder processes',
  workflowRules: 'the workflow rules',
  definitions: 'the definitions of some processes or workflow rules',
  assignmentRules: 'the assignment rules',
  duplicateRules: 'the duplicate rules',
  userPermissions: 'the custom permissions of the user the run writes as',
};
const MESSAGE_WORDS: Readonly<Record<ForgeMessageAction['kind'], string>> = {
  email: 'email',
  notification: 'custom notification',
  outbound: 'outbound message',
  sms: 'text message',
};

/** A message action as the command's lines say it. */
function messageWords(message: ForgeMessageAction): string {
  const guess = message.guessed ? ' (guessed from the name of an Apex action)' : '';
  return `${MESSAGE_WORDS[message.kind]} "${message.name}"${guess}`;
}

/** A path after commit as the command's lines say it. */
function pathWords(path: ForgeFlowPath): string {
  const label = path.label ? ` "${path.label}"` : '';
  if (path.kind === 'async') return `asynchronous path${label}`;
  if (path.offset === undefined || path.unit === undefined) return `scheduled path${label}`;
  const size = Math.abs(path.offset);
  const unit = size === 1 ? path.unit.replace(/s$/, '') : path.unit;
  const side = path.offset < 0 ? 'before' : 'after';
  return `scheduled path${label} (${size} ${unit} ${side} ${path.field ?? 'the save'})`;
}

/** What a switch is when it keeps the flow quiet, as the command's lines say it. */
function switchWords(test: ForgeFlowSwitch): string {
  const value = test.value === undefined ? 'true' : `'${test.value}'`;
  return test.where === 'decision'
    ? `its first decision ends it when ${test.reference} is ${value}`
    : `not when ${test.reference} is ${value}`;
}

/** What the command's lines say of one flow, trigger, process or rule a write fires. */
function firedNotes(fired: ForgeAutomationFired, write: ForgeAutomationWrite): string[] {
  const flow = fired.flow;
  const permissions = flow?.permissions ?? [];
  const switches = flow?.switches ?? [];
  const messages = flow?.messages ?? [];
  const paths = flow?.paths ?? [];
  const held = (p: ForgeFlowPermission): string =>
    p.held === true ? ' (held)' : p.held === false ? ' (not held)' : '';
  const startBypass = permissions.filter((p) => p.bypass && p.where !== 'decision');
  const decisionBypass = permissions.filter((p) => p.bypass && p.where === 'decision');
  const startNamed = permissions.filter((p) => !p.bypass && p.where !== 'decision');
  const tested = [
    ...permissions.filter((p) => !p.bypass && p.where === 'decision').map((p) => p.name),
    ...switches.filter((s) => !s.bypass).map((s) => s.reference),
  ];
  const definition = fired.kind === 'flow' ? 'start condition' : 'definition';
  return [
    WHEN_WORDS[write][fired.when],
    ...(messages.length > 0 ? [`SENDS MESSAGES: ${messages.map(messageWords).join(', ')}`] : []),
    ...(paths.length > 0 ? [`then after commit: ${paths.map(pathWords).join(', ')}`] : []),
    ...(startBypass.length > 0
      ? [`not for a user with ${startBypass.map((p) => p.name + held(p)).join(', ')}`]
      : []),
    ...(decisionBypass.length > 0
      ? [
          `its first decision ends it for a user with ${decisionBypass.map((p) => p.name + held(p)).join(', ')}`,
        ]
      : []),
    ...switches.filter((s) => s.bypass).map(switchWords),
    ...(fired.keptQuiet ? ['quiet for this run'] : []),
    ...(startNamed.length > 0
      ? [`its start condition names ${startNamed.map((p) => p.name).join(', ')}`]
      : []),
    ...(tested.length > 0 ? [`its decisions test ${tested.join(', ')}`] : []),
    ...(flow?.condition === 'notRead' ? [`${definition} not read`] : []),
    ...(flow?.condition === 'unreadable' ? [`${definition} unreadable`] : []),
  ];
}

/**
 * What the clone command says of the target's automation before it writes:
 * per object, what each write fires — the inserts of the records it creates,
 * the updates of those it writes again, the deletes of a removal of the run —
 * with what of it sends messages or runs after commit, and the assignment and
 * duplicate rules; the custom permissions that keep a flow quiet; what the
 * read could not read or left unread, and what it cost.
 *
 * @param target - The alias of the target, as the command names it.
 * @param options - Whether the run applies the target's assignment rules.
 */
export function automationLines(
  automation: ForgeTargetAutomation,
  target: string,
  options: { applyAssignmentRules?: boolean } = {},
): string[] {
  const lines = [
    `target automation: what ${target} runs on the ${automation.objectsRead.length} object(s) the run writes`,
  ];
  for (const object of automation.objects) {
    lines.push(`  ${object.objectApiName}`);
    for (const { write, fired } of automationByWrite(object)) {
      const entries = fired.map(
        (entry) => `${KIND_WORDS[entry.kind](entry.name)} (${firedNotes(entry, write).join('; ')})`,
      );
      lines.push(`    ${WRITE_WORDS[write]}: ${entries.join(', ')}`);
    }
    for (const rule of object.assignmentRules ?? []) {
      lines.push(
        options.applyAssignmentRules
          ? `    assignment rule "${rule.name}": applied (--apply-assignment-rules): it can give the records it routes another owner, and mail that owner`
          : `    assignment rule "${rule.name}": not applied: the run sends Sforce-Auto-Assign: FALSE and keeps the owner it sets (--apply-assignment-rules applies it)`,
      );
    }
    const duplicates = object.duplicateRules ?? [];
    if (duplicates.length > 0) {
      lines.push(
        `    duplicate rules: ${duplicates.map((rule) => `"${rule.name}"`).join(', ')}: the run ` +
          'saves a record a rule only alerts on; a rule that blocks still refuses it',
      );
    }
  }
  if (automation.objects.length === 0) {
    lines.push(
      blindedBy(automation.unread)
        ? '  nothing found in what could be read'
        : '  no active flow, process, workflow rule, Apex trigger, assignment rule or duplicate rule runs on them',
    );
  }
  const held = heldBypassPermissionsOf(automation);
  const toAssign = bypassPermissionsOf(automation).filter((name) => !held.includes(name));
  if (toAssign.length > 0) {
    lines.push(
      `  bypass: assign ${toAssign.join(', ')} to the user the run writes as, and the flows ` +
        'whose start condition excludes them stay quiet',
    );
  }
  if (held.length > 0) {
    lines.push(
      `  bypass held: the user the run writes as holds ${held.join(', ')}, and what excludes ` +
        'them stays quiet for this run',
    );
  }
  if (automation.conditionsNotRead > 0) {
    lines.push(
      `  ${automation.conditionsNotRead} start condition(s) not read: the read takes ` +
        `${automation.conditionsBound} at most, one request each`,
    );
  }
  if ((automation.definitionsNotRead ?? 0) > 0) {
    lines.push(
      `  ${automation.definitionsNotRead} process or workflow rule definition(s) not read: the ` +
        `read takes ${automation.definitionsBound ?? DEFINITIONS_BOUND} at most, one request each`,
    );
  }
  for (const { part, reason } of automation.unread) {
    lines.push(`  ${PART_WORDS[part]} could not be read: ${reason}`);
  }
  lines.push(`  read in ${automation.requests} request(s) to ${target}`);
  return lines;
}
