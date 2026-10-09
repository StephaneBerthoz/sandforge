/**
 * TargetGapReader reads, from the target org's metadata and before a Forge run
 * reads a row, what of the target will refuse the run's rows or surprise the
 * user: its active validation rules, and what in their formulas keeps them
 * quiet; its active duplicate rules, and whether each blocks an insert or
 * lets it through; the fields only the target requires, which the run does
 * not write; the lookup filters of the lookups it writes; and its daily API
 * budget against what the run will spend. Each is a `ForgeGap` read from
 * metadata (`source: 'metadata'`, `rows: 0`): a simulation finds the same
 * kinds row by row, under the same ids, and the two merge.
 *
 * Run for real, a clone learned of each of these only from the target's
 * refusals, row after row: a required field the source does not have refused
 * every row of its object, and what hung from those rows failed with them.
 *
 * Where each part comes from, as the Salesforce documentation gives it:
 * - the validation rules from `ValidationRule` over the Tooling API, whose
 *   formula is in its `Metadata`, which the org gives one row per query: each
 *   formula costs a request, so the read takes {@link FORMULAS_BOUND} at most;
 * - the duplicate rules from `DuplicateRule` over the regular API, which says
 *   whether a rule is active and on which object, but not what it does: whether
 *   it blocks an insert or allows it, with an alert or a report, is in its
 *   Metadata API definition (`actionOnInsert`, `operationsOnInsert`). Forge
 *   writes with `allowSave=true`, which saves a record a rule allows and never
 *   one it blocks;
 * - the fields from the describes of both orgs, which the run and Review's
 *   metadata diff share: a describe already held costs nothing;
 * - the budget from `/limits` (`DailyApiRequests`), which the org may refuse
 *   to a user without Manage Users: that is said, never taken for enough;
 * - the custom permissions of the user the read runs as — the user the run
 *   writes as — from `UserSetupEntityAccess`, when a formula names one;
 * - for a bypass a formula names that this user does not hold, the
 *   permission sets that include it, smallest first, as the automation read
 *   finds them for a flow (`readBypassGrants`): the command that would assign
 *   the smallest is shown, never run.
 *
 * A part the org refuses is said, with its reason, and the others are read all
 * the same: the read never stops a run.
 */

import type {
  ForgeBypassGrant,
  ForgeConfig,
  ForgeGap,
  ForgeGapDecisionKind,
  ForgeGapSeverity,
  ForgeGraph,
  ForgeTargetGaps,
} from '@sandforge/shared';
import {
  assignPermsetCommand,
  forgeGapId,
  gapAssignEntry,
  gapAssignments,
  mergeGaps,
} from '@sandforge/shared';
import { z } from 'zod';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { ForgePlanGenerator } from './ForgePlanGenerator.js';
import {
  USER_PERMISSIONS_SOQL,
  inFlight,
  objectsTheRunWrites,
  permissionKey,
  permissionsNamed,
  readBypassGrants,
  switchesNamed,
  type QueryAnswer,
} from './TargetAutomationReader.js';

/**
 * The most validation rule formulas a read reads. The org gives a rule's
 * metadata one row per request; an org with dozens of rules on the objects of
 * a clone would otherwise cost as many requests before Review shows anything.
 */
export const FORMULAS_BOUND = 25;

/**
 * Requests in flight at a time. Review reads the target's automation and
 * compares the two orgs' metadata at the same moment: this read keeps four of
 * its own, as the automation read does.
 */
const REQUESTS_IN_FLIGHT = 4;

/** The duplicate rules one Metadata API `readMetadata` call takes. */
const DUPLICATE_RULES_PER_READ = 10;

/** The rows one page of a query gives: the floor of the reads a run makes. */
const ROWS_PER_READ = 2_000;

/** Past this share of its daily limit, a run brings the org near the end of it. */
const BUDGET_NEAR_SHARE = 0.8;

/** A part of the read the org may refuse, as `ForgeTargetGaps.unread` names it. */
export type GapUnreadPart =
  | 'validationRules'
  | 'validationRuleFormulas'
  | 'duplicateRules'
  | 'duplicateRuleActions'
  | 'userPermissions'
  | 'permissionSets'
  | 'targetFields'
  | 'sourceFields'
  | 'apiBudget';

/** A field as the read needs it from an org's describe. */
export interface GapField {
  name: string;
  type: string;
  createable: boolean;
  nillable: boolean;
  /** Whether the org fills the field in at insert when a record leaves it out. */
  defaultedOnCreate: boolean;
  referenceTo: string[];
  /** Active picklist values only. */
  picklistValues: string[];
  /**
   * The lookup filter of a reference field, `optional` when the filter itself
   * is (`filteredLookupInfo.optionalFilter`); `null` when it has none.
   */
  lookupFilter: { optional: boolean } | null;
}

