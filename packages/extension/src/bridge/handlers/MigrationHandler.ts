import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MigrationSaveSyncConfigResponse, SyncConfig } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  migrationImportSfdmuPayloadSchema,
  migrationSaveSyncConfigPayloadSchema,
  syncCannotCopy,
  syncConfigPayloadSchema,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';

/** File reader interface for migration services. */
export interface MigrationFileReader {
  readFile(filePath: string): Promise<string>;
  /** File size in bytes — checked against {@link MAX_IMPORT_FILE_SIZE_BYTES} before any read. */
  statSize(filePath: string): Promise<number>;
  /**
   * Browse… on the Migration page: the window's open dialog, for an SFDMU
   * export.json. The path picked, or undefined when the dialog was closed.
   * Absent, Browse is refused: there is no window to ask in.
   */
  pickExportFile?(): Promise<string | undefined>;
}

/**
 * Hard cap on import file size. The whole file is loaded into a single
 * string in the extension host — a giant CSV could OOM it.
 */
export const MAX_IMPORT_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Message types handled by MigrationHandler. */
const MIGRATION_TYPES = new Set([
  'migration:pick-file',
  'migration:import-sfdmu',
  'migration:save-sync-config',
]);

/** How a configuration saved from the Migration page is described among Sync's. */
const SAVED_FROM_MIGRATION = 'Saved from the SandForge Migration page';

/**
 * The file extension the importer takes: SfdmuImporter accepts an SFDMU
 * `export.json` definition alone. A CSV of records goes to Seed's CSV Upload,
 * which loads its rows: the page's "CSV or JSON file" read a data file's
 * column names, dropped its rows and named the object after the file.
 */
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
    // NTFS is case-insensitive: under win32 a webview path whose casing
    // differs from the base dir (e.g. `c:\users\...` vs `C:\Users\...`) must
    // still be recognized as contained. The returned path keeps its original
    // casing so the subsequent read still works.
    if (process.platform === 'win32') {
      const normalizedLower = normalized.toLowerCase();
      const baseLower = resolvedBase.toLowerCase();
      return normalizedLower === baseLower || normalizedLower.startsWith(baseLower + path.sep);
    }
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
 * Reject an import file past {@link MAX_IMPORT_FILE_SIZE_BYTES} before it is
 * read into memory — validateImportPath constrains the *location*, not the
 * size, and a giant CSV loaded as one string can OOM the extension host.
 */
async function assertImportFileSize(
  fileReader: MigrationFileReader,
  filePath: string,
): Promise<void> {
  const size = await fileReader.statSize(filePath);
  if (size > MAX_IMPORT_FILE_SIZE_BYTES) {
    const actualMb = (size / (1024 * 1024)).toFixed(1);
    const limitMb = MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024);
    throw new Error(
      `Import file is too large: ${actualMb} MB exceeds the ${limitMb} MB limit. Split the file into smaller chunks and retry.`,
    );
  }
}

