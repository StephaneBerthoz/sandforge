import * as fs from 'node:fs/promises';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  configExportPayloadSchema,
  configImportPayloadSchema,
  configValidatePayloadSchema,
} from '../validatePayload.js';
import {
  ConfigProfileManager,
  type ForgeTemplateWorkspace,
} from '../../core/config/ConfigProfileManager.js';
import { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';

/** Message types handled by ConfigHandler. */
const CONFIG_TYPES = new Set([
  'config:export',
  'config:import',
  'config:categories',
  'config:validate',
]);

/**
 * The workspace this window keeps its Forge templates in: its first folder,
 * the one Forge's own template store is built on (see `forgeComposition`).
 * VS Code restarts the extension host when the first folder changes, so it
 * holds for the life of the handler. Undefined with no folder open.
 */
function forgeTemplateWorkspace(deps: HandlerDeps): ForgeTemplateWorkspace | undefined {
  const folder = deps.services?.getWorkspaceFolders?.()[0];
  if (!folder) return undefined;
  const store = new ForgeTemplateStore({
    workspacePath: folder,
    readFile: (file) => fs.readFile(file, 'utf-8'),
    writeFile: (file, content) => fs.writeFile(file, content, 'utf-8'),
    mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
  });
  return { folder, readTemplates: () => store.list() };
}

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
    this.profileManager = new ConfigProfileManager(deps.configStore, forgeTemplateWorkspace(deps));
  }

  /**
   * Handle an incoming bridge message.
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!CONFIG_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'config:export':
        await this.handleExport(msg);
        return true;
      case 'config:import':
        await this.handleImport(msg);
        return true;
      case 'config:categories':
        await this.handleCategories(msg);
        return true;
      case 'config:validate':
        this.handleValidate(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleExport(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(configExportPayloadSchema, msg, 'config:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const result = await this.profileManager.exportProfile(payload.categories);

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
      sendHandlerError(this.deps, 'config:export', 'config:error', msg, err);
    }
  }

  private async handleImport(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(configImportPayloadSchema, msg, 'config:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const result = await this.profileManager.importProfile(payload.json, payload.overwrite);

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
      sendHandlerError(this.deps, 'config:import', 'config:error', msg, err);
    }
  }

  private async handleCategories(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    try {
      const categories = await this.profileManager.listCategories();

      const response = buildResponse(this.deps, msg, 'config:categories:response', {
        categories,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] config:categories:response`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'config:categories', 'config:error', msg, err);
    }
  }

  private handleValidate(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(configValidatePayloadSchema, msg, 'config:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

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
      sendHandlerError(this.deps, 'config:validate', 'config:error', msg, err);
    }
  }
}