/** A field of a describe as the org answers it, as far as {@link gapFieldOf} reads it. */
export interface DescribedField {
  name: string;
  type: unknown;
  createable?: boolean | null;
  nillable?: boolean | null;
  defaultedOnCreate?: boolean | null;
  referenceTo?: unknown[] | null;
  picklistValues?: ReadonlyArray<{ value?: unknown; active?: unknown } | null> | null;
  filteredLookupInfo?: unknown;
}

/**
 * The lookup filter a describe gives a field (`filteredLookupInfo`), `null`
 * for a field that has none.
 */
function lookupFilterOf(info: unknown): GapField['lookupFilter'] {
  if (typeof info !== 'object' || info === null) return null;
  return { optional: (info as { optionalFilter?: unknown }).optionalFilter === true };
}

/** A field of a describe as the read takes it. A flag the org leaves out reads as its default. */
export function gapFieldOf(field: DescribedField): GapField {
  return {
    name: field.name,
    type: String(field.type),
    createable: field.createable === true,
    nillable: field.nillable !== false,
    defaultedOnCreate: field.defaultedOnCreate === true,
    referenceTo: (field.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
    picklistValues: (field.picklistValues ?? [])
      .filter((p) => p?.active !== false && typeof p?.value === 'string')
      .map((p) => p?.value as string),
    lookupFilter: lookupFilterOf(field.filteredLookupInfo),
  };
}

/** Dependencies for {@link TargetGapReader}. */
export interface TargetGapDeps {
  /** A SOQL query on the regular API of an org, every page of it. */
  query: (orgId: string, soql: string) => Promise<QueryAnswer>;
  /** A SOQL query on the Tooling API of an org, every page of it. */
  toolingQuery: (orgId: string, soql: string) => Promise<QueryAnswer>;
  /**
   * The fields of an object as an org describes them, and whether this call
   * sent the describe: one already held, or under way for another reader,
   * costs this read nothing.
   */
  describeFields: (
    orgId: string,
    objectApiName: string,
  ) => Promise<{ fields: GapField[]; sent: boolean }>;
  /**
   * The Metadata API definitions of duplicate rules, by full name
   * (`<Object>.<DeveloperName>`), {@link DUPLICATE_RULES_PER_READ} at most a
   * call: one request.
   */
  readDuplicateRules: (orgId: string, fullNames: string[]) => Promise<unknown[]>;
  /** The org's `/limits`: one request. */
  readLimits: (orgId: string) => Promise<unknown>;
}

/** What of a run's config tells what it writes, and how much. */
export type GapRunScope = Partial<
  Pick<
    ForgeConfig,
    | 'inputMode'
    | 'recordId'
    | 'maxRecordsPerObject'
    | 'fieldExclusions'
    | 'fieldMappings'
    | 'excludedObjects'
  >
>;

/** The active validation rules of the objects named, over the Tooling API. */
export function validationRulesSoql(objectApiNames: readonly string[]): string {
  const names = objectApiNames.map((name) => `'${name}'`).join(', ');
  return (
    'SELECT Id, ValidationName, NamespacePrefix, ErrorDisplayField, ErrorMessage, ' +
    'EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true ' +
    `AND EntityDefinition.QualifiedApiName IN (${names})`
  );
}

/** The metadata of one validation rule: the only way the org gives its formula. */
export function validationFormulaSoql(ruleId: string): string {
  return `SELECT Metadata FROM ValidationRule WHERE Id = '${ruleId}'`;
}

/** The active duplicate rules of an org, every object's, with the namespace of a packaged one. */
export const ACTIVE_DUPLICATE_RULES_SOQL =
  'SELECT DeveloperName, MasterLabel, NamespacePrefix, SobjectType FROM DuplicateRule ' +
  'WHERE IsActive = true';

/** A 15- or 18-character Salesforce id, as a rule's must be before it goes in a query. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** An API name as it may go in a query. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** What `/limits` says of an org's daily API requests. */
const dailyApiRequestsSchema = z
  .object({
    DailyApiRequests: z.object({ Max: z.number(), Remaining: z.number() }).loose(),
  })
  .loose();

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The API name a relationship to an `EntityDefinition` names, if any. */
function entityName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = (value as { QualifiedApiName?: unknown }).QualifiedApiName;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** A name with its package's namespace before it, as the org spells a packaged one. */
function withNamespace(namespace: string, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

/** The texts a value holds: one text, or a list of them. */
function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The graph as the read takes it: an object the user left out counts as
 * written, so one taken back in on Review has its gaps read already, as its
 * automation has.
 */
function takenBackIn(
  graph: Pick<ForgeGraph, 'nodes' | 'edges'>,
): Pick<ForgeGraph, 'nodes' | 'edges'> {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.leftOutByUser === true ? { ...node, included: true } : node,
    ),
  };
}

