/**
 * SchemaScanner — Scans source and target org schemas for the Autopilot module.
 * Lists the objects a run may copy, without describing or counting any;
 * discovers the selected objects and the parents their records reference, as
 * far as the bounds go, verifies target org compatibility, and counts the
 * records a run copies: every record of a selected object, to the first
 * {@link FORGE_QUERY_MAX_RECORDS} by Id of a larger one, and of every other
 * object only those the selection references.
 */

import type {
  ApiName,
  AutopilotCurrencyPlan,
  AutopilotLeftOutReason,
  AutopilotLookupLeftEmpty,
  AutopilotObjectListing,
  AutopilotPlanScope,
} from '@sandforge/shared';
import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  STANDARD_PRICEBOOK_SOQL,
  isRequiredLookup,
  isSettableField,
} from '@sandforge/shared';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { excludedByDescribe, isNeverCopied } from '../forge/excludedObjects.js';
import {
  DEFAULT_MAX_NODES,
  FULL_DEPTH,
  REQUIRED_PARENT_CEILING_FACTOR,
} from '../forge/GraphDiscoveryService.js';
import { FORGE_QUERY_MAX_RECORDS, queryAllPages } from '../forge/queryAllPages.js';
import { CURRENCY_FIELD, readRunCurrencies } from '../../core/common/recordCurrencies.js';
import { ACCOUNT, CONTACT } from '../../core/common/platformRecords.js';
import { logger } from '../../logger.js';

/** Abstraction over Salesforce describe API for testability. */
export interface AutopilotConnection {
  /** Describe a single object by API name. */
  describe(objectName: string): Promise<ObjectDescribeResult>;
  /** Describe all objects available in the org. */
  describeGlobal(): Promise<GlobalDescribeResult>;
  /** Execute a SOQL query: its first page. */
  query(soql: string): Promise<QueryResult>;
  /**
   * The next page of a query, by the locator its last page gave. A jsforce
   * connection has it; without it, a read stops at its first page.
   */
  queryMore?(nextRecordsUrl: string): Promise<QueryResult>;
  /**
   * The org's Tooling API, when the connection has one — a jsforce
   * connection does. The objects it serves are metadata, deployed rather
   * than copied as data.
   */
  tooling?: ToolingDescribe;
}

/** What the scan asks of the Tooling API: which objects it serves. */
export interface ToolingDescribe {
  describeGlobal(): Promise<{ sobjects: ReadonlyArray<{ name: string }> }>;
}

/** Subset of Salesforce global describe result. */
export interface GlobalDescribeResult {
  sobjects: GlobalSObjectDescribe[];
}

/** Metadata for a single SObject from global describe. */
export interface GlobalSObjectDescribe {
  name: string;
  label: string;
  custom: boolean;
  /** The three characters every id of the object begins with. */
  keyPrefix?: string | null;
  queryable: boolean;
  createable: boolean;
  deletable: boolean;
  updateable: boolean;
}

/** Full describe result for a single object. */
export interface ObjectDescribeResult {
  name: string;
  label: string;
  custom: boolean;
  keyPrefix: string | null;
  fields: FieldDescribeResult[];
  recordTypeInfos: RecordTypeInfo[];
}

/** Describe metadata for a single field. */
export interface FieldDescribeResult {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  unique: boolean;
  externalId: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  length?: number;
  precision?: number;
  scale?: number;
  defaultValue: unknown;
  picklistValues?: Array<{ value: string; active: boolean; label: string }>;
}

/** Record type information. */
export interface RecordTypeInfo {
  recordTypeId: string;
  name: string;
  active: boolean;
  defaultRecordTypeMapping: boolean;
}

/** SOQL query result. */
export interface QueryResult {
  totalSize: number;
  done: boolean;
  records: Record<string, unknown>[];
  /** The locator of the next page, while there is one. */
  nextRecordsUrl?: string;
}

/** Result of scanning both source and target orgs. */
export interface SchemaScanResult {
  /** Describe results for all selected objects + auto-discovered dependencies. */
  objectDescribes: Map<ApiName, ObjectDescribeResult>;
  /** Objects that were auto-discovered as dependencies. */
  autoDiscoveredObjects: ApiName[];
  /** Objects that exist in source but not in target. */
  missingInTarget: ApiName[];
  /**
   * Records per object a run copies: a selected object's table, and of every
   * other object the records the selection references.
   */
  recordCounts: Map<ApiName, number>;
  /** Total objects scanned. */
  totalObjectsScanned: number;
  /**
   * Of the objects that were not selected, the ids of the records the
   * selection references: a run reads those, by id, and no other record of
   * the object.
   */
  parentIds: Map<ApiName, string[]>;
  /** What the plan copies and what it leaves out: see `AutopilotPlanScope`. */
  scope: AutopilotPlanScope;
  /**
   * Of the accounts and the contacts the plan copies, how many are person
   * accounts or their contacts, in an org that has them: a person account
   * takes 4 KB of the target's storage, its contact none of its own (see
   * `countedStorageBytes`). An object it could not count is absent, and is
   * sized as any record.
   */
  personAccounts: Map<ApiName, number>;
}

