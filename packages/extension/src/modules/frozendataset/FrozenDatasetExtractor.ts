/**
 * Scope-aware extraction — pulls the full descendant closure of
 * the retained root records plus the necessary reference data, reusing
 * Forge's `RecordScopeCache` + `ScopedSoqlBuilder` WITHOUT modifying them.
 *
 * Design choices:
 *
 *  - **Frozen date bound.** SOQL has no `AS OF`
 *    operator. The feasible freeze is a `CreatedDate <= <asOf>` literal
 *    appended to every node query via `ScopedSoqlBuilder.extraWhere`:
 *    records created after the bound are excluded. Records *modified*
 *    after the bound may carry newer field values — accepted drift,
 *    documented here; `LastModifiedDate` is intentionally NOT used as the
 *    bound because it would drop legitimate pre-existing records touched
 *    by background jobs.
 *  - **No hard-coded IDs.** Root IDs come from the sas selection
 *    (`readSelectionFromSas`) and are injected into queries at execution
 *    time; free-form SOQL (axis queries, RecordType pull) goes through
 *    `{{TOKEN}}` templates rendered with sas-provided values.
 *  - **No `SELECT *`.** The SELECT clause is the explicit described field
 *    list minus configured exclusions.
 *  - **rt-map.json.** RecordTypes are pulled at extraction and written to
 *    the sas (`Id → SobjectType/DeveloperName/Name`); the anonymizer uses
 *    it to replace `RecordTypeId` by the RecordType Name.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ForgeGraph } from '@sandforge/shared';
import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  PRICEBOOK_OBJECT,
  SELLING_MODEL_OBJECT,
  SELLING_MODEL_OPTION_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  dedupePricebookEntries,
  isRequiredLookup,
} from '@sandforge/shared';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { RowsLeftToThePlatform } from '../../core/common/platformRecords.js';
import { RecordScopeCache } from '../forge/RecordScopeCache.js';
import { ScopedSoqlBuilder, type ScopableField } from '../forge/ScopedSoqlBuilder.js';
import {
  CATALOG_OBJECTS,
  PRODUCT_OBJECT,
  catalogBeyond,
  followsToItsParent,
  objectsOfId,
} from '../forge/stages/ScopeResolver.js';
import { SasPathGuard } from './SasPathGuard.js';
import { renderQueryTemplate } from './queryTemplates.js';
import type { ExtractedDataset, ExtractedRecord, RecordTypeMapEntry } from './types.js';

/** Default RecordType pull — no date bound (RecordTypes are metadata-like). */
export const DEFAULT_RECORD_TYPES_SOQL =
  'SELECT Id, SobjectType, DeveloperName, Name FROM RecordType ORDER BY SobjectType, DeveloperName';

/** rt-map file name inside the sas. */
export const RT_MAP_FILE_NAME = 'rt-map.json';

/**
 * Rounds of required parents fetched by id. Each round fetches the parents
 * the previous one's records require; a dossier settles in two or three.
 */
const MAX_PARENT_ROUNDS = 10;

/**
 * The fields the scoped builder sees, with a dossier record's required
 * lookups into the catalog — prices, products, selling models and their
 * options, price books: `CATALOG_OBJECTS` — no longer marked required.
 *
 * The builder keeps only rows whose required parents it has read, and that
 * is the dossier's edge for most lookups: a quote line whose quote is not in
 * the dossier is not the dossier's. Into the catalog it is the wrong edge. A
 * price is read when scope reaches it, and scope reached an order's price
 * book only after the prices had been read: run for real, every item of two
 * activated orders was left out, and the orders loaded with no product.
 * Those lookups stay open, and {@link completeRequiredParents} fetches the
 * prices they name. The catalog's own lookups keep the edge, so a price book
 * is not read whole for one of its products.
 */
function withCatalogLookupsOpen(objectApiName: string, fields: ScopableField[]): ScopableField[] {
  if (CATALOG_OBJECTS.has(objectApiName)) return fields;
  return fields.map((f) =>
    f.type === 'reference' && f.referenceTo.some((t) => CATALOG_OBJECTS.has(t))
      ? { ...f, nillable: true }
      : f,
  );
}

/**
 * A row as Salesforce holds it: jsforce wraps each one in an `attributes`
 * envelope (type and URL), which is not a field — carried along, it became
 * one column of every object, cleared by the rules and removed again by the
 * load as "absent from the target".
 */
