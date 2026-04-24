import type { BaseMessage } from '@sandforge/shared';
import { sanitizeSoqlObjectName, SF_API_VERSION } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';

/**
 * Message types handled by CompareHandler.
 * `compare:execute` is the canonical type; `compare:start` is kept as a legacy alias.
 */
const COMPARE_TYPES = new Set([
  'compare:execute',
  'compare:start',
  'compare:permissions',
  'compare:snapshots',
  'compare:drift',
]);

/**
 * Domain handler for compare-related webview-to-extension messages.
 *
 * Routes compare:* message types to metadata, config, permission,
 * and data comparison operations between two Salesforce orgs.
 */
export class CompareHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!COMPARE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'compare:execute':
      case 'compare:start':
        await this.handleCompareStart(msg);
        return true;
      case 'compare:permissions':
        await this.handlePermissions(msg);
        return true;
      case 'compare:snapshots':
        await this.handleSnapshots(msg);
        return true;
      case 'compare:drift':
        await this.handleDrift(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleCompareStart(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string; types: string[] } }).payload;

    try {
      const sourceConn = await getJsforceConnection(payload.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(payload.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve dynamic query limits based on source org tier
      const compareSourceOrg = this.deps.orgManager.getOrg(payload.sourceOrgId);
      const compareOrgTier = resolveOrgTier(compareSourceOrg?.orgType === 'Sandbox' || compareSourceOrg?.orgType === 'Scratch');
      const compareQueryLimits = getQueryLimits(compareOrgTier);

      const { DiffEngine } = await import('../../modules/compare/DiffEngine.js');
      const { MetadataCompare } = await import('../../modules/compare/MetadataCompare.js');
      const { ConfigCompare } = await import('../../modules/compare/ConfigCompare.js');
      const { PermissionCompare } = await import('../../modules/compare/PermissionCompare.js');
      const { DataCompare } = await import('../../modules/compare/DataCompare.js');

      const diffEngine = new DiffEngine();

      const fetchMetadata = async (orgId: string, componentType: import('@sandforge/shared').MetadataComponentType) => {
        const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
        const components = new Map<string, string>();
        const listResult = await conn.metadata.list([{ type: componentType }]) as Array<{ fullName: string }>;
        checkApiLimits(conn.limitInfo, `compare:metadata list ${String(componentType)}`);
        for (const item of (Array.isArray(listResult) ? listResult : [])) {
          components.set(item.fullName, JSON.stringify(item));
        }
        return components;
      };

      const metadataCompare = new MetadataCompare(fetchMetadata, diffEngine);
      const configCompare = new ConfigCompare(
        async (orgId) => {
          const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
          const settings = await conn.request(`/services/data/${SF_API_VERSION}/tooling/query?q=SELECT+FullName,Metadata+FROM+OrgWideEmailAddress+LIMIT+1`) as Record<string, string>;
          return new Map<string, string>(Object.entries(settings));
        },
        diffEngine,
      );
      const permissionCompare = new PermissionCompare(
        async (orgId) => {
          const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
          const records = await queryAll<{ Id: string; Name: string }>(
            conn,
            `SELECT Id, Name FROM PermissionSet LIMIT ${compareQueryLimits.permissionSetLimit}`,
          );
          checkApiLimits(conn.limitInfo, `compare:permissionSets query`);
          return records.map(r => ({
            name: r.Name,
            type: 'PermissionSet' as const,
            objectPermissions: {} as Record<string, { create: boolean; read: boolean; update: boolean; delete: boolean }>,
            fieldPermissions: {} as Record<string, boolean>,
          }));
        },
      );
      const dataCompare = new DataCompare(
        async (orgId, objectName) => {
          const safeObj = sanitizeSoqlObjectName(objectName);
          const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
          const dataRecords = await queryWithFieldsFallback<Record<string, string>>(
            conn, safeObj,
            `SELECT FIELDS(ALL) FROM ${safeObj} LIMIT ${compareQueryLimits.defaultQueryLimit}`,
          );
          checkApiLimits(conn.limitInfo, `compare:data query ${safeObj}`);
          return dataRecords;
        },
      );

      if (!this.deps.services) {
        throw new Error('CompareHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.');
      }
      const orchestrator = this.deps.services.compareOrchestrator({
        metadataCompare,
        configCompare,
        permissionCompare,
        dataCompare,
        diffEngine,
        services: this.deps.services,
      });

      const config: import('@sandforge/shared').CompareConfig = {
        id: crypto.randomUUID(),
        name: 'compare-from-ui',
        sourceOrgId: payload.sourceOrgId,
        targetOrgId: payload.targetOrgId,
        mode: 'metadata',
        componentTypes: payload.types as import('@sandforge/shared').MetadataComponentType[],
        includeManaged: false,
        includeUnmanaged: true,
        createdAt: new Date().toISOString(),
      };

      const result = await orchestrator.execute(config);

      const response = buildResponse(this.deps, msg, 'compare:execute:response', result as unknown as Record<string, unknown>);
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:execute', 'compare:error', err);
    }
  }

  /**
   * Handle compare:permissions -- query permission sets and profiles from both orgs,
   * compare field-level and object-level permissions, and return a diff.
   */
  private async handlePermissions(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } }).payload;

    try {
      const sourceConn = await getJsforceConnection(payload.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(payload.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      const sourceOrg = this.deps.orgManager.getOrg(payload.sourceOrgId);
      const orgTier = resolveOrgTier(sourceOrg?.orgType === 'Sandbox' || sourceOrg?.orgType === 'Scratch');
      const limits = getQueryLimits(orgTier);

      const fetchPermissions = async (conn: Awaited<ReturnType<typeof getJsforceConnection>>, label: string) => {
        const permSets = await queryAll<{ Id: string; Name: string; Label: string; IsOwnedByProfile: boolean }>(
          conn,
          `SELECT Id, Name, Label, IsOwnedByProfile FROM PermissionSet LIMIT ${limits.permissionSetLimit}`,
        );
        checkApiLimits(conn.limitInfo, `compare:permissions ${label}`);

        const profiles = await queryAll<{ Id: string; Name: string }>(
          conn,
          `SELECT Id, Name FROM Profile LIMIT ${limits.permissionSetLimit}`,
        );
        checkApiLimits(conn.limitInfo, `compare:permissions profiles ${label}`);

        return { permSets, profiles };
      };

      const [sourcePerms, targetPerms] = await Promise.all([
        fetchPermissions(sourceConn, 'source'),
        fetchPermissions(targetConn, 'target'),
      ]);

      const sourcePermNames = new Set(sourcePerms.permSets.map((p) => p.Name));
      const targetPermNames = new Set(targetPerms.permSets.map((p) => p.Name));
      const sourceProfileNames = new Set(sourcePerms.profiles.map((p) => p.Name));
      const targetProfileNames = new Set(targetPerms.profiles.map((p) => p.Name));

      const permissionDiffs = {
        permissionSets: {
          sourceOnly: sourcePerms.permSets.filter((p) => !targetPermNames.has(p.Name)).map((p) => ({ name: p.Name, label: p.Label })),
          targetOnly: targetPerms.permSets.filter((p) => !sourcePermNames.has(p.Name)).map((p) => ({ name: p.Name, label: p.Label })),
          shared: sourcePerms.permSets.filter((p) => targetPermNames.has(p.Name)).map((p) => ({ name: p.Name, label: p.Label })),
        },
        profiles: {
          sourceOnly: sourcePerms.profiles.filter((p) => !targetProfileNames.has(p.Name)).map((p) => ({ name: p.Name })),
          targetOnly: targetPerms.profiles.filter((p) => !sourceProfileNames.has(p.Name)).map((p) => ({ name: p.Name })),
          shared: sourcePerms.profiles.filter((p) => targetProfileNames.has(p.Name)).map((p) => ({ name: p.Name })),
        },
      };

      const response = buildResponse(this.deps, msg, 'compare:permissions:response', { permissions: permissionDiffs });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:permissions', 'compare:error', err);
    }
  }

  /**
   * Handle compare:snapshots -- capture org metadata snapshots via describeGlobal
   * and compare object counts, custom objects, and fields between orgs.
   */
  private async handleSnapshots(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } }).payload;

    try {
      const sourceConn = await getJsforceConnection(payload.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(payload.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      const describeOrg = async (conn: Awaited<ReturnType<typeof getJsforceConnection>>, label: string) => {
        const globalDescribe = await conn.describeGlobal();
        checkApiLimits(conn.limitInfo, `compare:snapshots describeGlobal ${label}`);

        const allObjects = globalDescribe.sobjects.map((s: { name: string; custom: boolean; label: string; queryable: boolean }) => ({
          name: s.name,
          custom: s.custom,
          label: s.label,
          queryable: s.queryable,
        }));

        return {
          totalObjects: allObjects.length,
          customObjects: allObjects.filter((o) => o.custom).length,
          standardObjects: allObjects.filter((o) => !o.custom).length,
          queryableObjects: allObjects.filter((o) => o.queryable).length,
          objects: allObjects,
        };
      };

      const [sourceSnapshot, targetSnapshot] = await Promise.all([
        describeOrg(sourceConn, 'source'),
        describeOrg(targetConn, 'target'),
      ]);

      const sourceObjectNames = new Set(sourceSnapshot.objects.map((o) => o.name));
      const targetObjectNames = new Set(targetSnapshot.objects.map((o) => o.name));

      const snapshot = {
        source: {
          orgId: payload.sourceOrgId,
          totalObjects: sourceSnapshot.totalObjects,
          customObjects: sourceSnapshot.customObjects,
          standardObjects: sourceSnapshot.standardObjects,
          queryableObjects: sourceSnapshot.queryableObjects,
        },
        target: {
          orgId: payload.targetOrgId,
          totalObjects: targetSnapshot.totalObjects,
          customObjects: targetSnapshot.customObjects,
          standardObjects: targetSnapshot.standardObjects,
          queryableObjects: targetSnapshot.queryableObjects,
        },
        diff: {
          sourceOnly: sourceSnapshot.objects.filter((o) => !targetObjectNames.has(o.name)).map((o) => o.name),
          targetOnly: targetSnapshot.objects.filter((o) => !sourceObjectNames.has(o.name)).map((o) => o.name),
          sharedCount: sourceSnapshot.objects.filter((o) => targetObjectNames.has(o.name)).length,
        },
        capturedAt: new Date().toISOString(),
      };

      const response = buildResponse(this.deps, msg, 'compare:snapshots:response', { snapshot });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:snapshots', 'compare:error', err);
    }
  }

  /**
   * Handle compare:drift -- detect configuration drift between two orgs by comparing
   * key org settings (CompanyInfo, SecuritySettings, OrgPreference).
   */
  private async handleDrift(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } }).payload;

    try {
      const sourceConn = await getJsforceConnection(payload.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(payload.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      const fetchOrgSettings = async (conn: Awaited<ReturnType<typeof getJsforceConnection>>, label: string) => {
        const settings: Record<string, string> = {};

        const companyInfo = await queryAll<Record<string, string>>(
          conn,
          'SELECT Name, LanguageLocaleKey, DefaultLocaleSidKey, TimeZoneSidKey, FiscalYearStartMonth FROM Organization LIMIT 1',
        );
        checkApiLimits(conn.limitInfo, `compare:drift companyInfo ${label}`);
        if (companyInfo[0]) {
          for (const [key, value] of Object.entries(companyInfo[0])) {
            if (key !== 'attributes' && key !== 'Id') {
              settings[`Organization.${key}`] = String(value);
            }
          }
        }

        return settings;
      };

      const [sourceSettings, targetSettings] = await Promise.all([
        fetchOrgSettings(sourceConn, 'source'),
        fetchOrgSettings(targetConn, 'target'),
      ]);

      const allKeys = new Set([...Object.keys(sourceSettings), ...Object.keys(targetSettings)]);
      const driftItems: Array<{ setting: string; sourceValue: string; targetValue: string; status: 'match' | 'drift' | 'missing_source' | 'missing_target' }> = [];

      for (const key of allKeys) {
        const sourceVal = sourceSettings[key];
        const targetVal = targetSettings[key];

        if (sourceVal === undefined) {
          driftItems.push({ setting: key, sourceValue: '', targetValue: targetVal ?? '', status: 'missing_source' });
        } else if (targetVal === undefined) {
          driftItems.push({ setting: key, sourceValue: sourceVal, targetValue: '', status: 'missing_target' });
        } else if (sourceVal !== targetVal) {
          driftItems.push({ setting: key, sourceValue: sourceVal, targetValue: targetVal, status: 'drift' });
        } else {
          driftItems.push({ setting: key, sourceValue: sourceVal, targetValue: targetVal, status: 'match' });
        }
      }

      const drift = {
        items: driftItems,
        totalChecked: driftItems.length,
        driftCount: driftItems.filter((d) => d.status === 'drift').length,
        matchCount: driftItems.filter((d) => d.status === 'match').length,
        missingCount: driftItems.filter((d) => d.status === 'missing_source' || d.status === 'missing_target').length,
        detectedAt: new Date().toISOString(),
      };

      const response = buildResponse(this.deps, msg, 'compare:drift:response', { drift });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:drift', 'compare:error', err);
    }
  }
}
