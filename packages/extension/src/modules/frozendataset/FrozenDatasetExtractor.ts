/**
 * Scope-aware extraction (spec §2) — pulls the full descendant closure of
 * the retained root records plus the necessary reference data, reusing
 * Forge's `RecordScopeCache` + `ScopedSoqlBuilder` WITHOUT modifying them.
 *
 * Design choices (documented per spec):
 *
 *  - **Frozen date bound (spec pitfall 8).** SOQL has no `AS OF`
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { RecordScopeCache } from '../forge/RecordScopeCache.js';
import { ScopedSoqlBuilder, type ScopableField } from '../forge/ScopedSoqlBuilder.js';
import { SasPathGuard } from './SasPathGuard.js';
import { renderQueryTemplate } from './queryTemplates.js';
import type { ExtractedDataset, ExtractedRecord, RecordTypeMapEntry } from './types.js';

/** Default RecordType pull — no date bound (RecordTypes are metadata-like). */
export const DEFAULT_RECORD_TYPES_SOQL =
  'SELECT Id, SobjectType, DeveloperName, Name FROM RecordType ORDER BY SobjectType, DeveloperName';

/** rt-map file name inside the sas (spec §2). */
export const RT_MAP_FILE_NAME = 'rt-map.json';

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

    for (const node of nodes) {
      const fields = await this.deps.describeFields(node.objectApiName);
      const selectFields = this.selectFields(node, fields, options.excludedFields);
      const built = this.soqlBuilder.build({
        node,
        fields,
        selectFields,
        edges: options.graph.edges,
        cache,
        // Sentinel: never matches a real node name, so the root object is
        // scoped via the 'self-cached' branch (Id IN <sas selection>)
        // instead of the single-ID 'root' branch. ScopedSoqlBuilder is
        // reused unmodified.
        rootObjectApiName: `__frozen_root_${options.rootObject}__`,
        rootRecordId: options.rootRecordIds[0],
        extraWhere: asOfWhere,
      });
      if (!built.scoped) {
        // Unscoped node (no path to the root) — nothing to pull.
        continue;
      }
      const rows = await this.deps.query(built.soql);
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
          bucket.set(id, row);
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

    // Stable referenceIds: per object, records sorted by source ID, then
    // numbered — identical exports produce identical referenceIds
    // (spec pitfall 7), reusable for diffs and sidecars.
    const objects = [...recordsByObject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([objectApiName, bucket]) => {
        const records: ExtractedRecord[] = [...bucket.entries()]
          .sort(([idA], [idB]) => idA.localeCompare(idB))
          .map(([sourceId, fields], index) => ({
            referenceId: `${objectApiName}-${String(index + 1).padStart(6, '0')}`,
            sourceId,
            fields,
          }));
        return { objectApiName, records };
      });

    const recordTypeMap = await this.pullRecordTypes(options);

    fs.mkdirSync(sasDir, { recursive: true });
    const rtMapPath = guard.assertOutsideRepo(path.join(sasDir, RT_MAP_FILE_NAME));
    fs.writeFileSync(rtMapPath, `${JSON.stringify(recordTypeMap, null, 2)}\n`, 'utf8');

    return { objects, asOf: options.asOf, recordTypeMap };
  }

  /** Explicit SELECT clause: described fields minus exclusions. No SELECT *. */
  private selectFields(
    node: ForgeGraphNode,
    fields: ScopableField[],
    excludedFields: Record<string, readonly string[]> | undefined,
  ): string[] {
    const excluded = new Set(excludedFields?.[node.objectApiName] ?? []);
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
