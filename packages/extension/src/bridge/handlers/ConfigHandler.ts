import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { ConfigProfileManager } from '../../core/config/ConfigProfileManager.js';
import type { ConfigCategory } from '../../core/config/ConfigProfileManager.js';

/** Message types handled by ConfigHandler. */
const CONFIG_TYPES = new Set([
  'config:export',
  'config:import',
  'config:categories',
  'config:validate',
]);

/**
 * Domain handler for configuration profile export/import messages.
 *
 * Manages export, import, validation, and category listing for
 * SandForge configuration profiles.
 */
export class ConfigHandler implements DomainHandler {
  private readonly profileManager: ConfigProfileManager;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.profileManager = new ConfigProfileManager(deps.configStore);
  }

  /**
   * Handle an incoming bridge message.
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!CONFIG_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'config:export':
        this.handleExport(msg);
        return true;
      case 'config:import':
        this.handleImport(msg);
        return true;
      case 'config:categories':
        this.handleCategories(msg);
        return true;
      case 'config:validate':
        this.handleValidate(msg);
        return true;
      default:
        return false;
    }
  }

  private handleExport(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { categories: ConfigCategory[] } }).payload;

    try {
      const result = this.profileManager.exportProfile(payload.categories);

      const response = buildResponse(this.deps, msg, 'config:export:response', {
        success: result.success,
        json: result.json,
        categoriesExported: result.categoriesExported,
        entriesExported: result.entriesExported,
        error: result.error,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] config:export:response (${result.entriesExported} entries)`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'config:export', 'config:export:response', err);
    }
  }

  private handleImport(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { json: string; overwrite: boolean } })
      .payload;

    try {
      const result = this.profileManager.importProfile(payload.json, payload.overwrite);

      const response = buildResponse(this.deps, msg, 'config:import:response', {
        success: result.success,
        categoriesImported: result.categoriesImported,
        entriesImported: result.entriesImported,
        warnings: result.warnings,
        error: result.error,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] config:import:response (${result.entriesImported} entries)`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'config:import', 'config:import:response', err);
    }
  }

  private handleCategories(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    try {
      const categories = this.profileManager.listCategories();

      const response = buildResponse(this.deps, msg, 'config:categories:response', {
        categories,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] config:categories:response`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'config:categories', 'config:categories:response', err);
    }
  }

  private handleValidate(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { json: string } }).payload;

    try {
      const result = this.profileManager.validateProfile(payload.json);

      const response = buildResponse(this.deps, msg, 'config:validate:response', {
        valid: result.valid,
        categories: result.categories,
        error: result.error,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] config:validate:response`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'config:validate', 'config:validate:response', err);
    }
  }
}