/** How far a scan walks from the selected objects, and what it says as it goes. */
export interface ScanOptions {
  /**
   * Lookups followed from a selected object, at most: {@link DEFAULT_SCAN_DEPTH}
   * unless said. A lookup a record cannot be written without is followed
   * past it.
   */
  maxDepth?: number;
  /**
   * Objects a plan holds, the selected ones included: {@link DEFAULT_SCAN_OBJECTS}
   * unless said. Each parent a record cannot be written without raises it by
   * one, to twice it.
   */
  maxObjects?: number;
  /** Told what the scan is doing, for whoever waits on it. */
  onProgress?: (line: string) => void;
}

/** How many levels of lookups a scan follows unless told: Forge's full depth. */
export const DEFAULT_SCAN_DEPTH = FULL_DEPTH;

/** How many objects a plan holds unless told: Forge's object cap. */
export const DEFAULT_SCAN_OBJECTS = DEFAULT_MAX_NODES;

/**
 * Ids one read by id carries: well inside a query URI, and the most a
 * `FIELDS(ALL)` read of the run may ask for.
 */
export const IDS_PER_READ = 200;

/**
 * The fields a price is read with in the scan: its id and lookups, and the
 * currency and selling model the standard price it needs is found by, when
 * the org has them.
 */
function priceFieldsOf(fields: string, describe: ObjectDescribeResult | undefined): string {
  const has = new Set(describe?.fields.map((field) => field.name) ?? []);
  const asked = new Set(fields.split(', '));
  for (const field of [CURRENCY_FIELD, PRICEBOOK_ENTRY_SELLING_MODEL_FIELD]) {
    if (has.has(field)) asked.add(field);
  }
  return [...asked].join(', ');
}

/**
 * Rounds of parents read by id past the depth, for the lookups a record
 * cannot be written without: a chain of them settles in two or three. Frozen
 * Dataset fetches its required parents by the same bound.
 */
const MAX_REQUIRED_ROUNDS = 10;

/**
 * The standard objects a walk follows when standard objects are not asked
 * for, as it follows a custom one: the account. Left out with the others, a
 * plan of opportunities left every `Opportunity.AccountId` empty, and the
 * opportunities went in without the accounts they belong to. The other
 * standard objects — a user's, a campaign, a price book — still wait for
 * the run to be asked to take them.
 */
const FOLLOWED_BY_DEFAULT: ReadonlySet<ApiName> = new Set([ACCOUNT]);

/** The flag of an account, and of a contact, that tells a person account's. */
const PERSON_ACCOUNT_FLAG = 'IsPersonAccount';

/** A lookup of a planned object to another, as the walk of the records follows it. */
interface PlannedLookup {
  field: string;
  targets: ApiName[];
  required: boolean;
}

/**
 * Scans source and target org schemas for the Autopilot module.
 * Discovers the selected objects and the parents their records reference,
 * within the bounds; checks target org compatibility; counts the records a
 * run copies.
 */
export class SchemaScanner {
  private readonly maxConcurrent: number;