/** A validation rule as the read holds it while its formula is read. */
interface ReadRule {
  id: string | null;
  name: string;
  objectApiName: string;
  field?: string;
  message: string;
  formula: 'read' | 'notRead' | 'unreadable';
  /** What keeps the rule from refusing a row, as its formula requires it not to hold. */
  bypasses: string[];
  /** The custom permissions among them, by name. */
  permissions: string[];
}

/**
 * The field a rule shows its error on, as the target names it: the Tooling
 * API gives its API name, sometimes after the object's. A rule that shows its
 * error at the top of the page has none, and the API gives the label of that
 * place instead, in the language of the user it answers — "Haut de la page",
 * run against a real sandbox — which a field of the object's describe tells
 * from a field. Without the describe, a name the API could not give a field
 * is left out all the same.
 *
 * @param fields - The object's fields in the target, when it was described.
 */
function displayFieldOf(
  value: unknown,
  fields: readonly GapField[] | undefined,
): string | undefined {
  const name = text(value).trim();
  const field = name.slice(name.lastIndexOf('.') + 1);
  if (!API_NAME_RE.test(field)) return undefined;
  if (!fields) return field;
  return fields.find((f) => f.name.toLowerCase() === field.toLowerCase())?.name;
}

/**
 * What in a validation rule's formula keeps it from refusing a row: a term
 * the formula requires together with the rest that, holding, makes it false —
 * `NOT($Permission.Bypass)`, `$Setup.Switches__c.Off__c = FALSE`,
 * `$Profile.Name <> 'Integration'`. Read as a flow's start condition is read,
 * the formula of a rule being the condition on which it refuses.
 */
export function bypassesOf(formula: string): { bypasses: string[]; permissions: string[] } {
  const permissions = permissionsNamed({ filterFormula: formula })
    .filter((permission) => permission.bypass)
    .map((permission) => permission.name);
  const switches = switchesNamed(formula).map((test) =>
    test.value === undefined ? test.reference : `${test.reference} = '${test.value}'`,
  );
  return {
    bypasses: [...permissions.map((name) => `$Permission.${name}`), ...switches],
    permissions,
  };
}

/** What a run's rows give the read to estimate its calls by, and how far that holds. */
interface CallsEstimate {
  writes: number;
  reads: number;
  /** `atMost` for a run whose counts bound its rows; `unknown` when an object was never counted. */
  bound: 'exact' | 'atMost' | 'unknown';
}

/**
 * The calls a run of `graph` makes, as far as its counts tell before a row is
 * read: its writes, 200 rows a call as the writer sends them
 * (`ForgePlanGenerator`), and a read of each object for each 2 000 rows it
 * holds. Each table counts for no more than the cap on each object.
 *
 * Discovery counts whole tables: a clone of one record reads the few rows of
 * each table its record reaches, so its estimate is what it makes at most. A
 * graph with an object never counted — a starter template's — and no cap
 * cannot be estimated.
 */
export function callsEstimateOf(graph: ForgeGraph, scope: GapRunScope = {}): CallsEstimate {
  const cap = scope.maxRecordsPerObject;
  const included = graph.nodes.filter((node) => node.included);
  let bound: CallsEstimate['bound'] =
    scope.inputMode === 'record' && typeof scope.recordId === 'string' ? 'atMost' : 'exact';
  const capped = included.map((node) => {
    if (node.recordCountUnknown === true) {
      if (cap === undefined) bound = 'unknown';
      else if (bound === 'exact') bound = 'atMost';
      return { ...node, recordCount: cap ?? 0 };
    }
    return {
      ...node,
      recordCount: cap === undefined ? node.recordCount : Math.min(node.recordCount, cap),
    };
  });
  const writes = new ForgePlanGenerator().generate({ ...graph, nodes: capped }).totalApiCalls;
  const reads = capped.reduce(
    (sum, node) => sum + Math.max(1, Math.ceil(node.recordCount / ROWS_PER_READ)),
    0,
  );
  return { writes, reads, bound };
}

/** A gap read from the target's metadata: it touches no row yet. */
function gapOf(gap: Omit<ForgeGap, 'source' | 'rows' | 'id'> & { idValue?: string }): ForgeGap {
  const { idValue, ...rest } = gap;
  return {
    id: forgeGapId(gap.kind, gap.objectApiName, gap.field, gap.recordType, idValue ?? gap.value),
    source: 'metadata',
    rows: 0,
    ...rest,
  };
}

/** Its own `field` key only when there is one: a gap's detail holds no undefined. */
function fieldKey(field: string | undefined): { field?: string } {
  return field ? { field } : {};
}

/**
 * Reads, from the target org's metadata, what will refuse or surprise a run.
 */
export class TargetGapReader {
  private readonly deps: TargetGapDeps;

  constructor(deps: TargetGapDeps) {
    this.deps = deps;
  }