function withoutEnvelope(row: Record<string, unknown>): Record<string, unknown> {
  if (!('attributes' in row)) return row;
  const copy = { ...row };
  delete copy.attributes;
  return copy;
}

/**
 * Which object a record id belongs to, told by its key prefix: the three
 * characters every id of an object begins with.
 *
 * Learnt from the rows the extraction holds, every row of an object carrying
 * its prefix, and for a prefix none of them has, from the org, asked once.
 */
class KeyPrefixOwners {
  /** The key prefix of each object known so far, by object. */
  private readonly prefixes = new Map<string, string>();
  /** The prefixes of {@link prefixes}. */
  private readonly known = new Set<string>();
  private fromOrg: Promise<void> | undefined;

  constructor(private readonly keyPrefixes: FrozenExtractorDeps['keyPrefixes']) {}

  /** Note the prefix of each object the extraction holds a row of. */
  learnFrom(recordsByObject: ReadonlyMap<string, ReadonlyMap<string, unknown>>): void {
    for (const [objectApiName, bucket] of recordsByObject) {
      const first = bucket.keys().next();
      if (!first.done) this.note(objectApiName, first.value.slice(0, 3));
    }
  }

  /**
   * The objects among `targets`, those a lookup names, that an id the lookup
   * holds can belong to: see `objectsOfId`. Unanswered by the org, an id
   * stays unplaced, and is looked for in each of them whose prefix is not
   * known.
   */
  async objectsOf(id: string, targets: readonly string[]): Promise<readonly string[]> {
    if (targets.length < 2) return targets;
    if (!this.known.has(id.slice(0, 3)) && this.keyPrefixes) {
      this.fromOrg ??= this.keyPrefixes().then(
        (prefixes) => {
          for (const [objectApiName, keyPrefix] of prefixes) {
            if (!this.prefixes.has(objectApiName)) this.note(objectApiName, keyPrefix);
          }
        },
        () => undefined,
      );
      await this.fromOrg;
    }
    return objectsOfId(id, targets, this.prefixes);
  }

  private note(objectApiName: string, prefix: string): void {
    this.prefixes.set(objectApiName, prefix);
    this.known.add(prefix);
  }
}

/** The lookups of an object's records they may not leave empty, by its described fields. */
function requiredLookupsOf(objectApiName: string, fields: readonly ScopableField[]): string[] {
  return fields
    .filter((f) => f.type === 'reference' && isRequiredLookup(objectApiName, f.name, f.nillable))
    .map((f) => f.name);
}

/** Strict ISO instant — validated before interpolation into SOQL literals. */
const ISO_INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Injected org access. */
export interface FrozenExtractorDeps {
  /** Execute a SOQL query, returning plain records. */
  query: (soql: string) => Promise<Record<string, unknown>[]>;
  /** Describe the fields of an object (scope detection + SELECT clause). */
  describeFields: (objectApiName: string) => Promise<ScopableField[]>;
  /**
   * The key prefix of each object of the org — the three characters its
   * record ids begin with — by object. Asked when an id met through a lookup
   * that can name several objects begins with a prefix no row read so far
   * has; left out, such an id is looked for in each of them.
   */
  keyPrefixes?: () => Promise<ReadonlyMap<string, string>>;
}

/** Extraction inputs. */
export interface FrozenExtractionOptions {
  /** Discovery graph of the root object (nodes + edges from Forge). */
  graph: ForgeGraph;
  /** API name of the root ("dossier") object. */
  rootObject: string;
  /**
   * Retained root record IDs — loaded from the sas selection, injected
   * into queries at execution time.
   */
  rootRecordIds: string[];
  /**
   * Frozen date bound (ISO instant, e.g. extraction start): every node
   * query is bounded with `CreatedDate <= <asOf>`.
   */
  asOf: string;
  /** Sas directory (outside the repo) where rt-map.json is written. */
  sasDir: string;
  /** Per-object fields excluded from the SELECT clause. */
  excludedFields?: Record<string, readonly string[]>;
  /** Override for the RecordType pull template (`{{TOKEN}}` allowed). */
  recordTypesSoqlTemplate?: string;
  /** Token values (from the sas) for `{{TOKEN}}` placeholders. */
  tokens?: Record<string, string>;
  /** Guard override (tests); defaults to repo-root detection. */
  guard?: SasPathGuard;
}

/** Error thrown for invalid extraction inputs. */
export class FrozenExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenExtractionError';
  }
}

/**
 * Extracts the scope-aware raw dataset. The result is sas-only working
 * data: field values are still source values and source IDs.
 */
