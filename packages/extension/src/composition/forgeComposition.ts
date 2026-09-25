import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import type { Connection } from 'jsforce';
import { SchemaCache } from '../core/metadata/SchemaCache';
import { TimeoutManager } from '../core/engine/TimeoutManager';
import type { ObjectDescribe } from '../modules/forge/GraphDiscoveryService';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { OrgRegistry } from '../core/connection/OrgRegistry';
import type { OrgManager } from '../core/connection/OrgManager';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { PIIDetector } from '../core/precheck/PIIDetector';
import { duplicateRuleHeaders } from '@sandforge/shared';
import {
  FORGE_QUERY_MAX_PAGES,
  FORGE_QUERY_MAX_RECORDS,
  objectOfQuery,
  queryAllPages,
} from '../modules/forge/queryAllPages.js';
import { formatSaveError, toSaveOutcomes } from '../core/common/existingRecordMatch.js';
import {
  parseRecordTypeInfos,
  type RecordTypeAvailability,
} from '../core/metadata/recordTypeAvailability.js';

/**
 * The part of an object describe that Forge reads, kept once per org and
 * object. A raw jsforce describe carries labels, help text, URLs and every
 * picklist entry; only this projection is held in the cache.
 */
interface ForgeObjectDescribe {
  name: string;
  /** False only when the org says so: jsforce omits the flag on some entities. */
  createable: boolean;
  /** Key prefix of the object's ids; `null` when the org gives none. */
  keyPrefix: string | null;
  /** Record types as the user the connection runs as sees them. */
  recordTypes: RecordTypeAvailability[];
  fields: Array<{
    name: string;
    type: string;
    createable: boolean;
    nillable: boolean;
    referenceTo: string[];
    relationshipName: string | null;
    cascadeDelete: boolean;
    /** Active picklist values only. */
    picklistValues: string[];
    externalId: boolean;
    /** True unless the org says an update cannot set the field. */
    updateable: boolean;
  }>;
  childRelationships: Array<{
    childSObject: string;
    field: string;
    relationshipName: string;
    cascadeDelete: boolean;
  }>;
}

/** Reduce a jsforce describe to {@link ForgeObjectDescribe}. */
function toForgeObjectDescribe(
  meta: Awaited<ReturnType<Connection['describe']>>,
): ForgeObjectDescribe {
  return {
    name: meta.name,
    // Default to true when jsforce omits the flag — only opt out when
    // the org explicitly says false (read-only system entities).
    createable: meta.createable !== false,
    keyPrefix: meta.keyPrefix ?? null,
    recordTypes: parseRecordTypeInfos(meta.recordTypeInfos),
    fields: meta.fields.map((f) => ({
      name: f.name,
      type: f.type,
      createable: f.createable ?? false,
      nillable: f.nillable ?? true,
      referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
      relationshipName: f.relationshipName ?? null,
      cascadeDelete: f.cascadeDelete === true,
      picklistValues: (f.picklistValues ?? [])
        .filter((p) => p?.active !== false && typeof p?.value === 'string')
        .map((p) => p.value as string),
      externalId: f.externalId === true,
      updateable: f.updateable !== false,
    })),
    childRelationships: (meta.childRelationships ?? []).map((cr) => ({
      childSObject: cr.childSObject,
      field: cr.field,
      relationshipName: cr.relationshipName ?? cr.field,
      cascadeDelete: cr.cascadeDelete === true,
    })),
  };
}

/**
 * Records one write call carries: jsforce's `MAX_DML_COUNT`, past which
 * `allowRecursive` sends an array in calls of this many. An empty one sends
 * none.
 */
const RECORDS_PER_WRITE_CALL = 200;

/** Inputs required to wire the Forge orchestrator. */
export interface ForgeCompositionDeps {
  handlers: ExtensionHandlers;
  orgRegistry: OrgRegistry;
  orgManager: OrgManager;
  configStore: ConfigStore;
  piiDetector: PIIDetector;
  log: (msg: string) => void;
}