  /**
   * @param maxConcurrent - Maximum number of parallel describe calls.
   */
  constructor(maxConcurrent: number = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * The objects a run may copy, for the user to choose from: the source's
   * queryable, creatable objects — custom ones only unless standard objects
   * are asked for — less those no copy writes, as the target's global
   * describe and its Tooling API say (`isNeverCopied`), each with its label
   * and whether it is custom.
   *
   * Two global describes and the Tooling API's, and nothing per object. The
   * panel's first scan used to be `scan` with nothing selected, which
   * described every object it listed and counted each table: on a client
   * sandbox of some six hundred and seventy custom objects, hundreds of calls
   * before the user had picked anything. What is picked is counted on its
   * own (`countObjects`), and scanned (`scan`).
   *
   * An object the target's global describe does not list is listed all the
   * same, marked `missingInTarget`: the picker shows it and does not let it
   * be picked. Offered as any other, a custom object never deployed to the
   * target was picked, scanned and planned, and every one of its records
   * refused at the write. So is one whose records the target's user may not
   * create, marked `notCreateableInTarget`.
   *
   * Reading needs no Create: an object is listed when the user of either org
   * may create its records. Listed only when the source's user could, a
   * read-only source user had an empty picker; and an object the target's
   * user could not create was dropped with the platform's own, with no word.
   */
  async listObjects(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    includeStandardObjects: boolean,
  ): Promise<AutopilotObjectListing[]> {
    const [sourceGlobal, targetGlobal] = await Promise.all([
      sourceConn.describeGlobal(),
      targetConn.describeGlobal(),
    ]);
    const createableInSource = new Set(
      sourceGlobal.sobjects.filter((s) => s.createable).map((s) => s.name),
    );
    // An object no user of either org may create is one no copy writes, as
    // the platform's own records are; one the source's user may create is
    // the target user's to be refused, said on the object.
    const described = excludedByDescribe(
      targetGlobal.sobjects.filter((t) => !createableInSource.has(t.name)),
      await this.toolingObjects(targetConn),
    );
    const inTarget = new Map(targetGlobal.sobjects.map((t) => [t.name, t.createable !== false]));
    return sourceGlobal.sobjects
      .filter((s) => s.queryable && (s.createable || inTarget.get(s.name) === true))
      .filter((s) => includeStandardObjects || s.custom)
      .filter((s) => !isNeverCopied(s.name, described))
      .map((s) => ({
        apiName: s.name,
        label: s.label,
        custom: s.custom,
        ...(!inTarget.has(s.name)
          ? { missingInTarget: true as const }
          : inTarget.get(s.name) === false
            ? { notCreateableInTarget: true as const }
            : {}),
      }));
  }

  /**
   * How many records each of `objectNames` holds in the org: one `COUNT()`
   * each, `maxConcurrent` at a time. An object the
   * org will not count is left out of the answer.
   */
  async countObjects(
    conn: AutopilotConnection,
    objectNames: ApiName[],
  ): Promise<Map<ApiName, number>> {
    return this.countRecords(conn, objectNames);
  }

  /**
   * Scan schemas on source and target orgs.
   *
   * 1. Walk from the selected objects' records to the records they
   *    reference, as far as `options` lets it: a selected object's table is
   *    copied, to its first {@link FORGE_QUERY_MAX_RECORDS} records by Id, and
   *    of every other object the records the selection references, read by
   *    id.
   * 2. Verify objects exist on target org.
   *
   * @param sourceConn - Connection to the source org.
   * @param targetConn - Connection to the target org.
   * @param selectedObjects - Objects explicitly selected by the user: at least one.
   * @param includeStandardObjects - Whether a standard object is taken when
   *   the walk reaches one a record can be written without; the account is
   *   either way ({@link FOLLOWED_BY_DEFAULT}).
   * @param options - How far the walk goes, and who hears of its progress.
   * @returns Schema scan result with describes, dependencies, and record counts.
   * @throws When nothing is selected: see `listObjects`.
   */
  async scan(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    selectedObjects: ApiName[],
    includeStandardObjects: boolean,
    options: ScanOptions = {},
  ): Promise<SchemaScanResult> {
    const maxDepth = wholeOr(options.maxDepth, DEFAULT_SCAN_DEPTH);
    const maxObjects = wholeOr(options.maxObjects, DEFAULT_SCAN_OBJECTS);
    const say = options.onProgress ?? ((): void => {});

    // With nothing selected, the scan described every object of the org and
    // counted every table, and a plan of all of it was what came out. The
    // choice is made from `listObjects`; a scan starts from what was chosen.
    if (selectedObjects.length === 0) {
      throw new Error(
        'Choose the objects to copy: a scan starts from them, and with none chosen it would ' +
          'describe and count every object of the org.',
      );
    }

    // What the source says of each object: whether it is custom, and the key
    // prefix that tells which object a polymorphic lookup's id belongs to.
    const sourceGlobal = await sourceConn.describeGlobal();

    let rootObjects: ApiName[] = [...selectedObjects];

    /*
     * What the target itself says no copy writes: the objects its Tooling API
     * serves, which are metadata, and those its data API will not create.
     * Read before the walk, because the walk is where they came in: from a
     * product to the external data source it may name, to that source's auth
     * provider and the Apex class behind it, and from a location's logo into
     * the Content objects — a real run copied those whole tables.
     */
    const targetGlobal = await targetConn.describeGlobal();
    const described = excludedByDescribe(
      targetGlobal.sobjects,
      await this.toolingObjects(targetConn),
    );
    const leftOut = (name: ApiName): boolean => isNeverCopied(name, described);

    /*
     * Applied to a selection as well as to the listing, because the rule is
     * about what a copy can do and not about how the name got into the list.
     * A saved configuration, a template, or a picker written before this
     * existed can all carry one, and filtering only the listed half would
     * have left the run that started this — 39 `User` records in wave one —
     * reachable from a saved config.
     *
     * `createable` is the platform's answer to "can the API create one", and
     * for `User` it is yes: at the cost of a licence and a globally unique
     * username. `RecordType`, `Profile` and the sharing groups are metadata,
     * deployed rather than inserted. A node that fails in wave one leaves every
     * later wave remapping foreign keys onto records that were never created.
     */
    rootObjects = rootObjects.filter((name) => !leftOut(name));

    // Step 2: Describe all root objects on source
    say(`describing ${rootObjects.length} selected object(s)…`);
    const objectDescribes = await this.describeAll(sourceConn, rootObjects);
    const selected = new Set(objectDescribes.keys());

    // Step 3: Walk the records to the parents they reference, within the bounds
    const custom = new Map(sourceGlobal.sobjects.map((s) => [s.name, s.custom]));
    const keyPrefixes = new Map<string, ApiName>();
    for (const s of sourceGlobal.sobjects) if (s.keyPrefix) keyPrefixes.set(s.keyPrefix, s.name);
    const walk = await this.walkRecords(sourceConn, objectDescribes, selected, {
      isStandard: (name) =>
        custom.get(name) === false || (!custom.has(name) && !name.includes('__')),
      includeStandardObjects,
      leftOut,
      keyPrefixes,
      maxDepth,
      maxObjects,
      say,
    });

    // Step 4: Verify objects exist on target org
    const targetObjectNames = new Set(targetGlobal.sobjects.map((s) => s.name));
    const missingInTarget = [...objectDescribes.keys()].filter(
      (name) => !targetObjectNames.has(name),
    );

    // Step 5: the currencies the target does not hold active, said by the plan
    // before anything is written: a record in one goes in the target's
    // corporate currency, its amounts converted.
    const currencies = await this.currenciesOf(sourceConn, targetConn, objectDescribes);

    // Step 6: the person accounts among the accounts and contacts the plan
    // copies, which the write gate sizes as Salesforce counts them.
    const personAccounts = await this.personAccountsOf(
      sourceConn,
      objectDescribes,
      selected,
      walk.parentIds,
      { cutShort: walk.cutShort, cutAt: walk.cutAt },
    );

    return {
      objectDescribes,
      autoDiscoveredObjects: walk.added,
      missingInTarget,
      recordCounts: walk.recordCounts,
      totalObjectsScanned: objectDescribes.size,
      parentIds: walk.parentIds,
      personAccounts,
      scope: {
        maxDepth,
        maxObjects,
        selected: [...selected],
        parents: walk.added.map((objectApiName) => ({
          objectApiName,
          records: walk.parentIds.get(objectApiName)?.length ?? 0,
        })),
        leftEmpty: walk.leftEmpty,
        standardNeeded: walk.standardNeeded,
        ...(walk.followedByDefault.length > 0 ? { followedByDefault: walk.followedByDefault } : {}),
        ...(currencies ? { currencies } : {}),
        ...(walk.cutShort.length > 0 ? { cutShort: walk.cutShort } : {}),
      },
    };
  }

  /**
   * Of the accounts and the contacts the plan copies, how many are person
   * accounts or their contacts: of a selected object, its table's, one
   * `COUNT()` — of one cut to its first records by Id, those up to the last
   * the run copies; of one read by id, those of its ids, a `COUNT()` per
   * {@link IDS_PER_READ} of them. Asked only of an object the source
   * describes `IsPersonAccount` on; one the source will not count is left
   * out, and sized as any record.
   *
   * The write gate counted every record at 2 KB, where Salesforce counts a
   * person account at 4 KB, being an account and a contact, and its contact
   * at nothing of its own: Forge's gate sizes them so, and a plan of person
   * accounts said half the storage it would take.
   *
   * @param cut - The selected objects cut to their first records by Id, and
   *   the last Id each read took where it read them.
   */
  private async personAccountsOf(
    conn: AutopilotConnection,
    describes: ReadonlyMap<ApiName, ObjectDescribeResult>,
    selected: ReadonlySet<ApiName>,
    parentIds: ReadonlyMap<ApiName, readonly string[]>,
    cut: {
      cutShort: NonNullable<AutopilotPlanScope['cutShort']>;
      cutAt: ReadonlyMap<ApiName, string>;
    },
  ): Promise<Map<ApiName, number>> {
    const counts = new Map<ApiName, number>();
    for (const name of [ACCOUNT, CONTACT]) {
      const describe = describes.get(name);
      if (!describe?.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG)) continue;
      const of = `SELECT COUNT() FROM ${assertSoqlIdentifier(name)} WHERE ${PERSON_ACCOUNT_FLAG} = true`;
      try {
        // Of a table cut to its first records by Id, those the run copies:
        // counted across the whole table, a cut of 50 000 accounts out of
        // two million was sized as a million person accounts.
        const copied = cut.cutShort.find((entry) => entry.objectApiName === name)?.copied;
        if (selected.has(name) && copied !== undefined) {
          const last = cut.cutAt.get(name) ?? (await this.lastIdOfTheFirst(conn, name, copied));
          counts.set(
            name,
            last !== undefined
              ? (await conn.query(`${of} AND Id <= '${sanitizeSoqlValue(last)}'`)).totalSize
              : // Where the cut's last record cannot be read, no more than
                // the run copies: an estimate that errs says too much.
                Math.min((await conn.query(of)).totalSize, copied),
          );
          continue;
        }
        if (selected.has(name)) {
          counts.set(name, (await conn.query(of)).totalSize);
          continue;
        }
        let persons = 0;
        for (const chunk of this.chunk([...(parentIds.get(name) ?? [])], IDS_PER_READ)) {
          const list = chunk.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
          persons += (await conn.query(`${of} AND Id IN (${list})`)).totalSize;
        }
        counts.set(name, persons);
      } catch (err) {
        logger.warn('Autopilot could not count the person accounts it copies', {
          objectApiName: name,
          error: extractErrorMessage(err),
        });
      }
    }
    return counts;
  }