  /**
   * What `targetOrgId` holds against the rows a run of `graph` writes, from
   * `sourceOrgId`, under `scope`.
   *
   * @param sourceOrgId - The org the run reads, whose describes say what it writes.
   * @param targetOrgId - The org the run writes to.
   * @param graph - The run's graph; an object the user left out is read too.
   * @param scope - What of the run's config tells what it writes, and how much.
   */
  async read(
    sourceOrgId: string,
    targetOrgId: string,
    graph: ForgeGraph,
    scope: GapRunScope = {},
  ): Promise<ForgeTargetGaps> {
    const excluded = new Set(scope.excludedObjects ?? []);
    const objects = objectsTheRunWrites(takenBackIn(graph), excluded);
    const unread: ForgeTargetGaps['unread'] = [];
    if (objects.length === 0) return { gaps: [], unread, requests: 0 };
    let requests = 0;
    const said = (part: GapUnreadPart, reason: string): void => {
      unread.push({ part, reason });
    };
    // API names are the org's to spell: matched whatever their case.
    const wanted = new Map(objects.map((name) => [name.toLowerCase(), name]));
    const ofTheRun = (name: string | undefined): string | undefined =>
      name === undefined ? undefined : wanted.get(name.toLowerCase());
    const order = new Map(objects.map((name, index) => [name, index]));
    const queryable = objects.filter((name) => API_NAME_RE.test(name));

    let ruleRows: Row[] = [];
    let duplicateRows: Row[] = [];
    let limits: unknown;
    let limitsRefusal: string | undefined;
    const targetFields = new Map<string, GapField[]>();
    const sourceFields = new Map<string, GapField[]>();
    const ask =
      (part: GapUnreadPart, run: () => Promise<QueryAnswer>, keep: (rows: Row[]) => void) =>
      async (): Promise<void> => {
        try {
          const answer = await run();
          requests += answer.requests;
          keep(answer.records);
        } catch (err: unknown) {
          requests++;
          said(part, extractErrorMessage(err));
        }
      };
    const describe =
      (orgId: string, objectApiName: string, part: GapUnreadPart, into: Map<string, GapField[]>) =>
      async (): Promise<void> => {
        try {
          const { fields, sent } = await this.deps.describeFields(orgId, objectApiName);
          if (sent) requests++;
          into.set(objectApiName, fields);
        } catch (err: unknown) {
          requests++;
          said(part, `${objectApiName}: ${extractErrorMessage(err)}`);
        }
      };

    await inFlight(
      [
        ...(queryable.length > 0
          ? [
              ask(
                'validationRules',
                () => this.deps.toolingQuery(targetOrgId, validationRulesSoql(queryable)),
                (rows) => {
                  ruleRows = rows;
                },
              ),
            ]
          : []),
        ask(
          'duplicateRules',
          () => this.deps.query(targetOrgId, ACTIVE_DUPLICATE_RULES_SOQL),
          (rows) => {
            duplicateRows = rows;
          },
        ),
        async () => {
          try {
            requests++;
            limits = await this.deps.readLimits(targetOrgId);
          } catch (err: unknown) {
            limitsRefusal = extractErrorMessage(err);
          }
        },
        ...objects.flatMap((name) => [
          describe(targetOrgId, name, 'targetFields', targetFields),
          describe(sourceOrgId, name, 'sourceFields', sourceFields),
        ]),
      ],
      REQUESTS_IN_FLIGHT,
    );

    // The rules nearest the record first: the run's objects come in the order
    // discovery reached them.
    const rules: ReadRule[] = ruleRows
      .flatMap((row): ReadRule[] => {
        const objectApiName = ofTheRun(entityName(row.EntityDefinition));
        const name = text(row.ValidationName);
        if (!objectApiName || !name) return [];
        const id = text(row.Id);
        return [
          {
            id: SF_ID_RE.test(id) ? id : null,
            name: withNamespace(text(row.NamespacePrefix), name),
            objectApiName,
            ...fieldKey(displayFieldOf(row.ErrorDisplayField, targetFields.get(objectApiName))),
            message: text(row.ErrorMessage),
            formula: 'notRead',
            bypasses: [],
            permissions: [],
          },
        ];
      })
      .sort(
        (a, b) =>
          (order.get(a.objectApiName) ?? 0) - (order.get(b.objectApiName) ?? 0) ||
          a.name.localeCompare(b.name),
      );
    const reading = rules.filter((rule) => rule.id !== null).slice(0, FORMULAS_BOUND);
    for (const rule of rules) if (rule.id === null) rule.formula = 'unreadable';

    const duplicates = duplicateRows.flatMap((row) => {
      const objectApiName = ofTheRun(text(row.SobjectType));
      const developerName = withNamespace(text(row.NamespacePrefix), text(row.DeveloperName));
      if (!objectApiName || !text(row.DeveloperName)) return [];
      return [
        {
          objectApiName,
          developerName,
          label: text(row.MasterLabel) || developerName,
          fullName: `${text(row.SobjectType)}.${developerName}`,
        },
      ];
    });
    const definitions = new Map<string, Row>();
    const chunks: string[][] = [];
    for (let at = 0; at < duplicates.length; at += DUPLICATE_RULES_PER_READ) {
      chunks.push(duplicates.slice(at, at + DUPLICATE_RULES_PER_READ).map((d) => d.fullName));
    }

    let formulaRefusal: string | undefined;
    let actionRefusal: string | undefined;
    await inFlight(
      [
        ...reading.map((rule) => async () => {
          try {
            const answer = await this.deps.toolingQuery(
              targetOrgId,
              validationFormulaSoql(rule.id!),
            );
            requests += answer.requests;
            const metadata = answer.records[0]?.Metadata;
            const formula =
              typeof metadata === 'object' && metadata !== null
                ? (metadata as { errorConditionFormula?: unknown }).errorConditionFormula
                : undefined;
            if (typeof formula !== 'string') {
              rule.formula = 'unreadable';
              return;
            }
            rule.formula = 'read';
            Object.assign(rule, bypassesOf(formula));
          } catch (err: unknown) {
            requests++;
            rule.formula = 'unreadable';
            formulaRefusal ??= extractErrorMessage(err);
          }
        }),
        ...chunks.map((fullNames) => async () => {
          try {
            requests++;
            for (const record of await this.deps.readDuplicateRules(targetOrgId, fullNames)) {
              if (typeof record !== 'object' || record === null) continue;
              const definition = record as Row;
              const fullName = text(definition.fullName);
              if (fullName) definitions.set(fullName.toLowerCase(), definition);
            }
          } catch (err: unknown) {
            actionRefusal ??= extractErrorMessage(err);
          }
        }),
      ],
      REQUESTS_IN_FLIGHT,
    );
    if (formulaRefusal !== undefined) said('validationRuleFormulas', formulaRefusal);
    if (actionRefusal !== undefined) said('duplicateRuleActions', actionRefusal);

    // Whether the user the run writes as holds the permissions a formula
    // requires not held: one request, sent only when a formula names one.
    const held = new Set<string>();
    let heldKnown = false;
    if (rules.some((rule) => rule.permissions.length > 0)) {
      await ask(
        'userPermissions',
        () => this.deps.query(targetOrgId, USER_PERMISSIONS_SOQL),
        (rows) => {
          heldKnown = true;
          for (const row of rows) {
            held.add(permissionKey(text(row.NamespacePrefix), text(row.DeveloperName)));
          }
        },
      )();
    }

    // The permission sets that would give the user the bypasses of the rules
    // it does not hold, for the command that assigns the smallest: four
    // requests at most, sent only when such a bypass is named. A rule kept
    // quiet for a flow's bypass was read before; this rule's own was named
    // without what holds it, and finding that was left to the user.
    const missing = [
      ...new Set(
        rules.flatMap((rule) => rule.permissions.filter((name) => !held.has(name.toLowerCase()))),
      ),
    ];
    const grants =
      missing.length > 0
        ? await readBypassGrants(
            missing,
            async (soql) => {
              let rows: Row[] = [];
              await ask(
                'permissionSets',
                () => this.deps.query(targetOrgId, soql),
                (answered) => {
                  rows = answered;
                },
              )();
              return rows;
            },
            () => unread.some((u) => u.part === 'permissionSets'),
          )
        : undefined;

    const gaps: ForgeGap[] = [
      ...rules.map((rule) => validationGap(rule, heldKnown ? held : undefined, grants)),
      ...duplicates.map((rule) => duplicateGap(rule, definitions.get(rule.fullName.toLowerCase()))),
      ...objects.flatMap((objectApiName) => {
        const target = targetFields.get(objectApiName);
        const source = sourceFields.get(objectApiName);
        return target && source ? fieldGaps(objectApiName, target, source, scope) : [];
      }),
    ];
    // An answer without the daily requests is no more an answer than a refusal.
    const parsed = dailyApiRequestsSchema.safeParse(limits);
    const budget =
      limitsRefusal === undefined && parsed.success ? parsed.data.DailyApiRequests : undefined;
    if (!budget) {
      said('apiBudget', limitsRefusal ?? 'the limits the org answered hold no DailyApiRequests');
    }
    gaps.push(budgetGap(graph, scope, objects[0], budget));
    return { gaps: mergeGaps(gaps), unread, requests };
  }
}