/**
 * Domain handler for migration import-related webview-to-extension messages.
 *
 * Routes migration:* message types: the open dialog of Browse…, the SFDMU
 * importer that converts an export.json, and the save among Sync's
 * configurations. Every incoming file path is validated against traversal
 * before any read.
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
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!MIGRATION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'migration:pick-file':
        await this.handlePickFile(msg);
        return true;
      case 'migration:import-sfdmu':
        await this.handleImportSfdmu(msg);
        return true;
      case 'migration:save-sync-config':
        this.handleSaveSyncConfig(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Save the migration on screen as a Sync configuration.
   *
   * The page could run an imported migration once and keep nothing: a
   * schedule runs a saved Sync configuration by id, and none came out of an
   * import. Saved here into the store Sync keeps its own in, it is listed on
   * the Sync page and a schedule can run it. It is refused, by a code the
   * page words, when it has no name, a name another saved configuration has,
   * or an object Sync does not copy, and it is checked with the schema
   * `sync:config:save` checks with: a configuration Sync could not run is not
   * saved.
   */
  private handleSaveSyncConfig(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      migrationSaveSyncConfigPayloadSchema,
      msg,
      'migration:error',
      this.deps,
    );
    if (!parsed) return;
    const answer = (payload: MigrationSaveSyncConfigResponse['payload']): void => {
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'migration:save-sync-config:response', payload),
      );
    };
    try {
      const name = parsed.name.trim();
      if (name === '') {
        answer({ success: false, code: 'NAME_REQUIRED' });
        return;
      }
      const store = new SyncConfigStore(this.deps.configStore);
      const taken = store
        .list()
        .some((saved) => saved.name.trim().toLowerCase() === name.toLowerCase());
      if (taken) {
        answer({ success: false, code: 'DUPLICATE_NAME' });
        return;
      }
      // Named apart, all of them, rather than by the schema's first issue:
      // the page says which objects to leave out.
      const objects = Array.isArray(parsed.config.objects) ? parsed.config.objects : [];
      const uncopied = objects
        .map((object: unknown) =>
          typeof object === 'object' && object !== null
            ? (object as { objectApiName?: unknown }).objectApiName
            : undefined,
        )
        .filter((objectApiName): objectApiName is string => typeof objectApiName === 'string')
        .filter((objectApiName) => syncCannotCopy(objectApiName));
      if (uncopied.length > 0) {
        answer({ success: false, code: 'SYNC_CANNOT_COPY', objects: uncopied });
        return;
      }
      const now = new Date().toISOString();
      const checked = syncConfigPayloadSchema.safeParse({
        ...parsed.config,
        id: randomUUID(),
        name,
        description: SAVED_FROM_MIGRATION,
        createdAt: now,
        updatedAt: now,
      });
      if (!checked.success) {
        const [issue] = checked.error.issues;
        answer({
          success: false,
          code: 'INVALID_CONFIG',
          reason: issue ? `${issue.path.join('.')}: ${issue.message}` : checked.error.message,
        });
        return;
      }
      const config = checked.data as unknown as SyncConfig;
      store.save(config);
      this.deps.log(`[TX] migration:save-sync-config:response saved ${config.id}`);
      answer({ success: true, id: config.id, name: config.name });
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'migration:save-sync-config', 'migration:error', msg, err);
    }
  }

  /** Compute the directories an import path is allowed to live in. */
  private getAllowedBaseDirs(): string[] {
    const workspaceFolders = this.deps.services?.getWorkspaceFolders?.() ?? [];
    return [...workspaceFolders, os.homedir()];
  }

  /**
   * Browse…: the window's open dialog, and the file picked, which the page
   * puts in its File path. The page had a field to type an absolute path in
   * and nothing else. The path is not trusted for being picked here: the
   * import checks it as it checks a typed one.
   */
  private async handlePickFile(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const fileReader = this.fileReader;
      if (!fileReader?.pickExportFile) {
        throw new Error('Migration services not available.');
      }
      const filePath = await fileReader.pickExportFile();
      this.deps.broker.postToWebview(
        buildResponse(
          this.deps,
          msg,
          'migration:pick-file:response',
          filePath === undefined ? {} : { filePath },
        ),
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'migration:pick-file', 'migration:error', msg, err);
    }
  }

  private async handleImportSfdmu(msg: InboundRequest): Promise<void> {
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
      const fileReader = this.fileReader;
      if (!fileReader) {
        throw new Error('Migration services not available.');
      }
      const safePath = validateImportPath(
        filePath,
        SFDMU_IMPORT_EXTENSIONS,
        this.getAllowedBaseDirs(),
      );
      await assertImportFileSize(fileReader, safePath);
      const { SfdmuImporter } = await import('../../modules/migration/SfdmuImporter.js');
      const importer = new SfdmuImporter(fileReader);
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