  /**
   * The Id of the `count`-th record of an object by Id: the last a run that
   * copies its first `count` records takes. Undefined when the read stops
   * short of it.
   */
  private async lastIdOfTheFirst(
    conn: AutopilotConnection,
    objectApiName: ApiName,
    count: number,
  ): Promise<string | undefined> {
    const { records } = await this.readAll(
      conn,
      `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)} ORDER BY Id`,
    );
    const id = records.length >= count ? records[count - 1]?.Id : undefined;
    return typeof id === 'string' ? id : undefined;
  }

  /**
   * The currencies the source holds active that the target does not, with
   * the corporate currency a record in one is written in and the objects of
   * the plan that carry a currency (`core/common/recordCurrencies.ts`):
   * nothing when no object carries one, when either org holds a single
   * currency, or when the target holds every one.
   */
  private async currenciesOf(
    sourceConn: AutopilotConnection,
    targetConn: AutopilotConnection,
    describes: ReadonlyMap<ApiName, ObjectDescribeResult>,
  ): Promise<AutopilotCurrencyPlan | undefined> {
    const objects = [...describes.values()]
      .filter((describe) => describe.fields.some((field) => field.name === CURRENCY_FIELD))
      .map((describe) => describe.name)
      .sort();
    if (objects.length === 0) return undefined;
    const read = await readRunCurrencies(
      async (soql) => (await sourceConn.query(soql)).records,
      async (soql) => (await targetConn.query(soql)).records,
    );
    const writtenIn = read?.target.corporate;
    if (!read || writtenIn === undefined) return undefined;
    const notInTarget = [...read.source.active].filter((code) => !read.target.active.has(code));
    return notInTarget.length > 0
      ? { notInTarget: notInTarget.sort(), writtenIn, objects }
      : undefined;
  }