/**
 * A validation rule as a gap: a warning, rows may be refused — written again
 * without the field it shows its error on, which is what the writer does with
 * a row a rule refuses on a field. A rule the user the run writes as is kept
 * out of by a permission they hold refuses nothing: an info. For a bypass
 * the user does not hold, the permission sets that hold it, as `grants`
 * found them (`detail.assign`, {@link gapAssignEntry}); nothing when they
 * could not be read, or the user holds a bypass of the rule already.
 */
function validationGap(
  rule: ReadRule,
  held: ReadonlySet<string> | undefined,
  grants: readonly ForgeBypassGrant[] | undefined,
): ForgeGap {
  const heldBypasses = held ? rule.permissions.filter((name) => held.has(name.toLowerCase())) : [];
  const assign =
    heldBypasses.length > 0
      ? []
      : rule.permissions.flatMap((name) => {
          const grant = grants?.find((g) => g.permission.toLowerCase() === name.toLowerCase());
          return grant ? [gapAssignEntry(grant)] : [];
        });
  const decisions: ForgeGapDecisionKind[] = rule.field ? ['leave_empty', 'ignore'] : ['ignore'];
  return gapOf({
    kind: 'validation_rule',
    severity: heldBypasses.length > 0 ? 'info' : 'warning',
    objectApiName: rule.objectApiName,
    ...fieldKey(rule.field),
    idValue: rule.name,
    detail: {
      rule: rule.name,
      message: rule.message,
      formula: rule.formula,
      ...(rule.bypasses.length > 0 ? { bypasses: rule.bypasses } : {}),
      ...(heldBypasses.length > 0 ? { heldBypasses } : {}),
      ...(assign.length > 0 ? { assign } : {}),
    },
    decisions,
    ...(rule.field ? { defaultDecision: 'leave_empty' as const } : {}),
  });
}

