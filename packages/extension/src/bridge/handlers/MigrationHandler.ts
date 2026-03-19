import type { BaseMessage, MigrationImportRequest, MigrationImportSfdmuRequest } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** File reader interface for migration services. */
export interface MigrationFileReader {
  readFile(filePath: string): Promise<string>;
}

/** Message types handled by MigrationHandler. */
const MIGRATION_TYPES = new Set([
  'migration:import',
  'migration:import-sfdmu',
]);

/**
 * Domain handler for migration import-related webview-to-extension messages.
 *
 * Routes migration:* message types to universal and SFDMU-specific
 * config importers for converting external migration definitions.
 */
export class MigrationHandler implements DomainHandler {
  private fileReader?: MigrationFileReader;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject migration file reader service. */
  setFileReader(fileReader: MigrationFileReader): void {
    this.fileReader = fileReader;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!MIGRATION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'migration:import':
        await this.handleImport(msg);
        return true;
      case 'migration:import-sfdmu':
        await this.handleImportSfdmu(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleImport(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { filePath } = (msg as MigrationImportRequest).payload;
    try {
      if (!this.fileReader) {
        throw new Error('Migration services not available.');
      }
      const { UniversalImporter } = await import('../../modules/migration/UniversalImporter.js');
      const importer = new UniversalImporter(this.fileReader);
      const config = await importer.import(filePath);
      const content = await this.fileReader.readFile(filePath);
      const detectedFormat = importer.detectFormat(content, filePath);
      const response = buildResponse(this.deps, msg, 'migration:import:response', {
        success: true, config: config as unknown as Record<string, unknown>, detectedFormat,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] migration:import: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'migration:import:response', {
        success: false, error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleImportSfdmu(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { filePath } = (msg as MigrationImportSfdmuRequest).payload;
    try {
      if (!this.fileReader) {
        throw new Error('Migration services not available.');
      }
      const { SfdmuImporter } = await import('../../modules/migration/SfdmuImporter.js');
      const importer = new SfdmuImporter(this.fileReader);
      const config = await importer.import(filePath);
      const response = buildResponse(this.deps, msg, 'migration:import-sfdmu:response', {
        success: true, config: config as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] migration:import-sfdmu: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'migration:import-sfdmu:response', {
        success: false, error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