export class FrozenDatasetExtractor {
  private readonly deps: FrozenExtractorDeps;
  private readonly soqlBuilder = new ScopedSoqlBuilder();

  constructor(deps: FrozenExtractorDeps) {
    this.deps = deps;
  }

  /** Run the extraction; writes rt-map.json into the sas. */
  async extract(options: FrozenExtractionOptions): Promise<ExtractedDataset> {
    if (!ISO_INSTANT_REGEX.test(options.asOf)) {
      throw new FrozenExtractionError(
        `asOf must be a strict ISO instant (e.g. 2026-08-03T09:44:52Z), got ${JSON.stringify(options.asOf)}`,
      );
    }
    if (options.rootRecordIds.length === 0) {
      throw new FrozenExtractionError('No root record IDs provided — empty selection refused');
    }
    const guard = options.guard ?? new SasPathGuard();
    const sasDir = guard.assertOutsideRepo(options.sasDir);

    // CreatedDate bound appended to every node query (documented SOQL
    // choice — see file header). The literal is safe: asOf validated above.
    const asOfWhere = `CreatedDate <= ${options.asOf}`;

    const cache = new RecordScopeCache();
    cache.add(options.rootObject, options.rootRecordIds);
    // The roots are reached from above, as every row read under a parent in
    // scope is: a row of the catalog brings the rows under it only then. See
    // `catalog` below.
    cache.addReached(options.rootObject, options.rootRecordIds);

    const nodes = [...options.graph.nodes]
      .filter((n) => n.included)
      .sort((a, b) => a.level - b.level);
    // A required lookup holds a row to the dossier only through an object the
    // extraction reads. The user of `OwnerId` or `CreatedById` is never read:
    // held to the users earlier rows named, a contact created by anyone else
    // was left out of the dataset.
    const readObjects = new Set(nodes.map((n) => n.objectApiName));

    const recordsByObject = new Map<string, Map<string, Record<string, unknown>>>();
    /**
     * The records the dataset leaves to the platform: those it writes itself
     * (`writtenByThePlatform`) and those that cannot go in without one.
     *
     * A load sends every record of the dataset, and the platform refuses a
     * tracked change from a copy: "Cannot directly insert FeedItem with type
     * TrackedChange". Nor does a comment on one go in without the feed item it
     * answers. Left out as they are read, they put nothing in scope.
     */
    const leftToThePlatform = new RowsLeftToThePlatform();

    /**
     * Objects read without the freeze, because they have no `CreatedDate`.
     *
     * The bound is what makes this dataset frozen, and it was appended to
     * every node without asking whether the object has the field. Not every
     * one does — `DashboardComponent` is one — and Salesforce answers "No such
     * column 'CreatedDate'", which took the whole extraction down with it.
     * Read for a real record, one such object in the graph was enough.
     *
     * Skipping them would lose data the graph says belongs to the record;
     * reading them unbounded quietly would break the promise the module is
     * named for. So they are read and named, and the caller can see which
     * part of its dataset is not frozen.
     */
    const unbounded = new Set<string>();
    /** Per object, the fields that hold a file's bytes (`base64`). */
    const fileFields: Record<string, string[]> = {};

    /** Which object an id met through a lookup naming several belongs to. */
    const owners = new KeyPrefixOwners(this.deps.keyPrefixes);

    /** Described fields per object, asked once. */
    const fieldsByObject = new Map<string, ScopableField[]>();
    /** The fields of an object, described once, with what they say of its reads. */
    const describe = async (objectApiName: string): Promise<ScopableField[]> => {
      const known = fieldsByObject.get(objectApiName);
      if (known) return known;
      const fields = await this.deps.describeFields(objectApiName);
      fieldsByObject.set(objectApiName, fields);
      if (!fields.some((f) => f.name === 'CreatedDate')) unbounded.add(objectApiName);
      const files = fields.filter((f) => f.type === 'base64').map((f) => f.name);
      if (files.length > 0) fileFields[objectApiName] = files;
      return fields;
    };

    for (const node of nodes) {
      const fields = await describe(node.objectApiName);
      const selectFields = this.selectFields(node.objectApiName, fields, options.excludedFields);
      const hasCreatedDate = fields.some((f) => f.name === 'CreatedDate');
      const built = this.soqlBuilder.build({
        node,
        fields: withCatalogLookupsOpen(node.objectApiName, fields),
        selectFields,
        edges: options.graph.edges,
        cache,
        // Sentinel: never matches a real node name, so the root object is
        // scoped via the 'self-cached' branch (Id IN <sas selection>)
        // instead of the single-ID 'root' branch. ScopedSoqlBuilder is
        // reused unmodified.
        rootObjectApiName: `__frozen_root_${options.rootObject}__`,
        rootRecordId: options.rootRecordIds[0],
        extraWhere: hasCreatedDate ? asOfWhere : undefined,
        // An object of the dossier is read once, so its read takes what every
        // edge brings to it: the rows a row read before names, and its rows
        // under a parent in scope. Read by the named rows alone, one reached
        // first through a lookup hid the rest: run for real, the
        // opportunity's synced quote was the one quote read, and a feed item
        // on the opportunity, whose parent can be nearly any object, put the
        // opportunity's own id in scope as an order — the order read by it
        // came back empty, and none of the orders under the opportunity was
        // read. The root comes first, before any parent has anything in
        // scope, so it is read by the selection alone.
        //
        // The catalog stays read by what the dossier names. Its rows under a
        // book and a product in scope are other sales' prices, and the
        // dataset keeps one price per book and product: read both ways, a
        // price no line named took the place of the one two quote lines used.
        everyEdge: !CATALOG_OBJECTS.has(node.objectApiName),
        readObjects,
        // And a row of the catalog met through a lookup brings nothing under
        // it: the opportunity's price book is also the book of every other
        // sale priced from it. Read as any parent in scope, it brought the
        // quotes and orders that use it, another opportunity's among them.
        // Only a catalog row the extraction reached from above — a root, or
        // a row read under a parent in scope — brings what is under it.
        catalog: CATALOG_OBJECTS,
      });
      if (!built.scoped) {
        // Unscoped node (no path to the root) — nothing to pull.
        continue;
      }
      // A selection too large for one query URI arrives as several
      // statements; the bucket below already keeps one row per Id. The
      // statements past the first `byIdCount` read rows under a parent in
      // scope: rows reached from above.
      const read: Record<string, unknown>[] = [];
      const reached: string[] = [];
      for (const [index, soql] of built.statements.entries()) {
        const answered = await this.deps.query(soql);
        read.push(...answered);
        if (index < built.byIdCount) continue;
        for (const row of answered) if (typeof row.Id === 'string') reached.push(row.Id);
      }
      const rows = leftToThePlatform.keep(
        node.objectApiName,
        read,
        requiredLookupsOf(node.objectApiName, fields),
      );
      let bucket = recordsByObject.get(node.objectApiName);
      if (!bucket) {
        bucket = new Map();
        recordsByObject.set(node.objectApiName, bucket);
      }
      const ids: string[] = [];
      for (const row of rows) {
        const id = row.Id;
        if (typeof id !== 'string' || id === '') {
          continue;
        }
        ids.push(id);
        // First occurrence wins — identical exports must be stable.
        if (!bucket.has(id)) {
          bucket.set(id, withoutEnvelope(row));
        }
      }
      // The object's scope is settled with its read. An id of it met later
      // names a row no read of the dossier fetches, and its children are not
      // the dossier's: an account's quotes include another opportunity's,
      // and read under that opportunity's id, its line items came in, and the
      // opportunity with them, fetched as the parent they require.
      cache.addRead(node.objectApiName, ids);
      cache.addReached(
        node.objectApiName,
        reached.filter((id) => !leftToThePlatform.has(id)),
      );
      owners.learnFrom(recordsByObject);
      // Seed parent objects referenced by lookups so their own wave can
      // use the 'self-cached' branch (mirrors ForgeExecutor behavior). An id
      // a lookup naming several objects holds goes to the one it belongs to:
      // put in scope as an id of each, the quote an email was related to was
      // asked of every object of the graph the lookup could name, each in a
      // statement bound to come back empty.
      for (const field of fields) {
        if (field.type !== 'reference') {
          continue;
        }
        for (const row of rows) {
          const value = row[field.name];
          if (typeof value !== 'string' || value === '') continue;
          for (const target of await owners.objectsOf(value, field.referenceTo)) {
            cache.add(target, [value]);
          }
        }
      }
    }

    await this.completeRequiredParents(
      options,
      recordsByObject,
      describe,
      asOfWhere,
      owners,
      leftToThePlatform,
    );
    await leaveWhatHangsFromThePlatform(recordsByObject, describe, leftToThePlatform);

    const standardPricebookSourceId = await this.addStandardPrices(
      options,
      recordsByObject,
      asOfWhere,
    );
    await this.addSellingModelOptions(options, recordsByObject, describe, asOfWhere);

    // Whether the dataset carries the selling models its prices are sold
    // under, so the load writes the lookup that tells two prices apart.
    const sellingModels = (recordsByObject.get(SELLING_MODEL_OBJECT)?.size ?? 0) > 0;

    // Stable referenceIds: per object, records sorted by source ID, then
    // numbered — identical exports produce identical referenceIds,
    // reusable for diffs and sidecars.
    const objects = [...recordsByObject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([objectApiName, bucket]) => {
        let rows = [...bucket.values()].sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
        // A book holds one price per product — per product and selling model
        // where the dataset carries the models — and the target enforces it
        // on insert whatever `IsActive` says; a source can still hold two.
        // Keyed on the product alone, a product sold under two models kept
        // one of its prices, and a line priced under the other was left
        // pointing at a price the dataset did not hold.
        if (objectApiName === PRICEBOOK_ENTRY_OBJECT) {
          rows = dedupePricebookEntries(rows, { sellingModel: sellingModels });
        }
        const records: ExtractedRecord[] = rows.map((fields, index) => ({
          referenceId: `${objectApiName}-${String(index + 1).padStart(6, '0')}`,
          sourceId: String(fields.Id),
          fields,
        }));
        return { objectApiName, records };
      });

    const recordTypeMap = await this.pullRecordTypes(options);

    await fs.mkdir(sasDir, { recursive: true });
    const rtMapPath = guard.assertOutsideRepo(path.join(sasDir, RT_MAP_FILE_NAME));
    await fs.writeFile(rtMapPath, `${JSON.stringify(recordTypeMap, null, 2)}\n`, 'utf8');

    return {
      objects,
      asOf: options.asOf,
      recordTypeMap,
      unboundedObjects: [...unbounded],
      fileFields,
      ...(standardPricebookSourceId ? { standardPricebookSourceId } : {}),
      leftToThePlatform: leftToThePlatform.counts(),
    };
  }