/**
 * Wire up the Forge orchestrator via dynamic imports, then inject it
 * into the handlers through the late setter (`setForgeOrchestrator`).
 *
 * Fire-and-forget by design: the 11 dynamic imports stay OFF the activation
 * hot path. The injection therefore lands AFTER `handlers.registerAll(router)`
 * — see the late-injection contract in `./lateServices.ts`. Failures are
 * logged, never thrown (the rest of the extension stays usable).
 *
 * Extracted from `activate()` — behaviour unchanged.
 */
export function initForgeComposition(deps: ForgeCompositionDeps): void {
  const { handlers, orgRegistry, orgManager, configStore, piiDetector, log } = deps;

  Promise.all([
    import('../modules/forge/GraphDiscoveryService.js'),
    import('../modules/forge/ForgeExecutor.js'),
    import('../modules/forge/ForgeOrchestrator.js'),
    import('../modules/forge/ForgePlanGenerator.js'),
    import('../modules/forge/ForgeComplianceService.js'),
    import('../modules/forge/ForgeMetadataDiff.js'),
    import('../modules/forge/ForgeBatchStrategy.js'),
    import('../modules/forge/ForgeTemplateStore.js'),
    import('../modules/forge/ForgeHistoryStore.js'),
    import('../core/connection/ConnectionHelper.js'),
    import('../modules/forge/fileTransfer.js'),
  ])
    .then(
      ([
        { GraphDiscoveryService },
        { ForgeExecutor },
        { ForgeOrchestrator },
        { ForgePlanGenerator },
        { ForgeComplianceService },
        { ForgeMetadataDiff },
        { ForgeBatchStrategy: ForgeBatchStrategyService },
        { ForgeTemplateStore },
        { ForgeHistoryStore },
        { getJsforceConnection },
        fileTransfer,
      ]) => {
        // Shared schema cache + timeout manager. Eliminates the 600+ describe
        // round-trips per forge run on a large org (350+ SObjects).
        // Per-call timeouts: describe 30s, describeGlobal 60s, queryCount 15s.
        // Without timeouts, jsforce calls hang indefinitely on rate-limited orgs.
        //
        // Byte cap backed by a structural estimator that walks each
        // field descriptor (name/label/type/picklist values/help text) instead
        // of JSON.stringify — see SchemaCache.estimateSize. `maxSize` is the
        // count backstop: 50 entries caps the describe heap at a sane fraction
        // of the extension-host budget even for raw describes (~1-2 MB each
        // real heap → ~50-100 MB worst case), while still covering the
        // working set of a typical forge run (root + direct children BFS).
        //
        // One describe per org and object serves discovery, the executor
        // (source fields, target creatability, target fields for drift) and
        // the drift check. Each of them used to send its own: a run described
        // every object three to four times per org.
        const describeCache = new SchemaCache<ForgeObjectDescribe>({
          defaultTtl: 5 * 60_000,
          maxSize: 100,
          maxSizeBytes: 200 * 1024 * 1024,
        });
        const describesUnderWay = new Map<string, Promise<ForgeObjectDescribe>>();
        const describeGlobalCache = new SchemaCache<
          Array<{ name: string; keyPrefix: string | null }>
        >({
          defaultTtl: 5 * 60_000,
          maxSize: 16,
          maxSizeBytes: 50 * 1024 * 1024,
        });
        const sfTimeouts = new TimeoutManager(30_000);

        /**
         * Drop what both caches hold, for every org or only the ones named.
         *
         * A re-discovery is the user saying the schema moved. Only the graph
         * used to be dropped, so the rebuild read the same describes for up to
         * five more minutes and produced the same graph — a field deployed on
         * the target stayed invisible to the drift check for that long.
         */
        const clearDescribes = (orgIds?: string[]): void => {
          if (!orgIds) {
            describeCache.clear();
            describeGlobalCache.clear();
            return;
          }
          for (const orgId of orgIds) {
            describeCache.invalidateByPrefix(`${orgId}::`);
            describeGlobalCache.invalidate(orgId);
          }
        };

        /**
         * The requests the executor's deps have sent, which a run counts its
         * calls by (`requestsSent`). Discovery and the drift check describe
         * through the same cache and add nothing here: a describe the run
         * found held, or already under way, is not one it sent.
         */
        let executorRequests = 0;
        const countExecutorRequest = (): void => {
          executorRequests++;
        };

        /**
         * The cached describe of `objectApiName` on `orgId`, fetched once.
         *
         * A caller that arrives while the same describe is under way waits for
         * it rather than sending a second one. `stops` are checked once the
         * connection is open, before the request goes out: jsforce cannot
         * cancel a request it has sent, so that is the last point where a
         * cancelled discovery or an expired timeout can still save the call.
         * They are the caller's own and never cancel a describe another
         * caller started.
         *
         * @param onSent - Told when this call sends the describe itself.
         */
        const describeOnce = async (
          orgId: string,
          objectApiName: string,
          stops: Array<AbortSignal | undefined> = [],
          onSent?: () => void,
        ): Promise<ForgeObjectDescribe> => {
          const key = `${orgId}::${objectApiName}`;
          const cached = describeCache.get(key);
          if (cached) return cached;
          const underWay = describesUnderWay.get(key);
          if (underWay) return underWay;

          const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
          for (const stop of stops) stop?.throwIfAborted();
          // The same describe may have started or finished while the
          // connection was opening.
          const settled = describeCache.get(key) ?? describesUnderWay.get(key);
          if (settled) return settled;

          onSent?.();
          const request = conn
            .describe(objectApiName)
            .then((meta) => {
              const described = toForgeObjectDescribe(meta);
              describeCache.set(key, described);
              return described;
            })
            .finally(() => describesUnderWay.delete(key));
          describesUnderWay.set(key, request);
          return request;
        };

        const discoveryService = new GraphDiscoveryService({
          describeObject: (orgId, objectApiName, signal) =>
            sfTimeouts.withTimeout(
              `describe:${objectApiName}`,
              async (timeoutSignal): Promise<ObjectDescribe> => {
                const described = await describeOnce(orgId, objectApiName, [signal, timeoutSignal]);
                return {
                  name: described.name,
                  fields: described.fields.map((f) => ({
                    name: f.name,
                    type: f.type,
                    referenceTo: f.referenceTo,
                    relationshipName: f.relationshipName,
                    isMasterDetail: f.cascadeDelete,
                    nillable: f.nillable,
                  })),
                  childRelationships: described.childRelationships.map((cr) => ({
                    childSObject: cr.childSObject,
                    field: cr.field,
                    relationshipName: cr.relationshipName,
                    isCascadeDelete: cr.cascadeDelete,
                  })),
                };
              },
              30_000,
            ),
          queryCount: (orgId, soql, signal) =>
            sfTimeouts.withTimeout(
              `queryCount`,
              async (timeoutSignal) => {
                const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
                signal?.throwIfAborted();
                timeoutSignal.throwIfAborted();
                const result = await conn.query<{ expr0: number }>(soql);
                return result.totalSize;
              },
              15_000,
            ),
          detectPII: (fields) => {
            const result = piiDetector.detectPII(
              'unknown',
              fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type })),
            );
            return result.piiFields.map((p) => p.fieldApiName);
          },
          describeGlobal: async (orgId, signal) => {
            const cached = describeGlobalCache.get(orgId);
            if (cached) return cached;
            const result = await sfTimeouts.withTimeout(
              'describeGlobal',
              async (timeoutSignal) => {
                const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
                signal?.throwIfAborted();
                timeoutSignal.throwIfAborted();
                const r = await conn.describeGlobal();
                return r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
              },
              60_000,
            );
            describeGlobalCache.set(orgId, result);
            return result;
          },
        });

        const batchStrategyService = new ForgeBatchStrategyService();

        const executor = new ForgeExecutor({
          queryRecords: async (orgId, soql, onTruncated) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            // `conn.query` returns only the FIRST page (2 000 records
            // max), so a 50 000-row object silently cloned as 2 000 rows.
            // `queryAllPages` follows the cursor, bounded, and says when a
            // bound cut the read short. See queryAllPages.ts for the bounds.
            const { records, pages, truncated } = await queryAllPages<Record<string, unknown>>(
              {
                // jsforce hands back a thenable `Query`, not a Promise.
                query: async (q) => {
                  countExecutorRequest();
                  return conn.query<Record<string, unknown>>(q);
                },
                queryMore: async (url) => {
                  countExecutorRequest();
                  return conn.queryMore<Record<string, unknown>>(url);
                },
              },
              soql,
            );
            if (truncated) {
              // The output channel says how short the read was; the callback
              // is what puts the object in the summary the wizard shows.
              onTruncated?.();
              log(
                `[forge] ${objectOfQuery(soql)}: query stopped at ${records.length} record(s) ` +
                  `after ${pages} page(s) (cap: ${FORGE_QUERY_MAX_RECORDS} records / ` +
                  `${FORGE_QUERY_MAX_PAGES} pages) — the source has more rows than were ` +
                  `cloned. Split the run with filters that each stay under the bound to clone the rest.`,
              );
            }
            return records;
          },
          // `allowRecursive` is what makes jsforce split an oversized array
          // itself: `if (records.length > MAX_DML_COUNT && options.allowRecursive)`
          // (jsforce 3.10 connection.js:800,887,938). Without it the whole array
          // goes out as one request and Salesforce rejects anything over 200.
          // The callers batch explicitly too — they need per-batch progress —
          // but this closes the class rather than the two call sites that were
          // found: any future writer through these deps is bounded by default.
          insertRecords: async (orgId, objectName, records) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            executorRequests += Math.ceil(records.length / RECORDS_PER_WRITE_CALL);
            /*
             * A clone is a deliberate duplicate. The target sandbox is a copy
             * of the org the records come from, so a duplicate rule fires on
             * every one of them: run against a real pair of orgs, the root
             * Account was refused with DUPLICATES_DETECTED before a single
             * record was written, and the whole graph under it was skipped.
             * The header tells Salesforce to save anyway, and applies to
             * duplicate RULES only — a unique index still refuses, which is
             * right. What guards a production org is the production guard.
             */
            const results = await conn
              .sobject(objectName)
              .create(records, { allowRecursive: true, headers: duplicateRuleHeaders(true) });
            // Read with its status code and the records a duplicate rule
            // matched. Only the message used to be kept, so a unique index
            // refusing a row the target already held reached the executor as
            // "duplicate value found: …" with nothing naming it a duplicate.
            return toSaveOutcomes(results, objectName);
          },
          updateRecords: async (orgId, objectName, records) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            executorRequests += Math.ceil(records.length / RECORDS_PER_WRITE_CALL);
            const results = await conn
              .sobject(objectName)
              .update(records as unknown as { Id: string }[], {
                allowRecursive: true,
                headers: duplicateRuleHeaders(true),
              });
            const arr = Array.isArray(results) ? results : [results];
            return arr.map((r, i) => ({
              id: r.id ?? (records[i]['Id'] as string) ?? '',
              success: r.success,
              errors: (r.errors ?? []).map(formatSaveError),
            }));
          },
          upsertRecords: async (orgId, objectName, externalIdField, records) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            executorRequests += Math.ceil(records.length / RECORDS_PER_WRITE_CALL);
            const results = await conn
              .sobject(objectName)
              .upsert(records as unknown as Record<string, unknown>[], externalIdField, {
                allowRecursive: true,
                headers: duplicateRuleHeaders(true),
              });
            return toSaveOutcomes(results, objectName);
          },
          describeFields: async (orgId, objectName) => {
            const described = await describeOnce(orgId, objectName, [], countExecutorRequest);
            return described.fields.map((f) => ({
              name: f.name,
              type: f.type,
              queryable: true,
              createable: f.createable,
              isReference: f.type === 'reference',
              referenceTo: f.referenceTo,
              nillable: f.nillable,
              picklistValues: f.picklistValues,
              externalId: f.externalId,
              updateable: f.updateable,
            }));
          },
          isObjectCreatable: async (orgId, objectName) =>
            (await describeOnce(orgId, objectName, [], countExecutorRequest)).createable,
          // The describe the field sets were read from: a run asks it for the
          // key prefix and record types without a request of its own.
          describeObject: async (orgId, objectName) => {
            const described = await describeOnce(orgId, objectName, [], countExecutorRequest);
            // A record type closed to the running user is what the run tells
            // the user to change in the target. Kept for five minutes, the
            // answer would hold the object back again on the retry that
            // follows the change: it is not kept past the run that read it.
            if (described.recordTypes.some((type) => !type.available && !type.master)) {
              describeCache.invalidate(`${orgId}::${objectName}`);
            }
            return { keyPrefix: described.keyPrefix, recordTypes: described.recordTypes };
          },
          batchStrategy: batchStrategyService,
          // What a run asked to copy files reads and writes: one file per
          // request each way, and the target's file storage before any.
          readFileBody: async (orgId, objectApiName, id) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            countExecutorRequest();
            return fileTransfer.readFileBody(conn, objectApiName, id);
          },
          insertFile: async (orgId, objectApiName, record) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            countExecutorRequest();
            return fileTransfer.insertFile(conn, objectApiName, record);
          },
          remainingFileStorageMB: async (orgId) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            countExecutorRequest();
            return fileTransfer.remainingFileStorageMB(conn);
          },
          requestsSent: () => executorRequests,
          // No `anonymize`: what a run anonymizes comes with the run — the
          // fields selected on each node, the methods Review holds — and the
          // executor keys an anonymizer of its own to each run. The one wired
          // here was handed an empty field list, so every record was written
          // as the source held it whatever the page said.
        });

        const planGenerator = new ForgePlanGenerator();
        const complianceService = new ForgeComplianceService();

        const metadataDiff = new ForgeMetadataDiff({
          describeObject: async (orgId, objectApiName) => {
            const described = await describeOnce(orgId, objectApiName);
            return {
              fields: described.fields.map((f) => ({
                name: f.name,
                type: f.type,
                createable: f.createable,
              })),
            };
          },
        });

        // No workspace folder means no `.sandforge/` to write into, so the
        // store is not constructed at all and the handler stays on its
        // ConfigStore path rather than writing to a path rooted at ''.
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const templateStore = workspacePath
          ? new ForgeTemplateStore({
              workspacePath,
              readFile: (path) => fs.readFile(path, 'utf-8'),
              writeFile: (path, content) => fs.writeFile(path, content, 'utf-8'),
              mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
            })
          : undefined;

        const historyStore = new ForgeHistoryStore({
          get: (key) => configStore.get(key),
          update: (key, value) => Promise.resolve(configStore.set(key, value)),
        });

        const forgeOrchestrator = new ForgeOrchestrator({
          discoveryService,
          executor,
          planGenerator,
          clearDescribes,
        });

        handlers.setForgeOrchestrator(forgeOrchestrator, {
          planGenerator,
          complianceService,
          metadataDiff,
          templateStore,
          historyStore,
        });
        log('Forge v2 module initialized.');
      },
    )
    .catch((err) => log(`Failed to init Forge module: ${String(err)}`));
}
