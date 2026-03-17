import type { BaseMessage } from '@sandforge/shared';
import { sanitizeSoqlObjectName, SF_API_VERSION } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { sendHandlerError } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';

/** Message types handled by CompareHandler. */
const COMPARE_TYPES = new Set([
  'compare:execute',
  'compare:start',
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

    await this.handleCompareStart(msg);
    return true;
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
      const { CompareOrchestrator } = await import('../../modules/compare/CompareOrchestrator.js');

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

      const orchestrator = new CompareOrchestrator({
        metadataCompare,
        configCompare,
        permissionCompare,
        dataCompare,
        diffEngine,
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

      const response: BaseMessage & { payload: Record<string, unknown> } = {
        id: this.deps.nextId(),
        type: 'compare:start:response',
        timestamp: Date.now(),
        payload: result as unknown as Record<string, unknown>,
      };
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:start', 'compare:error', err);
    }
  }
}