  /**
   * Fetch, by id, every parent a record of the dataset requires and the
   * dataset does not hold yet — and theirs, until none is missing.
   *
   * Scope reads the graph level by level, and a required parent can turn up
   * after its object was read. Run for real: the orders reached through an
   * Account named a price book other than the opportunity's, read a level
   * earlier; their items' prices and that book were never read, and two
   * activated orders came back without a single product while the dataset
   * said nothing. Loading them, the target refused to activate an order with
   * no products. Only required lookups are followed: an optional one the
   * load can leave empty, a required one it cannot. In practice these are the
   * catalog lookups {@link withCatalogLookupsOpen} leaves open; every other
   * required lookup was held to parents already read.
   *
   * Required as the platform has it, not only as the describe says: an
   * opportunity's line reads as nullable and is refused without its price
   * (`platform-required-fields.ts` in shared). And a price keeps its selling
   * model, optional as that lookup is: a book prices a product once per model
   * it is sold under, and a price loaded without its model is the product's
   * other price over again. Forge follows the same lookups
   * (`followsToItsParent`).
   *
   * The parents are looked for among the objects the extraction reads, and
   * in the catalog whatever the graph holds: a line whose price, product or
   * book the dataset leaves out cannot be loaded. Run for real at the default
   * cap of fifty objects, discovery stopped before it reached the catalog, and
   * a dossier with three priced lines came out without a single price. An
   * object the graph holds and leaves out — excluded, or empty in the whole
   * org — stays out (`catalogBeyond`).
   *
   * An id a lookup naming several objects holds is looked for in the one
   * object its key prefix says it belongs to. Asked of each of them, a feed
   * item's parent and an error log's record cost some fifty queries a pass,
   * every one bound to come back empty.
   *
   * A parent left to the platform is not asked for again, and one fetched is
   * left out as it would have been read: a comment on a tracked change,
   * read before the feed items, names one in a lookup it may not leave empty.
   */
  private async completeRequiredParents(
    options: FrozenExtractionOptions,
    recordsByObject: Map<string, Map<string, Record<string, unknown>>>,
    describe: (objectApiName: string) => Promise<ScopableField[]>,
    asOfWhere: string,
    owners: KeyPrefixOwners,
    leftToThePlatform: RowsLeftToThePlatform,
  ): Promise<void> {
    const included = new Set(
      options.graph.nodes.filter((n) => n.included).map((n) => n.objectApiName),
    );
    const beyond = catalogBeyond(options.graph);
    const fetched = (objectApiName: string): boolean =>
      included.has(objectApiName) || beyond.has(objectApiName);

    const asked = new Map<string, Set<string>>();
    for (let round = 0; round < MAX_PARENT_ROUNDS; round++) {
      owners.learnFrom(recordsByObject);
      const missing = new Map<string, Set<string>>();
      for (const [objectApiName, bucket] of recordsByObject) {
        const followed = (await describe(objectApiName)).filter(
          (f) => f.type === 'reference' && followsToItsParent(objectApiName, f),
        );
        for (const row of bucket.values()) {
          for (const field of followed) {
            const id = row[field.name];
            if (typeof id !== 'string' || id === '' || leftToThePlatform.has(id)) continue;
            if (!field.referenceTo.some(fetched)) continue;
            const targets = (await owners.objectsOf(id, field.referenceTo)).filter(fetched);
            for (const target of targets) {
              if (recordsByObject.get(target)?.has(id) || asked.get(target)?.has(id)) continue;
              missing.set(target, (missing.get(target) ?? new Set()).add(id));
            }
          }
        }
      }
      if (missing.size === 0) return;
      for (const [target, ids] of missing) {
        asked.set(target, new Set([...(asked.get(target) ?? []), ...ids]));
        const fields = await describe(target);
        let bucket = recordsByObject.get(target);
        if (!bucket) {
          bucket = new Map();
          recordsByObject.set(target, bucket);
        }
        // As many ids a statement as the request URI holds once the field
        // list is written in front of them, as every read of the extraction.
        const statements = this.soqlBuilder.buildById({
          objectApiName: target,
          selectFields: this.selectFields(target, fields, options.excludedFields),
          ids,
          extraWhere: fields.some((f) => f.name === 'CreatedDate') ? asOfWhere : undefined,
        });
        const lookups = requiredLookupsOf(target, fields);
        for (const soql of statements) {
          for (const row of leftToThePlatform.keep(target, await this.deps.query(soql), lookups)) {
            if (typeof row.Id === 'string' && !bucket.has(row.Id)) {
              bucket.set(row.Id, withoutEnvelope(row));
            }
          }
        }
      }
    }
  }