/**
 * A duplicate rule as a gap, by what it does on insert. Forge saves with
 * `allowSave=true`: a rule that allows the insert, with an alert or a report,
 * saves the record — an info; one that blocks refuses whatever the header the
 * rows it matches, the row linked to the record it matched when the refusal
 * names exactly one — a warning, as a validation rule's: whether a row
 * matches depends on what the target holds, which the metadata does not say.
 * Read as blocking, it was said of objects the run then wrote no row of; a
 * rehearsal that meets a refusal makes it blocking, with its rows. A rule
 * whose definition was not read may do either.
 */
function duplicateGap(
  rule: { objectApiName: string; developerName: string; label: string },
  definition: Row | undefined,
): ForgeGap {
  const action = text(definition?.actionOnInsert).toLowerCase();
  const known = action === 'block' || action === 'allow' ? action : 'unknown';
  const operations = textsOf(definition?.operationsOnInsert).map((op) => op.toLowerCase());
  const severity: ForgeGapSeverity = known === 'allow' ? 'info' : 'warning';
  return gapOf({
    kind: 'duplicate_rule',
    severity,
    objectApiName: rule.objectApiName,
    idValue: rule.developerName,
    detail: {
      rule: rule.label,
      developerName: rule.developerName,
      action: known,
      ...(known === 'allow' ? { alert: operations.includes('alert') } : {}),
      ...(known === 'allow' ? { report: operations.includes('report') } : {}),
    },
    decisions: known === 'allow' ? ['ignore'] : ['ignore', 'exclude_object'],
    ...(known === 'allow' ? { defaultDecision: 'ignore' as const } : {}),
  });
}

/** Why the run does not write a field the target has. */
type NotWritten = 'notInSource' | 'notCreateableInSource' | 'excluded';

/**
 * The fields only the target requires, and the lookup filters of the lookups
 * the run writes, on one object.
 *
 * A field the run writes is one the source can give and the target takes, as
 * the cleaner writes it (`RecordCleaner`): createable in the source and not
 * left out, or written under the name a field map gives a source field. A
 * field the target requires — not nillable, createable, not filled in by the
 * org at insert — that the run does not write refuses every row of the
 * object (`REQUIRED_FIELD_MISSING`).
 */
function fieldGaps(
  objectApiName: string,
  target: readonly GapField[],
  source: readonly GapField[],
  scope: GapRunScope,
): ForgeGap[] {
  const lower = (name: string): string => name.toLowerCase();
  const excluded = new Set((scope.fieldExclusions?.[objectApiName] ?? []).map(lower));
  const rename = new Map(
    Object.entries(scope.fieldMappings?.[objectApiName] ?? {}).map(([from, to]) => [
      lower(from),
      lower(to),
    ]),
  );
  const renamedTo = new Set(
    [...rename].filter(([from]) => !excluded.has(from)).map(([, to]) => to),
  );
  const inSource = new Map(source.map((field) => [lower(field.name), field]));
  const notWritten = (name: string): NotWritten | undefined => {
    const key = lower(name);
    if (renamedTo.has(key)) return undefined;
    const sourced = inSource.get(key);
    if (!sourced) return 'notInSource';
    if (excluded.has(key) || rename.has(key)) return 'excluded';
    return sourced.createable ? undefined : 'notCreateableInSource';
  };

  return target.flatMap((field): ForgeGap[] => {
    const why = notWritten(field.name);
    if (field.createable && !field.nillable && !field.defaultedOnCreate && why) {
      return [
        gapOf({
          kind: 'required_field_missing',
          severity: 'blocking',
          objectApiName,
          field: field.name,
          detail: {
            type: field.type,
            reason: why,
            ...(field.referenceTo.length > 0 ? { referenceTo: field.referenceTo } : {}),
            ...(field.picklistValues.length > 0 ? { values: field.picklistValues } : {}),
          },
          decisions: ['set_default', 'exclude_object'],
        }),
      ];
    }
    if (field.type === 'reference' && field.lookupFilter && !why) {
      // The writer leaves out a lookup a filter refused when the target lets
      // the row go without it; one it requires leaves the row refused.
      const optional = field.nillable;
      return [
        gapOf({
          kind: 'lookup_filter',
          severity: 'warning',
          objectApiName,
          field: field.name,
          detail: {
            referenceTo: field.referenceTo,
            optional,
            filterOptional: field.lookupFilter.optional,
          },
          decisions: optional ? ['leave_empty', 'ignore'] : ['ignore', 'exclude_object'],
          ...(optional ? { defaultDecision: 'leave_empty' as const } : {}),
        }),
      ];
    }
    return [];
  });
}

