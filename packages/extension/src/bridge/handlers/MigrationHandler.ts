import * as os from 'node:os';
import * as path from 'node:path';
import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';
import {
  validatePayload,
  migrationImportPayloadSchema,
  migrationImportSfdmuPayloadSchema,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** File reader interface for migration services. */
export interface MigrationFileReader {
  readFile(filePath: string): Promise<string>;
}

/** Message types handled by MigrationHandler. */
const MIGRATION_TYPES = new Set(['migration:import', 'migration:import-sfdmu']);

/**
 * Allowed file extensions per importer. UniversalImporter sniffs JSON and CSV
 * content; SfdmuImporter only accepts an SFDMU `export.json` definition.
 */
const UNIVERSAL_IMPORT_EXTENSIONS = new Set(['.json', '.csv']);
const SFDMU_IMPORT_EXTENSIONS = new Set(['.json']);

/**
 * Validate a webview-supplied import path (path-traversal defense).
 *
 * A compromised or buggy webview could otherwise make the extension read any
 * file the user can read (`~/.ssh/id_rsa`, `C:\Windows\...`, `/etc/passwd`)
 * and exfiltrate its content through the import response. Rules:
 *   1. must be an absolute path (relative paths are resolved against an
 *      unpredictable extension-host cwd — refuse outright);
 *   2. must carry one of the importer's expected extensions;
 *   3. after normalization, must stay inside an allowed base directory:
 *      an open workspace folder or the user's home directory.
 *
 * @param filePath - Raw path from the webview payload.
 * @param allowedExtensions - Extensions accepted for this importer (lowercase, with dot).
 * @param allowedBaseDirs - Absolute base directories the path must stay inside.
 * @returns The normalized absolute path on success.
 * @throws Error with an explicit, user-displayable message on rejection.
 */
export function validateImportPath(
  filePath: string,
  allowedExtensions: ReadonlySet<string>,
  allowedBaseDirs: readonly string[],
): string {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid import path: path is empty.');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `Invalid import path: "${filePath}" is not absolute. Pick a file inside the workspace or your home directory.`,
    );
  }

  // path.resolve normalizes separators and collapses `.` / `..` segments so
  // traversal attempts are resolved *before* the containment check.
  const normalized = path.resolve(filePath);

  const extension = path.extname(normalized).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(
      `Invalid import path: "${extension || '(none)'}" is not a supported extension (expected ${[...allowedExtensions].join(', ')}).`,
    );
  }

  const insideAllowedBase = allowedBaseDirs.some((base) => {
    const resolvedBase = path.resolve(base);
    return normalized === resolvedBase || normalized.startsWith(resolvedBase + path.sep);
  });
  if (!insideAllowedBase) {
    throw new Error(
      'Invalid import path: the file must be inside an open workspace folder or your home directory.',
    );
  }

  return normalized;
}

/**
 * Domain handler for migration import-related webview-to-extension messages.
 *
 * Routes migration:* message types to universal and SFDMU-specific
 * config importers for converting external migration definitions.
 * Every incoming file path is validated against traversal before any read.
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

  /** Compute the directories an import path is allowed to live in. */
  private getAllowedBaseDirs(): string[] {
    const workspaceFolders = this.deps.services?.getWorkspaceFolders?.() ?? [];
    return [...workspaceFolders, os.homedir()];
  }

  private async handleImport(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(migrationImportPayloadSchema, msg, 'migration:error', this.deps);
    if (!parsed) return;
    const { filePath } = parsed;
    try {
      if (!this.fileReader) {
        throw new Error('Migration services not available.');
      }
      const safePath = validateImportPath(
        filePath,
        UNIVERSAL_IMPORT_EXTENSIONS,
        this.getAllowedBaseDirs(),
      );
      const { UniversalImporter } = await import('../../modules/migration/UniversalImporter.js');
      const importer = new UniversalImporter(this.fileReader);
      const config = await importer.import(safePath);
      const content = await this.fileReader.readFile(safePath);
      const detectedFormat = importer.detectFormat(content, safePath);
      const response = buildResponse(this.deps, msg, 'migration:import:response', {
        success: true,
        config: config as unknown as Record<string, unknown>,
        detectedFormat,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] migration:import: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'migration:import:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleImportSfdmu(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      migrationImportSfdmuPayloadSchema,
      msg,
      'migration:error',
      this.deps,
    );
    if (!parsed) return;
    const { filePath } = parsed;
    try {
      if (!this.fileReader) {
        throw new Error('Migration services not available.');
      }
      const safePath = validateImportPath(
        filePath,
        SFDMU_IMPORT_EXTENSIONS,
        this.getAllowedBaseDirs(),
      );
      const { SfdmuImporter } = await import('../../modules/migration/SfdmuImporter.js');
      const importer = new SfdmuImporter(this.fileReader);
      const config = await importer.import(safePath);
      const response = buildResponse(this.deps, msg, 'migration:import-sfdmu:response', {
        success: true,
        config: config as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] migration:import-sfdmu: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'migration:import-sfdmu:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