  /**
   * The standard prices of the products the dataset prices, and the standard
   * price book itself.
   *
   * Salesforce takes no custom price for a product that has no standard one
   * (see `standard-pricebook.ts` in shared), and scope reaches the entry a
   * line item points at — in its custom book — never the product's standard
   * entry. Loaded for real, every custom price was refused: "create a
   * standard price first". Forge learned this rule a release earlier and
   * reads them; this reads them too, for exactly the products in hand, with
   * the statements Forge reads them with. The standard book comes with them
   * so their `Pricebook2Id` has something to point at; the load matches it to
   * the target's own and never inserts it.
   *
   * Of a product's standard prices, it takes the ones its custom prices need:
   * in their currency and under their selling model. A book prices a product
   * once per currency the org holds and per model it is sold under; taken by
   * product, a price in euros brings the standard prices in every other
   * currency too, and one under another model can take the place of the one
   * the custom price needs, since the dataset keeps one standard price per
   * product and currency.
   *
   * @returns The source id of the standard book, when prices were read.
   */
  private async addStandardPrices(
    options: FrozenExtractionOptions,
    recordsByObject: Map<string, Map<string, Record<string, unknown>>>,
    asOfWhere: string,
  ): Promise<string | undefined> {
    const entries = recordsByObject.get(PRICEBOOK_ENTRY_OBJECT);
    if (!entries || entries.size === 0) return undefined;
    const [book] = await this.deps.query(STANDARD_PRICEBOOK_SOQL);
    const standardId = typeof book?.Id === 'string' ? book.Id : undefined;
    if (!standardId) return undefined;

    // The standard price a custom price needs: of its product, under its
    // selling model — none in an org that sells without them — and in its
    // currency, absent from an org with one.
    const pairOf = (row: Record<string, unknown>): string =>
      [
        PRICEBOOK_ENTRY_PRODUCT_FIELD,
        PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
        PRICEBOOK_ENTRY_CURRENCY_FIELD,
      ]
        .map((field) => String(row[field] ?? ''))
        .join('|');
    const productIds = new Set<string>();
    const pricedPairs = new Set<string>();
    for (const row of entries.values()) {
      if (row[PRICEBOOK_ENTRY_BOOK_FIELD] === standardId) continue;
      const product = row[PRICEBOOK_ENTRY_PRODUCT_FIELD];
      if (typeof product === 'string' && product !== '') {
        productIds.add(product);
        pricedPairs.add(pairOf(row));
      }
    }
    if (productIds.size === 0) return undefined;

    const read = async (
      objectApiName: string,
      where: string,
    ): Promise<Record<string, unknown>[]> => {
      const fields = await this.deps.describeFields(objectApiName);
      const select = this.selectFields(objectApiName, fields, options.excludedFields)
        .map((f) => assertSoqlIdentifier(f))
        .join(', ');
      const bound = fields.some((f) => f.name === 'CreatedDate') ? ` AND ${asOfWhere}` : '';
      return this.deps.query(`SELECT ${select} FROM ${objectApiName} WHERE ${where}${bound}`);
    };

    let books = recordsByObject.get(PRICEBOOK_OBJECT);
    if (!books) {
      books = new Map();
      recordsByObject.set(PRICEBOOK_OBJECT, books);
    }
    if (!books.has(standardId)) {
      for (const row of await read(PRICEBOOK_OBJECT, `Id = '${sanitizeSoqlValue(standardId)}'`)) {
        books.set(standardId, withoutEnvelope(row));
      }
    }

    // The products laid over as many statements as a request URI holds. Cut
    // into lists of two hundred, a statement grows with the field list written
    // in front of them, which a count of ids never looks at: a price object
    // some four hundred fields wide makes a query longer than the org takes,
    // and the whole extraction stops on it.
    const priceFields = await this.deps.describeFields(PRICEBOOK_ENTRY_OBJECT);
    const statements = this.soqlBuilder.buildJoining({
      objectApiName: PRICEBOOK_ENTRY_OBJECT,
      selectFields: this.selectFields(PRICEBOOK_ENTRY_OBJECT, priceFields, options.excludedFields),
      split: { field: PRICEBOOK_ENTRY_PRODUCT_FIELD, ids: productIds },
      whole: { field: PRICEBOOK_ENTRY_BOOK_FIELD, ids: new Set([standardId]) },
      extraWhere: priceFields.some((f) => f.name === 'CreatedDate') ? asOfWhere : undefined,
    });
    for (const soql of statements) {
      for (const row of await this.deps.query(soql)) {
        if (typeof row.Id !== 'string' || entries.has(row.Id)) continue;
        if (!pricedPairs.has(pairOf(row))) continue;
        entries.set(row.Id, withoutEnvelope(row));
      }
    }
    return standardId;
  }