/**
 * The run's calls against what the target has left of its daily API
 * requests: blocking past what is left, a warning when the run would bring
 * the org past {@link BUDGET_NEAR_SHARE} of its daily limit, an info
 * otherwise. A run whose estimate only bounds it — a clone of one record —
 * is never said to be refused for it, only that it may be; one that cannot
 * be estimated, and a budget the target would not say, are warnings: neither
 * is taken for enough.
 */
function budgetGap(
  graph: ForgeGraph,
  scope: GapRunScope,
  root: string,
  budget: { Max: number; Remaining: number } | undefined,
): ForgeGap {
  const objectApiName = graph.nodes[0]?.objectApiName ?? root;
  const estimate = callsEstimateOf(graph, scope);
  const calls = estimate.writes + estimate.reads;
  let severity: ForgeGapSeverity = 'warning';
  if (budget && estimate.bound !== 'unknown') {
    const over = calls > budget.Remaining;
    const near = budget.Max - budget.Remaining + calls > BUDGET_NEAR_SHARE * budget.Max;
    severity = over && estimate.bound === 'exact' ? 'blocking' : over || near ? 'warning' : 'info';
  }
  return gapOf({
    kind: 'api_budget',
    severity,
    objectApiName,
    detail: {
      calls,
      writes: estimate.writes,
      reads: estimate.reads,
      estimate: estimate.bound,
      ...(budget ? { max: budget.Max, remaining: budget.Remaining } : { budgetRead: false }),
    },
    decisions: ['ignore'],
  });
}

/** How a severity reads in the command's lines. */
const SEVERITY_WORDS: Readonly<Record<ForgeGapSeverity, string>> = {
  blocking: 'BLOCKING',
  warning: 'warning',
  info: 'info',
};

/** How each part the read could not read is said in the command's lines. */
const PART_WORDS: Readonly<Record<GapUnreadPart, string>> = {
  validationRules: 'the validation rules',
  validationRuleFormulas: 'the formulas of some validation rules',
  duplicateRules: 'the duplicate rules',
  duplicateRuleActions: 'what the duplicate rules do on insert',
  userPermissions: 'the custom permissions of the user the run writes as',
  permissionSets:
    'the permission sets that hold a bypass of a validation rule the user the run writes as does not',
  targetFields: 'the fields of an object in the target',
  sourceFields: 'the fields of an object in the source',
  apiBudget: 'the daily API requests left',
};

/** Why the run does not write a field, as the command's lines say it. */
const NOT_WRITTEN_WORDS: Readonly<Record<string, string>> = {
  notInSource: 'the source has no such field',
  notCreateableInSource: 'the source cannot give it',
  excluded: 'the run leaves it out',
};

/** A number as the command's lines write it. */
const count = (value: unknown): string => (typeof value === 'number' ? String(value) : '?');