  /**
   * Walk from the selected objects' records to the records they reference,
   * level by level: an object enters the plan when a record the plan copies
   * points at one of its records, and of it the plan copies those records
   * alone, read by id — as Forge reads the parents a record requires outside
   * its graph.
   *
   * Run for real, the walk followed every lookup of every object it reached,
   * with no bound, and counted their whole tables: a lead's converted
   * account, the account's operating hours, a custom object's postcode table
   * of sixty thousand rows, and on until six hundred objects of a client
   * sandbox and 2.6 million records were in a plan for two objects.
   * `includeStandardObjects` filtered the objects found when none were
   * selected, never those the walk reached.
   *
   * A lookup is followed while the record holding it is fewer than `maxDepth`
   * levels from a selected one, while the plan holds fewer than `maxObjects`
   * objects, and to a standard object only when standard objects were asked
   * for — save the account, followed either way ({@link FOLLOWED_BY_DEFAULT})
   * and said so. A lookup a record cannot be written without is followed past
   * all three — the record would be refused otherwise — and raises the object
   * bound by one, to twice it, as Forge's discovery does for a required
   * parent. A lookup that holds values and is not followed is listed with
   * why: the run leaves it empty. One that holds none takes nothing into the
   * plan, so a polymorphic lookup's hundred possible objects cost nothing
   * unless a record names one of them.
   */
  private async walkRecords(
    conn: AutopilotConnection,
    describes: Map<ApiName, ObjectDescribeResult>,
    selected: ReadonlySet<ApiName>,
    bounds: {
      isStandard: (name: ApiName) => boolean;
      includeStandardObjects: boolean;
      leftOut: (name: ApiName) => boolean;
      keyPrefixes: ReadonlyMap<string, ApiName>;
      maxDepth: number;
      maxObjects: number;
      say: (line: string) => void;
    },
  ): Promise<{
    added: ApiName[];
    leftEmpty: AutopilotLookupLeftEmpty[];
    standardNeeded: AutopilotPlanScope['standardNeeded'];
    followedByDefault: NonNullable<AutopilotPlanScope['followedByDefault']>;
    cutShort: NonNullable<AutopilotPlanScope['cutShort']>;
    /** Of each selected object cut short as its lookups were read, the last Id read. */
    cutAt: Map<ApiName, string>;
    recordCounts: Map<ApiName, number>;
    parentIds: Map<ApiName, string[]>;
  }> {
    const planned = new Set<ApiName>(selected);
    const unreadable = new Set<ApiName>();
    let budget = bounds.maxObjects;
    const ceiling = bounds.maxObjects * REQUIRED_PARENT_CEILING_FACTOR;
    const leftEmpty = new Map<string, AutopilotLookupLeftEmpty>();
    const standardNeeded: AutopilotPlanScope['standardNeeded'] = [];
    const followedByDefault: NonNullable<AutopilotPlanScope['followedByDefault']> = [];
    const cutShort: NonNullable<AutopilotPlanScope['cutShort']> = [];
    const cutAt = new Map<ApiName, string>();
    const added: ApiName[] = [];
    const recordCounts = new Map<ApiName, number>();
    /** Of each object read by id, the ids of the records read. */
    const read = new Map<ApiName, Set<string>>();
    /** The lookups of an object a copy writes, to objects a copy may write. */
    const lookups = (name: ApiName): PlannedLookup[] => {
      const describe = describes.get(name);
      if (!describe) return [];
      return lookupsOf(name, describe)
        .map((lookup) => ({
          ...lookup,
          targets: lookup.targets.filter((t) => !bounds.leftOut(t) && !unreadable.has(t)),
        }))
        .filter((lookup) => lookup.targets.length > 0);
    };
    /** The fields a read of an object asks for: its id and its lookups. */
    const fieldsOf = (name: ApiName): string =>
      ['Id', ...new Set(lookups(name).map((lookup) => lookup.field))]
        .map(assertSoqlIdentifier)
        .join(', ');
    const noteLeftEmpty = (
      via: { objectApiName: ApiName; field: string; required: boolean },
      target: ApiName,
      reason: AutopilotLeftOutReason,
    ): void => {
      const key = `${via.objectApiName}.${via.field}>${target}`;
      if (leftEmpty.has(key)) return;
      leftEmpty.set(key, {
        objectApiName: via.objectApiName,
        fieldApiName: via.field,
        target,
        reason,
        ...(via.required ? { required: true as const } : {}),
      });
    };

    /** Per object a record of the current level points at: the ids, and through which lookups. */
    type Met = {
      ids: Set<string>;
      required: boolean;
      via: Array<{ objectApiName: ApiName; field: string; required: boolean }>;
    };
    let met = new Map<ApiName, Met>();
    /** Note the parents the rows of `objectApiName` name, as far as their level allows. */
    const meet = (objectApiName: ApiName, rows: Record<string, unknown>[], level: number): void => {
      const own = lookups(objectApiName);
      for (const row of rows) {
        for (const lookup of own) {
          const value = row[lookup.field];
          if (typeof value !== 'string' || value === '') continue;
          const target = ownerOf(value, lookup.targets, bounds.keyPrefixes);
          // A selected object is copied whole: its records are there already.
          if (!target || selected.has(target)) continue;
          const via = { objectApiName, field: lookup.field, required: lookup.required };
          if (level >= bounds.maxDepth && !lookup.required) {
            if (!planned.has(target)) noteLeftEmpty(via, target, 'depth');
            continue;
          }
          if (read.get(target)?.has(value)) continue;
          const entry = met.get(target) ?? { ids: new Set<string>(), required: false, via: [] };
          entry.ids.add(value);
          entry.required ||= lookup.required;
          if (
            !entry.via.some((v) => v.objectApiName === objectApiName && v.field === lookup.field)
          ) {
            entry.via.push(via);
          }
          met.set(target, entry);
        }
      }
    };

    // The selected objects, whole: their lookups read where any leads to an
    // object that was not selected, counted otherwise.
    const counted: ApiName[] = [];
    for (const name of selected) {
      const onward = lookups(name).filter((lookup) =>
        lookup.targets.some((target) => !selected.has(target)),
      );
      if (onward.length === 0) {
        counted.push(name);
        continue;
      }
      bounds.say(`reading the lookups of ${name}…`);
      try {
        const fields = ['Id', ...new Set(onward.map((lookup) => lookup.field))]
          .map(assertSoqlIdentifier)
          .join(', ');
        // In the order of the ids, as the run copies the object: a read cut
        // at its bound holds the records the run takes, and the parents it
        // plans are theirs. Read in no order, the plan held the parents of
        // one sample of a table of millions and the run copied another.
        const { records: rows, truncated } = await this.readAll(
          conn,
          `SELECT ${fields} FROM ${assertSoqlIdentifier(name)} ORDER BY Id`,
        );
        recordCounts.set(name, rows.length);
        if (truncated) {
          // Said in the plan, with what the source holds: a warning in the
          // log alone left Step 4 showing the bound beside a count of millions.
          const total = (await this.countRecords(conn, [name])).get(name);
          cutShort.push({
            objectApiName: name,
            copied: rows.length,
            ...(total !== undefined ? { total } : {}),
          });
          const last = rows[rows.length - 1]?.Id;
          if (typeof last === 'string') cutAt.set(name, last);
        }
        meet(name, rows, 0);
      } catch (err) {
        logger.warn('Autopilot could not read the lookups of a selected object', {
          objectApiName: name,
          error: extractErrorMessage(err),
        });
        counted.push(name);
      }
    }
    // A table with no lookup to follow is copied to the bound a table with
    // one is read to, and the plan says so: whether a lookup leads out of the
    // selection decided whether two million rows went in whole or their
    // first 50 000, and every record a run copies holds an id in its map.
    for (const [name, count] of await this.countRecords(conn, counted)) {
      if (count > FORGE_QUERY_MAX_RECORDS) {
        recordCounts.set(name, FORGE_QUERY_MAX_RECORDS);
        cutShort.push({ objectApiName: name, copied: FORGE_QUERY_MAX_RECORDS, total: count });
      } else {
        recordCounts.set(name, count);
      }
    }

    const rounds = bounds.maxDepth + MAX_REQUIRED_ROUNDS;
    for (let level = 1; met.size > 0 && level <= rounds; level++) {
      const current = met;
      met = new Map();

      // The objects the level's records point at that the plan does not
      // hold yet: taken in, or left out with why.
      const fresh: ApiName[] = [];
      for (const [target, entry] of current) {
        if (planned.has(target)) continue;
        const standard = bounds.isStandard(target) && !bounds.includeStandardObjects;
        const byDefault = standard && !entry.required && FOLLOWED_BY_DEFAULT.has(target);
        let reason: AutopilotLeftOutReason | undefined;
        if (standard && !entry.required && !byDefault) {
          reason = 'standard';
        } else if (planned.size >= budget) {
          if (entry.required && budget < ceiling) budget++;
          else reason = 'objects';
        }
        if (reason) {
          for (const via of entry.via) noteLeftEmpty(via, target, reason);
          current.delete(target);
          continue;
        }
        planned.add(target);
        fresh.push(target);
        if (byDefault) {
          followedByDefault.push({
            objectApiName: target,
            referencedBy: entry.via.map((via) => `${via.objectApiName}.${via.field}`),
          });
        } else if (standard) {
          const first = entry.via[0];
          standardNeeded.push({
            objectApiName: target,
            neededBy: `${first.objectApiName}.${first.field}`,
          });
        }
      }
      if (fresh.length > 0) {
        bounds.say(`describing ${fresh.length} parent object(s) at depth ${level}…`);
        const described = await this.describeAll(conn, fresh);
        for (const name of fresh) {
          const describe = described.get(name);
          if (describe) {
            describes.set(name, describe);
            added.push(name);
          } else {
            // Not described, so not copied: the lookups at it stay empty.
            planned.delete(name);
            unreadable.add(name);
            current.delete(name);
          }
        }
      }

      // The records the level names, read by id with the lookups that lead on.
      for (const [name, entry] of current) {
        const ids = [...entry.ids].filter((id) => !read.get(name)?.has(id));
        if (ids.length === 0) continue;
        bounds.say(`reading ${ids.length} ${name} record(s) by id…`);
        const kept = read.get(name) ?? new Set<string>();
        read.set(name, kept);
        const prices = name === PRICEBOOK_ENTRY_OBJECT;
        const fields = prices ? priceFieldsOf(fieldsOf(name), describes.get(name)) : fieldsOf(name);
        const readNow: Record<string, unknown>[] = [];
        for (const chunk of this.chunk(ids, IDS_PER_READ)) {
          const where = chunk.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
          const answer = await conn.query(
            `SELECT ${fields} FROM ${assertSoqlIdentifier(name)} WHERE Id IN (${where})`,
          );
          const rows = answer.records.filter((row) => typeof row['Id'] === 'string');
          for (const row of rows) kept.add(row['Id'] as string);
          readNow.push(...rows);
          meet(name, rows, level);
        }
        // A custom price is refused for a product the target holds no
        // standard price of, in its currency: the standard prices of the
        // products the prices read price, read with them. Read by id alone,
        // an opportunity's lines from a custom book were all held back, their
        // prices refused STANDARD_PRICE_NOT_DEFINED.
        if (prices) {
          const standard = await this.standardPricesOf(conn, fields, readNow, kept);
          if (standard.length > 0) {
            bounds.say(`reading ${standard.length} standard price(s) the prices need…`);
            for (const row of standard) kept.add(row['Id'] as string);
            // Their book is the standard one, matched in the target and never
            // written: what they bring is their product and selling model.
            meet(
              name,
              standard.map((row) => ({ ...row, [PRICEBOOK_ENTRY_BOOK_FIELD]: undefined })),
              level,
            );
          }
        }
      }
    }

    const parentIds = new Map<ApiName, string[]>();
    for (const name of added) {
      const ids = [...(read.get(name) ?? [])];
      parentIds.set(name, ids);
      recordCounts.set(name, ids.length);
    }
    return {
      added,
      // Left empty from one object, and taken in through another: not left out.
      leftEmpty: [...leftEmpty.values()].filter((lookup) => !planned.has(lookup.target)),
      standardNeeded,
      // Followed, and not described: not copied, and not said to be.
      followedByDefault: followedByDefault.filter((followed) =>
        planned.has(followed.objectApiName),
      ),
      cutShort,
      cutAt,
      recordCounts,
      parentIds,
    };
  }

