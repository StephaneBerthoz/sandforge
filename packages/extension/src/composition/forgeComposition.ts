import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { SchemaCache } from '../core/metadata/SchemaCache';
import { TimeoutManager } from '../core/engine/TimeoutManager';
import type { ObjectDescribe } from '../modules/forge/GraphDiscoveryService';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { OrgRegistry } from '../core/connection/OrgRegistry';
import type { OrgManager } from '../core/connection/OrgManager';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { PIIDetector } from '../core/precheck/PIIDetector';

/** Inputs required to wire the Forge orchestrator (Tier 5). */
export interface ForgeCompositionDeps {
  handlers: ExtensionHandlers;
  orgRegistry: OrgRegistry;
  orgManager: OrgManager;
  configStore: ConfigStore;
  piiDetector: PIIDetector;
  log: (msg: string) => void;
}

/**
 * Wire up the Forge orchestrator (Tier 5) via dynamic imports, then inject it
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
    import('../modules/forge/ForgeAnonymizer.js'),
    import('../modules/forge/ForgeComplianceService.js'),
    import('../modules/forge/ForgeMetadataDiff.js'),
    import('../modules/forge/ForgeBatchStrategy.js'),
    import('../modules/forge/ForgeTemplateStore.js'),
    import('../modules/forge/ForgeHistoryStore.js'),
    import('../core/connection/ConnectionHelper.js'),
  ])
    .then(
      ([
        { GraphDiscoveryService },
        { ForgeExecutor },
        { ForgeOrchestrator },
        { ForgePlanGenerator },
        { ForgeAnonymizer },
        { ForgeComplianceService },
        { ForgeMetadataDiff },
        { ForgeBatchStrategy: ForgeBatchStrategyService },
        { ForgeTemplateStore },
        { ForgeHistoryStore },
        { getJsforceConnection },
      ]) => {
        // Shared schema cache + timeout manager. Eliminates the 600+ describe
        // round-trips per forge run on big orgs (SOURCE-UAT = 350+ SObjects).
        // Per-call timeouts: describe 30s, describeGlobal 60s, queryCount 15s.
        // Without timeouts, jsforce calls hang indefinitely on rate-limited orgs.
        //
        // PERF-002: byte cap backed by a structural estimator that walks each
        // field descriptor (name/label/type/picklist values/help text) instead
        // of JSON.stringify — see SchemaCache.estimateSize. `maxSize` is the
        // count backstop: 50 entries caps the describe heap at a sane fraction
        // of the extension-host budget even for raw describes (~1-2 MB each
        // real heap → ~50-100 MB worst case), while still covering the
        // working set of a typical forge run (root + direct children BFS).
        const describeCache = new SchemaCache<ObjectDescribe>({
          defaultTtl: 5 * 60_000,
          maxSize: 50,
          maxSizeBytes: 200 * 1024 * 1024,
        });
        const describeGlobalCache = new SchemaCache<
          Array<{ name: string; keyPrefix: string | null }>
        >({
          defaultTtl: 5 * 60_000,
          maxSize: 16,
          maxSizeBytes: 50 * 1024 * 1024,
        });
        const sfTimeouts = new TimeoutManager(30_000);

        const discoveryService = new GraphDiscoveryService({
          describeObject: async (orgId, objectApiName) => {
            const cacheKey = `${orgId}::${objectApiName}`;
            const cached = describeCache.get(cacheKey);
            if (cached) return cached;
            const formatted = await sfTimeouts.withTimeout(
              `describe:${objectApiName}`,
              async () => {
                const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
                const meta = await conn.describe(objectApiName);
                return {
                  name: meta.name,
                  fields: meta.fields.map((f) => ({
                    name: f.name,
                    type: f.type,
                    referenceTo: f.referenceTo ?? [],
                    relationshipName: f.relationshipName ?? null,
                    isMasterDetail: f.cascadeDelete === true,
                  })),
                  childRelationships: (meta.childRelationships ?? []).map((cr) => ({
                    childSObject: cr.childSObject,
                    field: cr.field,
                    relationshipName: cr.relationshipName ?? cr.field,
                    isCascadeDelete: cr.cascadeDelete === true,
                  })),
                };
              },
              30_000,
            );
            describeCache.set(cacheKey, formatted);
            return formatted;
          },
          queryCount: async (orgId, soql) => {
            return sfTimeouts.withTimeout(
              `queryCount`,
              async () => {
                const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
                const result = await conn.query<{ expr0: number }>(soql);
                return result.totalSize;
              },
              15_000,
            );
          },
          detectPII: (fields) => {
            const result = piiDetector.detectPII(
              'unknown',
              fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type })),
            );
            return result.piiFields.map((p) => p.fieldApiName);
          },
          describeGlobal: async (orgId) => {
            const cached = describeGlobalCache.get(orgId);
            if (cached) return cached;
            const result = await sfTimeouts.withTimeout(
              'describeGlobal',
              async () => {
                const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
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
        const anonymizer = new ForgeAnonymizer();

        const executor = new ForgeExecutor({
          queryRecords: async (orgId, soql) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const result = await conn.query<Record<string, unknown>>(soql);
            return result.records;
          },
          insertRecords: async (orgId, objectName, records) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const results = await conn.sobject(objectName).create(records);
            const arr = Array.isArray(results) ? results : [results];
            return arr.map((r) => ({
              id: r.id ?? '',
              success: r.success,
              errors: r.errors?.map((e: { message: string }) => e.message) ?? [],
            }));
          },
          updateRecords: async (orgId, objectName, records) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const results = await conn
              .sobject(objectName)
              .update(records as unknown as { Id: string }[]);
            const arr = Array.isArray(results) ? results : [results];
            return arr.map((r, i) => ({
              id: r.id ?? (records[i]['Id'] as string) ?? '',
              success: r.success,
              errors: r.errors?.map((e: { message: string }) => e.message) ?? [],
            }));
          },
          upsertRecords: async (orgId, objectName, externalIdField, records) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const results = await conn
              .sobject(objectName)
              .upsert(records as unknown as Record<string, unknown>[], externalIdField);
            const arr = Array.isArray(results) ? results : [results];
            return arr.map((r) => ({
              id: r.id ?? '',
              success: r.success,
              errors: r.errors?.map((e: { message: string }) => e.message) ?? [],
            }));
          },
          describeFields: async (orgId, objectName) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const meta = await conn.describe(objectName);
            return meta.fields.map((f) => ({
              name: f.name,
              queryable: true,
              createable: f.createable ?? false,
              isReference: f.type === 'reference',
              referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
              nillable: f.nillable ?? true,
              picklistValues: (f.picklistValues ?? [])
                .filter((p) => p?.active !== false && typeof p?.value === 'string')
                .map((p) => p.value as string),
              externalId: f.externalId === true,
            }));
          },
          isObjectCreatable: async (orgId, objectName) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const meta = await conn.describe(objectName);
            // Default to true when jsforce omits the flag — only opt out when
            // the org explicitly says false (read-only system entities).
            return meta.createable !== false;
          },
          batchStrategy: batchStrategyService,
          anonymize: (records, objectApiName) => {
            return anonymizer.anonymizeRecords(
              records,
              [],
              anonymizer.getDefaults(),
              objectApiName,
            );
          },
        });

        const planGenerator = new ForgePlanGenerator();
        const complianceService = new ForgeComplianceService();

        const metadataDiff = new ForgeMetadataDiff({
          describeObject: async (orgId, objectApiName) => {
            const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
            const meta = await conn.describe(objectApiName);
            return {
              fields: meta.fields.map((f) => ({
                name: f.name,
                type: f.type,
                createable: f.createable ?? false,
              })),
            };
          },
        });

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const templateStore = new ForgeTemplateStore({
          workspacePath,
          readFile: (path) => fs.readFile(path, 'utf-8'),
          writeFile: (path, content) => fs.writeFile(path, content, 'utf-8'),
          mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
        });

        const historyStore = new ForgeHistoryStore({
          get: (key) => configStore.get(key),
          update: (key, value) => Promise.resolve(configStore.set(key, value)),
        });

        const forgeOrchestrator = new ForgeOrchestrator({
          discoveryService,
          executor,
          planGenerator,
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