/** What the command's lines say of one gap. */
function gapWords(gap: ForgeGap): string {
  const detail = gap.detail ?? {};
  switch (gap.kind) {
    case 'required_field_missing':
      return (
        `required field ${gap.field ?? ''} (${text(detail.type)}): only the target requires it, ` +
        `and the run does not write it (${NOT_WRITTEN_WORDS[text(detail.reason)] ?? text(detail.reason)}): ` +
        'every row is refused unless it is given a value'
      );
    case 'validation_rule': {
      const on = gap.field ? ` on ${gap.field}` : '';
      const notes = [
        ...textsOf(detail.bypasses).map((bypass) => `not when ${bypass}`),
        ...(textsOf(detail.heldBypasses).length > 0
          ? [
              `kept quiet for this run: the user it writes as holds ${textsOf(detail.heldBypasses).join(', ')}`,
            ]
          : []),
        ...(detail.formula === 'notRead' ? ['formula not read'] : []),
        ...(detail.formula === 'unreadable' ? ['formula unreadable'] : []),
        ...(gap.field ? [`a row it refuses goes again without ${gap.field}`] : []),
      ];
      const message = text(detail.message) ? `: "${text(detail.message)}"` : '';
      return `validation rule "${text(detail.rule)}"${on}${message}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
    }
    case 'duplicate_rule': {
      const name = `duplicate rule "${text(detail.rule)}"`;
      if (detail.action === 'block') {
        return `${name}: blocks an insert it matches: a row it matches is refused, whatever allowSave says`;
      }
      if (detail.action === 'allow') {
        const with_ = [
          detail.alert === true ? 'an alert' : '',
          detail.report === true ? 'a report' : '',
        ]
          .filter(Boolean)
          .join(' and ');
        return `${name}: allows an insert it matches${with_ ? `, with ${with_}` : ''}: the run saves it (allowSave=true)`;
      }
      return `${name}: what it does on insert was not read: a rule that blocks refuses a row it matches`;
    }
    case 'lookup_filter':
      return (
        `lookup filter on ${gap.field ?? ''}: not checked before the run; ` +
        (detail.optional === true
          ? 'a lookup it refuses is left empty'
          : 'the lookup is required, and a row it refuses is refused')
      );
    case 'api_budget': {
      const calls = `about ${count(detail.calls)} call(s) (${count(detail.writes)} write(s) of 200 rows, ${count(detail.reads)} read(s))`;
      const bound =
        detail.estimate === 'atMost'
          ? `at most ${calls}, counted on whole tables`
          : detail.estimate === 'unknown'
            ? 'an unknown number of calls: an object was never counted'
            : calls;
      const left =
        detail.budgetRead === false
          ? 'the daily requests left could not be read'
          : `${count(detail.remaining)} of ${count(detail.max)} daily requests left`;
      return `API budget: the run takes ${bound}; ${left}`;
    }
    default:
      return gap.kind;
  }
}

/**
 * What would keep a validation rule quiet, as the command's lines say it
 * under the rule: per bypass the user does not hold, the smallest permission
 * set that holds it and the command that would assign it, shown and never
 * run, or that none holds it.
 */
function assignLines(gap: ForgeGap, target: string, username: string | undefined): string[] {
  return gapAssignments(gap).map(({ permission, permissionSet, others }) => {
    if (!permissionSet) {
      return (
        `      ${permission}: no permission set of ${target} holds it: an admin creates one ` +
        'that includes it'
      );
    }
    const also = others.length > 0 ? `; also held by ${others.map((o) => o.name).join(', ')}` : '';
    const command = username
      ? `: ${assignPermsetCommand(permissionSet.name, target, username)}`
      : '';
    return `      ${permission}: held by permission set ${permissionSet.name}, the smallest${also}${command}`;
  });
}

/**
 * What the clone command says of the target's gaps before it writes: per
 * object, each gap with its severity, and under a validation rule what would
 * keep it quiet for the user the run writes as; the API budget; the
 * validation rule formulas the bound left unread; what the read could not
 * read, and what it cost.
 *
 * @param read - What the read found.
 * @param target - The alias of the target, as the command names it.
 * @param options - The user the run writes as, whom the command that assigns
 *   a bypass names; without it, the permission set is named and no command.
 */
export function gapLines(
  read: ForgeTargetGaps,
  target: string,
  options: { username?: string } = {},
): string[] {
  const lines = [`target gaps: what ${target} holds against the rows, read from its metadata`];
  const budget = read.gaps.filter((gap) => gap.kind === 'api_budget');
  const others = read.gaps.filter((gap) => gap.kind !== 'api_budget');
  const objects = [...new Set(others.map((gap) => gap.objectApiName))].sort((a, b) =>
    a.localeCompare(b),
  );
  for (const object of objects) {
    lines.push(`  ${object}`);
    for (const gap of others.filter((g) => g.objectApiName === object)) {
      lines.push(`    ${SEVERITY_WORDS[gap.severity]}: ${gapWords(gap)}`);
      lines.push(...assignLines(gap, target, options.username));
    }
  }
  if (others.length === 0) {
    lines.push(
      read.unread.length > 0
        ? '  nothing found in what could be read'
        : '  no validation rule, duplicate rule, field only the target requires or lookup filter',
    );
  }
  for (const gap of budget) lines.push(`  ${SEVERITY_WORDS[gap.severity]}: ${gapWords(gap)}`);
  const formulasNotRead = others.filter((gap) => gap.detail?.formula === 'notRead').length;
  if (formulasNotRead > 0) {
    lines.push(
      `  ${formulasNotRead} validation rule formula(s) not read: the read takes ${FORMULAS_BOUND} ` +
        'at most, one request each',
    );
  }
  for (const { part, reason } of read.unread) {
    lines.push(`  ${PART_WORDS[part as GapUnreadPart] ?? part} could not be read: ${reason}`);
  }
  lines.push(`  read in ${read.requests} request(s) to ${target}`);
  return lines;
}
