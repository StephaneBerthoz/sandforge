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
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  dedupePricebookEntries,
} from '@sandforge/shared';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { RecordScopeCache } from '../forge/RecordScopeCache.js';
import { ScopedSoqlBuilder, type ScopableField } from '../forge/ScopedSoqlBuilder.js';
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
 * The catalog: products, price books and their prices — reference data every
 * dossier draws on and none owns.
 */
const CATALOG_OBJECTS: ReadonlySet<string> = new Set(['Product2', 'Pricebook2', 'PricebookEntry']);

/**
 * The fields the scoped builder sees, with a dossier record's required
 * lookups into the catalog no longer marked required.
 *
 * The builder keeps only rows whose required parents it has read, and that
 * is the dossier's edge for most lookups: a quote whose opportunity is not
 * in the dossier is not the dossier's. Into the catalog it is the wrong
 * edge. A price is read when scope reaches it, and scope reached an order's
 * price book only after the prices had been read: run for real, every item
 * of two activated orders was left out, and the orders loaded with no
 * product. Those lookups stay open, and {@link completeRequiredParents}
 * fetches the prices they name. The catalog's own lookups keep the edge, so
 * a price book is not read whole for one of its products.
 */
function withCatalogLookupsOpen(objectApiName: string, fields: ScopableField[]): ScopableField[] {
  if (CATALOG_OBJECTS.has(objectApiName)) return fields;
  return fields.map((f) =>
    f.type === 'reference' && f.referenceTo.some((t) => CATALOG_OBJECTS.has(t))
      ? { ...f, nillable: true }
      : f,
  );
}

/** Ids per `IN` list when records are fetched by id. */
const PRODUCT_CHUNK = 200;

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

/** Strict ISO instant — validated before interpolation into SOQL literals. */
const ISO_INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Injected org access. */
export interface FrozenExtractorDeps {
  /** Execute a SOQL query, returning plain records. */
  query: (soql: string) => Promise<Record<string, unknown>[]>;
  /** Describe the fields of an object (scope detection + SELECT clause). */
  describeFields: (objectApiName: string) => Promise<ScopableField[]>;
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

    const nodes = [...options.graph.nodes]
      .filter((n) => n.included)
      .sort((a, b) => a.level - b.level);

    const recordsByObject = new Map<string, Map<string, Record<string, unknown>>>();

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

    /** Described fields per object, asked once. */
    const fieldsByObject = new Map<string, ScopableField[]>();