  /**
   * The selling model options the dataset's prices need: for each product a
   * price sells under a selling model, the option that lets it be sold so.
   *
   * The platform takes no price for a product under a model the product has
   * no option for — "add a product selling model option to the product
   * first" — standard price included (see `standard-pricebook.ts` in shared).
   * Nothing points at an option, neither a line nor a price, so scope never
   * reaches one, and discovery seldom does: they sit two levels past the
   * lines. Forge learned this a release earlier and reads the options of the
   * products in scope under the models in scope; this reads them with the
   * statements Forge reads them with, once every price is in, and keeps the
   * ones a price names. Run for real on an opportunity whose 69 prices were
   * all sold under the one-time model, the dataset carried that model and
   * none of the 33 options that sell its products under it.
   *
   * Left out where the graph leaves the object out, and for a product or a
   * model the dataset does not hold: an option is written with both.
   */
  private async addSellingModelOptions(
    options: FrozenExtractionOptions,
    recordsByObject: Map<string, Map<string, Record<string, unknown>>>,
    describe: (objectApiName: string) => Promise<ScopableField[]>,
    asOfWhere: string,
  ): Promise<void> {
    if (
      options.graph.nodes.some(
        (n) => n.objectApiName === SELLING_MODEL_OPTION_OBJECT && !n.included,
      )
    ) {
      return;
    }
    const prices = recordsByObject.get(PRICEBOOK_ENTRY_OBJECT);
    const products = recordsByObject.get(PRODUCT_OBJECT);
    const models = recordsByObject.get(SELLING_MODEL_OBJECT);
    if (!prices || !products || !models) return;

    // An option names its product and its model with the two fields a price
    // names them with.
    const pairOf = (row: Record<string, unknown>): string =>
      `${String(row[PRICEBOOK_ENTRY_PRODUCT_FIELD] ?? '')}|${String(row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] ?? '')}`;
    const soldProducts = new Set<string>();
    const soldUnder = new Set<string>();
    const pairs = new Set<string>();
    for (const row of prices.values()) {
      const product = row[PRICEBOOK_ENTRY_PRODUCT_FIELD];
      const model = row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD];
      if (typeof product !== 'string' || !products.has(product)) continue;
      if (typeof model !== 'string' || !models.has(model)) continue;
      soldProducts.add(product);
      soldUnder.add(model);
      pairs.add(pairOf(row));
    }
    if (pairs.size === 0) return;