  /**
   * The standard prices the custom prices of `prices` need and the read does
   * not hold: of their products, in their currencies, under their selling
   * models when the prices carry one. Nothing when every price read is a
   * standard one, or the source will not answer.
   *
   * @param fields - The fields a price is read with ({@link priceFieldsOf}).
   * @param held - The ids of the prices read already.
   */
  private async standardPricesOf(
    conn: AutopilotConnection,
    fields: string,
    prices: readonly Record<string, unknown>[],
    held: ReadonlySet<string>,
  ): Promise<Record<string, unknown>[]> {
    const pairOf = (row: Record<string, unknown>): string =>
      [
        row[PRICEBOOK_ENTRY_PRODUCT_FIELD],
        row[CURRENCY_FIELD],
        row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD],
      ]
        .map((value) => String(value ?? ''))
        .join('|');
    try {
      const [book] = (await conn.query(STANDARD_PRICEBOOK_SOQL)).records;
      const standardId = book?.['Id'];
      if (typeof standardId !== 'string') return [];
      const custom = prices.filter((row) => row[PRICEBOOK_ENTRY_BOOK_FIELD] !== standardId);
      const products = [
        ...new Set(
          custom.flatMap((row) => {
            const product = row[PRICEBOOK_ENTRY_PRODUCT_FIELD];
            return typeof product === 'string' && product !== '' ? [product] : [];
          }),
        ),
      ];
      if (products.length === 0) return [];
      const pairs = new Set(custom.map(pairOf));
      const found: Record<string, unknown>[] = [];
      for (const chunk of this.chunk(products, IDS_PER_READ)) {
        const where = chunk.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
        const answer = await conn.query(
          `SELECT ${fields} FROM ${PRICEBOOK_ENTRY_OBJECT} WHERE ` +
            `${PRICEBOOK_ENTRY_BOOK_FIELD} = '${sanitizeSoqlValue(standardId)}' AND ` +
            `${PRICEBOOK_ENTRY_PRODUCT_FIELD} IN (${where})`,
        );
        for (const row of answer.records) {
          const id = row['Id'];
          if (typeof id !== 'string' || held.has(id) || !pairs.has(pairOf(row))) continue;
          found.push(row);
        }
      }
      return found;
    } catch (err) {
      logger.warn('Autopilot could not read the standard prices its prices need', {
        error: extractErrorMessage(err),
      });
      return [];
    }
  }

  /**
   * Every page of a read, when the connection can turn them; its first
   * otherwise. `truncated` when a bound, or a connection that turns no page,
   * left records unread.
   */
  private async readAll(
    conn: AutopilotConnection,
    soql: string,
  ): Promise<{ records: Record<string, unknown>[]; truncated: boolean }> {
    const { queryMore } = conn;
    if (!queryMore) {
      const first = await conn.query(soql);
      return { records: first.records, truncated: first.done === false };
    }
    const pages = await queryAllPages<Record<string, unknown>>(
      { query: (q) => conn.query(q), queryMore: (url) => queryMore.call(conn, url) },
      soql,
    );
    if (pages.truncated) {
      logger.warn('Autopilot read the lookups of a selected object to its bound only', {
        records: pages.records.length,
      });
    }
    return { records: pages.records, truncated: pages.truncated };
  }

  /**
   * The objects the org's Tooling API serves, or none when it cannot say —
   * a connection without one, or a user the org does not let read it. The
   * data API's own answer, and the list of objects every copy leaves out,
   * still apply.
   */
  private async toolingObjects(conn: AutopilotConnection): Promise<string[]> {
    if (!conn.tooling) return [];
    try {
      const answer = await conn.tooling.describeGlobal();
      return answer.sobjects.map((sobject) => sobject.name);
    } catch (err) {
      logger.warn('Autopilot could not ask the Tooling API which objects are metadata', {
        error: extractErrorMessage(err),
      });
      return [];
    }
  }

  /**
   * Describe objects in parallel batches, respecting maxConcurrent.
   *
   * @param conn - Salesforce connection to use.
   * @param objectNames - Object API names to describe.
   * @returns Map of object name to describe result.
   */
  private async describeAll(
    conn: AutopilotConnection,
    objectNames: ApiName[],
  ): Promise<Map<ApiName, ObjectDescribeResult>> {
    const results = new Map<ApiName, ObjectDescribeResult>();
    const chunks = this.chunk(objectNames, this.maxConcurrent);

    for (const batch of chunks) {
      const settled = await Promise.allSettled(batch.map((name) => conn.describe(name)));
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.set(result.value.name, result.value);
        }
      }
    }

    return results;
  }

  /**
   * Count records for each object via COUNT() SOQL queries.
   *
   * @param conn - Salesforce connection to use.
   * @param objectNames - Object API names to count.
   * @returns Map of object name to record count.
   */
  private async countRecords(
    conn: AutopilotConnection,
    objectNames: ApiName[],
  ): Promise<Map<ApiName, number>> {
    const counts = new Map<ApiName, number>();
    const chunks = this.chunk(objectNames, this.maxConcurrent);

    for (const batch of chunks) {
      const settled = await Promise.allSettled(
        batch.map(async (name) => {
          const result = await conn.query(`SELECT COUNT() FROM ${assertSoqlIdentifier(name)}`);
          return { name, count: result.totalSize };
        }),
      );
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          counts.set(result.value.name, result.value.count);
        }
      }
    }

    return counts;
  }

  /**
   * Split an array into chunks of the given size.
   *
   * @param arr - Array to split.
   * @param size - Maximum chunk size.
   * @returns Array of chunks.
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
}

/** A positive whole number, or `fallback`. */
function wholeOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * The lookups of an object a copy writes, each with what it may point at and
 * whether a record can be written without it. A lookup no insert or update
 * sets — a converted lead's account — is the platform's to fill, and leads
 * nowhere.
 */
function lookupsOf(objectApiName: ApiName, describe: ObjectDescribeResult): PlannedLookup[] {
  return describe.fields
    .filter((f) => f.referenceTo.length > 0 && isSettableField(f))
    .map((f) => ({
      field: f.name,
      targets: [...f.referenceTo],
      required: isRequiredLookup(objectApiName, f.name, f.nillable),
    }));
}

/**
 * The object an id a lookup holds belongs to: the lookup's one target, or the
 * one whose key prefix the id begins with.
 */
function ownerOf(
  id: string,
  targets: readonly ApiName[],
  keyPrefixes: ReadonlyMap<string, ApiName>,
): ApiName | undefined {
  if (targets.length === 1) return targets[0];
  const owner = keyPrefixes.get(id.slice(0, 3));
  return owner !== undefined && targets.includes(owner) ? owner : undefined;
}
