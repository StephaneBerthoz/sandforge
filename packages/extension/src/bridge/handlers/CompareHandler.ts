import { sanitizeSoqlObjectName, SF_API_VERSION } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  compareExecutePayloadSchema,
  compareOrgsPayloadSchema,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';

/**
 * The types listMetadata answers only folder by folder, each with the type
 * that lists its folders (the unfiled folder among them). Asked without a
 * folder it answers with nothing: run against two sandboxes holding 191
 * reports, 17 dashboards and 80 email templates each, the diff listed none of
 * them and so found no difference in any.
 */
const FOLDER_TYPES: Partial<Record<string, string>> = {
  Report: 'ReportFolder',
  Dashboard: 'DashboardFolder',
  EmailTemplate: 'EmailTemplateFolder',
};

/** Message types handled by CompareHandler. */
const COMPARE_TYPES = new Set([
  'compare:execute',
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
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!COMPARE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'compare:execute':
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

  private async handleCompareStart(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareExecutePayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Resolve dynamic query limits based on source org tier
      const compareSourceOrg = this.deps.orgManager.getOrg(payload.sourceOrgId);
      const compareOrgTier = resolveOrgTier(
        compareSourceOrg?.orgType === 'Sandbox' || compareSourceOrg?.orgType === 'Scratch',
      );
      const compareQueryLimits = getQueryLimits(compareOrgTier);

      const { DiffEngine } = await import('../../modules/compare/DiffEngine.js');
      const { MetadataCompare } = await import('../../modules/compare/MetadataCompare.js');
      const { ConfigCompare } = await import('../../modules/compare/ConfigCompare.js');
      const { PermissionCompare } = await import('../../modules/compare/PermissionCompare.js');
      const { DataCompare } = await import('../../modules/compare/DataCompare.js');

      const diffEngine = new DiffEngine();

      const fetchMetadata = async (
        orgId: string,
        componentType: import('@sandforge/shared').MetadataComponentType,
      ) => {
        const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
        const components = new Map<string, string>();
        const list = async (queries: Array<{ type: string; folder?: string }>) => {
          const listResult = (await conn.metadata.list(queries)) as Array<{ fullName: string }>;
          checkApiLimits(conn.limitInfo, `compare:metadata list ${String(componentType)}`);
          return Array.isArray(listResult) ? listResult : [];
        };
        const folderType = FOLDER_TYPES[componentType];
        const queries = folderType
          ? (await list([{ type: folderType }])).map((f) => ({
              type: componentType,
              folder: f.fullName,
            }))
          : [{ type: componentType }];
        // listMetadata takes three queries per call.
        for (let i = 0; i < queries.length; i += 3) {
          for (const item of await list(queries.slice(i, i + 3))) {
            components.set(item.fullName, JSON.stringify(item));
          }
        }
        return components;
      };

      const metadataCompare = new MetadataCompare(fetchMetadata, diffEngine);
      const configCompare = new ConfigCompare(async (orgId) => {
        const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
        const settings = (await conn.request(
          `/services/data/${SF_API_VERSION}/tooling/query?q=SELECT+FullName,Metadata+FROM+OrgWideEmailAddress+LIMIT+1`,
        )) as Record<string, string>;
        return new Map<string, string>(Object.entries(settings));
      }, diffEngine);
      const permissionCompare = new PermissionCompare(async (orgId) => {
        const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
        const records = await queryAll<{ Id: string; Name: string }>(
          conn,
          `SELECT Id, Name FROM PermissionSet LIMIT ${compareQueryLimits.permissionSetLimit}`,
        );
        checkApiLimits(conn.limitInfo, `compare:permissionSets query`);
        return records.map((r) => ({
          name: r.Name,
          type: 'PermissionSet' as const,
          objectPermissions: {} as Record<
            string,
            { create: boolean; read: boolean; update: boolean; delete: boolean }
          >,
          fieldPermissions: {} as Record<string, boolean>,
        }));
      });
      const dataCompare = new DataCompare(async (orgId, objectName) => {
        const safeObj = sanitizeSoqlObjectName(objectName);
        const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
        const dataRecords = await queryWithFieldsFallback<Record<string, string>>(
          conn,
          safeObj,
          `SELECT FIELDS(ALL) FROM ${safeObj} LIMIT ${compareQueryLimits.defaultQueryLimit}`,
        );
        checkApiLimits(conn.limitInfo, `compare:data query ${safeObj}`);
        return dataRecords;
      });

      if (!this.deps.services) {
        throw new Error(
          'CompareHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
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

      const response = buildResponse(
        this.deps,
        msg,
        'compare:execute:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:execute', 'compare:error', msg, err);
    }
  }

  /**
   * Handle compare:permissions -- query permission sets and profiles from both orgs,
   * compare field-level and object-level permissions, and return a diff.
   */
  private async handlePermissions(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareOrgsPayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Every row of both orgs, as queryAll pages through them. A LIMIT with no
      // ORDER BY hands back a different slice of each org: run against two
      // sandboxes holding 283 and 282 permission sets, a hundred of each came
      // back and the tab listed 9 and 9 on one side only, where the orgs
      // differ by 3 and 2.
      const fetchPermissions = async (
        conn: Awaited<ReturnType<typeof getJsforceConnection>>,
        label: string,
      ) => {
        // Not the ones profiles own: each is named after its profile's Id in
        // that org (X00e…), so the same profile goes by two names across two
        // orgs. The profiles are compared by name below.
        const permSets = await queryAll<{
          Id: string;
          Name: string;
          Label: string;
          IsOwnedByProfile: boolean;
        }>(
          conn,
          'SELECT Id, Name, Label, IsOwnedByProfile FROM PermissionSet WHERE IsOwnedByProfile = false',
        );
        checkApiLimits(conn.limitInfo, `compare:permissions ${label}`);

        const profiles = await queryAll<{ Id: string; Name: string }>(
          conn,
          'SELECT Id, Name FROM Profile',
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
          sourceOnly: sourcePerms.permSets
            .filter((p) => !targetPermNames.has(p.Name))
            .map((p) => ({ name: p.Name, label: p.Label })),
          targetOnly: targetPerms.permSets
            .filter((p) => !sourcePermNames.has(p.Name))
            .map((p) => ({ name: p.Name, label: p.Label })),
          shared: sourcePerms.permSets
            .filter((p) => targetPermNames.has(p.Name))
            .map((p) => ({ name: p.Name, label: p.Label })),
        },
        profiles: {
          sourceOnly: sourcePerms.profiles
            .filter((p) => !targetProfileNames.has(p.Name))
            .map((p) => ({ name: p.Name })),
          targetOnly: targetPerms.profiles
            .filter((p) => !sourceProfileNames.has(p.Name))
            .map((p) => ({ name: p.Name })),
          shared: sourcePerms.profiles
            .filter((p) => targetProfileNames.has(p.Name))
            .map((p) => ({ name: p.Name })),
        },
      };

      const response = buildResponse(this.deps, msg, 'compare:permissions:response', {
        permissions: permissionDiffs,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:permissions', 'compare:error', msg, err);
    }
  }

  /**
   * Handle compare:snapshots -- capture org metadata snapshots via describeGlobal
   * and compare object counts, custom objects, and fields between orgs.
   */
  private async handleSnapshots(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareOrgsPayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const describeOrg = async (
        conn: Awaited<ReturnType<typeof getJsforceConnection>>,
        label: string,
      ) => {
        const globalDescribe = await conn.describeGlobal();
        checkApiLimits(conn.limitInfo, `compare:snapshots describeGlobal ${label}`);

        const allObjects = globalDescribe.sobjects.map(
          (s: { name: string; custom: boolean; label: string; queryable: boolean }) => ({
            name: s.name,
            custom: s.custom,
            label: s.label,
            queryable: s.queryable,
          }),
        );

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
          sourceOnly: sourceSnapshot.objects
            .filter((o) => !targetObjectNames.has(o.name))
            .map((o) => o.name),
          targetOnly: targetSnapshot.objects
            .filter((o) => !sourceObjectNames.has(o.name))
            .map((o) => o.name),
          sharedCount: sourceSnapshot.objects.filter((o) => targetObjectNames.has(o.name)).length,
        },
        capturedAt: new Date().toISOString(),
      };

      const response = buildResponse(this.deps, msg, 'compare:snapshots:response', { snapshot });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:snapshots', 'compare:error', msg, err);
    }
  }

  /**
   * Handle compare:drift -- compare the five Organization fields below on both
   * orgs, on request. No metadata is read: the one query is
   * `SELECT Name, LanguageLocaleKey, DefaultLocaleSidKey, TimeZoneSidKey,
   * FiscalYearStartMonth FROM Organization`.
   */
  private async handleDrift(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareOrgsPayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const fetchOrgSettings = async (
        conn: Awaited<ReturnType<typeof getJsforceConnection>>,
        label: string,
      ) => {
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
      const driftItems: Array<{
        setting: string;
        sourceValue: string;
        targetValue: string;
        status: 'match' | 'drift' | 'missing_source' | 'missing_target';
      }> = [];

      for (const key of allKeys) {
        const sourceVal = sourceSettings[key];
        const targetVal = targetSettings[key];

        if (sourceVal === undefined) {
          driftItems.push({
            setting: key,
            sourceValue: '',
            targetValue: targetVal ?? '',
            status: 'missing_source',
          });
        } else if (targetVal === undefined) {
          driftItems.push({
            setting: key,
            sourceValue: sourceVal,
            targetValue: '',
            status: 'missing_target',
          });
        } else if (sourceVal !== targetVal) {
          driftItems.push({
            setting: key,
            sourceValue: sourceVal,
            targetValue: targetVal,
            status: 'drift',
          });
        } else {
          driftItems.push({
            setting: key,
            sourceValue: sourceVal,
            targetValue: targetVal,
            status: 'match',
          });
        }
      }

      const drift = {
        items: driftItems,
        totalChecked: driftItems.length,
        driftCount: driftItems.filter((d) => d.status === 'drift').length,
        matchCount: driftItems.filter((d) => d.status === 'match').length,
        missingCount: driftItems.filter(
          (d) => d.status === 'missing_source' || d.status === 'missing_target',
        ).length,
        detectedAt: new Date().toISOString(),
      };

      const response = buildResponse(this.deps, msg, 'compare:drift:response', { drift });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:drift', 'compare:error', msg, err);
    }
  }
}