    for (const node of nodes) {
      let fields = fieldsByObject.get(node.objectApiName);
      if (!fields) {
        fields = await this.deps.describeFields(node.objectApiName);
        fieldsByObject.set(node.objectApiName, fields);
      }
      const selectFields = this.selectFields(node.objectApiName, fields, options.excludedFields);
      const hasCreatedDate = fields.some((f) => f.name === 'CreatedDate');
      if (!hasCreatedDate) unbounded.add(node.objectApiName);
      const files = fields.filter((f) => f.type === 'base64').map((f) => f.name);
      if (files.length > 0) fileFields[node.objectApiName] = files;
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
      });
      if (!built.scoped) {
        // Unscoped node (no path to the root) — nothing to pull.
        continue;
      }
      // A selection too large for one query URI arrives as several
      // statements; the bucket below already keeps one row per Id.
      const rows: Record<string, unknown>[] = [];
      for (const soql of built.statements) {
        rows.push(...(await this.deps.query(soql)));
      }
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
      cache.add(node.objectApiName, ids);
      // Seed parent objects referenced by lookups so their own wave can
      // use the 'self-cached' branch (mirrors ForgeExecutor behavior).
      for (const field of fields) {
        if (field.type !== 'reference') {
          continue;
        }
        const refIds: string[] = [];
        for (const row of rows) {
          const value = row[field.name];
          if (typeof value === 'string' && value !== '') {
            refIds.push(value);
          }
        }
        for (const target of field.referenceTo) {
          cache.add(target, refIds);
        }
      }
    }

    await this.completeRequiredParents(
      options,
      nodes.map((n) => n.objectApiName),
      recordsByObject,
      fieldsByObject,
      asOfWhere,
    );

    const standardPricebookSourceId = await this.addStandardPrices(
      options,
      recordsByObject,
      asOfWhere,
    );

    // Stable referenceIds: per object, records sorted by source ID, then
    // numbered — identical exports produce identical referenceIds,
    // reusable for diffs and sidecars.
    const objects = [...recordsByObject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([objectApiName, bucket]) => {
        let rows = [...bucket.values()].sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
        // A book holds one price per product, and the target enforces it on
        // insert whatever `IsActive` says; a source can still hold two.
        if (objectApiName === PRICEBOOK_ENTRY_OBJECT) rows = dedupePricebookEntries(rows);
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
   */
  private async completeRequiredParents(
    options: FrozenExtractionOptions,
    objectsInGraph: readonly string[],
    recordsByObject: Map<string, Map<string, Record<string, unknown>>>,
    fieldsByObject: ReadonlyMap<string, ScopableField[]>,
    asOfWhere: string,
  ): Promise<void> {
    const inGraph = new Set(objectsInGraph);
    const asked = new Map<string, Set<string>>();
    for (let round = 0; round < MAX_PARENT_ROUNDS; round++) {
      const missing = new Map<string, Set<string>>();
      for (const [objectApiName, bucket] of recordsByObject) {
        const required = (fieldsByObject.get(objectApiName) ?? []).filter(
          (f) => f.type === 'reference' && f.nillable === false,
        );
        for (const row of bucket.values()) {
          for (const field of required) {
            const id = row[field.name];
            if (typeof id !== 'string' || id === '') continue;
            // A polymorphic lookup names several objects; the id belongs to
            // one, and asking the others costs a query that returns nothing.
            for (const target of field.referenceTo) {
              if (!inGraph.has(target) || recordsByObject.get(target)?.has(id)) continue;
              if (asked.get(target)?.has(id)) continue;
              missing.set(target, (missing.get(target) ?? new Set()).add(id));
            }
          }
        }
      }
      if (missing.size === 0) return;
      for (const [target, ids] of missing) {
        asked.set(target, new Set([...(asked.get(target) ?? []), ...ids]));
        const fields = fieldsByObject.get(target) ?? [];
        const select = this.selectFields(target, fields, options.excludedFields)
          .map((f) => assertSoqlIdentifier(f))
          .join(', ');
        const bound = fields.some((f) => f.name === 'CreatedDate') ? ` AND ${asOfWhere}` : '';
        let bucket = recordsByObject.get(target);
        if (!bucket) {
          bucket = new Map();
          recordsByObject.set(target, bucket);
        }
        const list = [...ids];
        for (let i = 0; i < list.length; i += PRODUCT_CHUNK) {
          const inList = list
            .slice(i, i + PRODUCT_CHUNK)
            .map((id) => `'${sanitizeSoqlValue(id)}'`)
            .join(', ');
          const rows = await this.deps.query(
            `SELECT ${select} FROM ${assertSoqlIdentifier(target)} WHERE Id IN (${inList})${bound}`,
          );
          for (const row of rows) {
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
   * reads them; this reads them too, for exactly the products in hand. The
   * standard book comes with them so their `Pricebook2Id` has something to
   * point at; the load matches it to the target's own and never inserts it.
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

    const productIds = new Set<string>();
    for (const row of entries.values()) {
      if (row[PRICEBOOK_ENTRY_BOOK_FIELD] === standardId) continue;
      const product = row[PRICEBOOK_ENTRY_PRODUCT_FIELD];
      if (typeof product === 'string' && product !== '') productIds.add(product);
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

    const products = [...productIds];
    for (let i = 0; i < products.length; i += PRODUCT_CHUNK) {
      const inList = products
        .slice(i, i + PRODUCT_CHUNK)
        .map((id) => `'${sanitizeSoqlValue(id)}'`)
        .join(', ');
      const rows = await read(
        PRICEBOOK_ENTRY_OBJECT,
        `${PRICEBOOK_ENTRY_BOOK_FIELD} = '${sanitizeSoqlValue(standardId)}' ` +
          `AND ${PRICEBOOK_ENTRY_PRODUCT_FIELD} IN (${inList})`,
      );
      for (const row of rows) {
        if (typeof row.Id === 'string' && !entries.has(row.Id)) {
          entries.set(row.Id, withoutEnvelope(row));
        }
      }
    }
    return standardId;
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
