import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { sendNotification } from './HandlerTypes.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { ForgeHandler } from './ForgeHandler.js';
import type { ForgeHandlerDeps } from './ForgeHandler.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';

/** All forge message types routed through ForgeOpsHandler. */
const FORGE_TYPES = new Set([
  'forge:preview',
  'forge:discover',
  'forge:execute',
  'forge:pause',
  'forge:resume',
  'forge:abort',
  'forge:templates:list',
  'forge:templates:save',
  'forge:templates:delete',
  'forge:history:list',
  'forge:plan:request',
  'forge:compliance:request',
  'forge:metadata-diff:request',
]);

/**
 * Domain handler for forge-related webview-to-extension messages.
 *
 * Handles forge:preview directly and delegates all other forge:*
 * messages to the existing ForgeHandler domain handler.
 */
export class ForgeOpsHandler implements DomainHandler {
  private forgeHandler?: ForgeHandler;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject forge orchestrator and optional v2 services.
   *
   * @param orchestrator - The ForgeOrchestrator instance.
   * @param services - Optional additional Forge v2 services.
   */
  setForgeOrchestrator(
    orchestrator: ForgeOrchestrator,
    services?: Omit<ForgeHandlerDeps, 'orchestrator' | 'postMessage'>,
  ): void {
    this.forgeHandler = new ForgeHandler({
      orchestrator,
      postMessage: (msg) => this.deps.broker.postToWebview(msg as BaseMessage),
      ...services,
    });
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!FORGE_TYPES.has(msg.type)) return false;

    if (msg.type === 'forge:preview') {
      await this.handleForgePreview(msg);
      return true;
    }

    // Delegate to ForgeHandler
    return this.delegateToForgeHandler(msg);
  }

  private async delegateToForgeHandler(msg: BaseMessage): Promise<boolean> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    if (!this.forgeHandler) {
      sendNotification(this.deps, 'warning', 'Forge', 'Forge module is not initialized.');
      return true;
    }
    const payload = (msg as BaseMessage & { payload?: unknown }).payload;
    await this.forgeHandler.handle(msg.type, payload);
    return true;
  }

  private async handleForgePreview(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { recordId, orgId } = (msg as BaseMessage & { payload: { recordId: string; orgId: string } }).payload;

    try {
      if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(recordId)) {
        this.deps.broker.postToWebview({
          type: 'forge:preview:error',
          id: this.deps.nextId(),
          timestamp: Date.now(),
          payload: { message: 'Invalid Record ID format' },
        } as BaseMessage);
        return;
      }

      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve object type from record ID key prefix
      const keyPrefix = recordId.substring(0, 3);
      const globalDesc = await conn.describeGlobal();
      checkApiLimits(conn.limitInfo, 'forge:preview describeGlobal');
      const sobjectInfo = globalDesc.sobjects.find(
        (s) => s.keyPrefix === keyPrefix,
      );

      if (!sobjectInfo) {
        this.deps.broker.postToWebview({
          type: 'forge:preview:error',
          id: this.deps.nextId(),
          timestamp: Date.now(),
          payload: { message: `Unknown object for key prefix "${keyPrefix}"` },
        } as BaseMessage);
        return;
      }

      // Query the record with standard fields (with fallback for orgs not supporting FIELDS() syntax)
      const records = await queryWithFieldsFallback<Record<string, unknown>>(
        conn, sobjectInfo.name,
        `SELECT FIELDS(STANDARD) FROM ${sobjectInfo.name} WHERE Id = '${sanitizeSoqlValue(recordId)}' LIMIT 1`,
      );
      checkApiLimits(conn.limitInfo, `forge:preview query ${sobjectInfo.name}`);

      if (!records || records.length === 0) {
        this.deps.broker.postToWebview({
          type: 'forge:preview:error',
          id: this.deps.nextId(),
          timestamp: Date.now(),
          payload: { message: `Record not found: ${recordId}` },
        } as BaseMessage);
        return;
      }

      const record = records[0];
      const skipKeys = new Set(['attributes', 'Id']);
      const fields = Object.entries(record)
        .filter(([key]) => !skipKeys.has(key))
        .filter(([, value]) => value != null && String(value) !== '')
        .slice(0, 8)
        .map(([key, value]) => ({ name: key, value: String(value) }));

      this.deps.broker.postToWebview({
        type: 'forge:preview:response',
        id: this.deps.nextId(),
        timestamp: Date.now(),
        payload: {
          objectApiName: sobjectInfo.name,
          objectLabel: sobjectInfo.label,
          recordId,
          fields,
        },
      } as BaseMessage);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] forge:preview: ${message}`);
      this.deps.broker.postToWebview({
        type: 'forge:preview:error',
        id: this.deps.nextId(),
        timestamp: Date.now(),
        payload: { message },
      } as BaseMessage);
    }
  }
}