    const fields = await describe(SELLING_MODEL_OPTION_OBJECT);
    // The products laid over as many statements as a request URI holds, the
    // handful of models carried whole by each.
    const statements = this.soqlBuilder.buildJoining({
      objectApiName: SELLING_MODEL_OPTION_OBJECT,
      selectFields: this.selectFields(SELLING_MODEL_OPTION_OBJECT, fields, options.excludedFields),
      split: { field: PRICEBOOK_ENTRY_PRODUCT_FIELD, ids: soldProducts },
      whole: { field: PRICEBOOK_ENTRY_SELLING_MODEL_FIELD, ids: soldUnder },
      extraWhere: fields.some((f) => f.name === 'CreatedDate') ? asOfWhere : undefined,
    });
    let bucket = recordsByObject.get(SELLING_MODEL_OPTION_OBJECT);
    if (!bucket) {
      bucket = new Map();
      recordsByObject.set(SELLING_MODEL_OPTION_OBJECT, bucket);
    }
    for (const soql of statements) {
      for (const row of await this.deps.query(soql)) {
        if (typeof row.Id !== 'string' || bucket.has(row.Id)) continue;
        if (!pairs.has(pairOf(row))) continue;
        bucket.set(row.Id, withoutEnvelope(row));
      }
    }
  }

  /** Explicit SELECT clause: described fields minus exclusions. No SELECT *. */
  private selectFields(
    objectApiName: string,
    fields: ScopableField[],
    excludedFields: Record<string, readonly string[]> | undefined,
  ): string[] {
    const excluded = new Set(excludedFields?.[objectApiName] ?? []);
    const names = fields.map((f) => f.name).filter((name) => !excluded.has(name));
    if (!names.includes('Id')) {
      names.unshift('Id');
    }
    return names;
  }

  /** Pull the RecordType map (Id → SobjectType/DeveloperName/Name). */
  private async pullRecordTypes(options: FrozenExtractionOptions): Promise<RecordTypeMapEntry[]> {
    const template = options.recordTypesSoqlTemplate ?? DEFAULT_RECORD_TYPES_SOQL;
    const soql = renderQueryTemplate(template, options.tokens ?? {});
    const rows = await this.deps.query(soql);
    const entries: RecordTypeMapEntry[] = [];
    for (const row of rows) {
      if (
        typeof row.Id === 'string' &&
        typeof row.SobjectType === 'string' &&
        typeof row.DeveloperName === 'string' &&
        typeof row.Name === 'string'
      ) {
        entries.push({
          id: row.Id,
          sobjectType: row.SobjectType,
          developerName: row.DeveloperName,
          name: row.Name,
        });
      }
    }
    return entries;
  }
}

/**
 * Leave out of the dataset every record that hangs from one left to the
 * platform through a lookup it may not leave empty, and what hangs from
 * those, until none is left.
 *
 * An object of the dossier is read once, in an order scope sets, not the
 * order records depend on each other: the comments of an opportunity can be
 * read under it before its feed items are, and every comment then comes in,
 * one on a tracked change among them.
 */
async function leaveWhatHangsFromThePlatform(
  recordsByObject: Map<string, Map<string, Record<string, unknown>>>,
  describe: (objectApiName: string) => Promise<ScopableField[]>,
  leftToThePlatform: RowsLeftToThePlatform,
): Promise<void> {
  for (let changed = true; changed; ) {
    changed = false;
    for (const [objectApiName, bucket] of recordsByObject) {
      const rows = [...bucket.values()];
      const lookups = requiredLookupsOf(objectApiName, await describe(objectApiName));
      const kept = leftToThePlatform.keep(objectApiName, rows, lookups);
      if (kept.length === rows.length) continue;
      changed = true;
      const keptIds = new Set(kept.map((row) => row.Id));
      for (const id of bucket.keys()) if (!keptIds.has(id)) bucket.delete(id);
    }
  }
}
