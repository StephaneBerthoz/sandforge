import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { MigrationHandler } from './MigrationHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';
import type { InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import { syncConfigPayloadSchema } from '../validatePayload.js';
import { SyncOpsHandler } from './SyncOpsHandler.js';

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {} as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): InboundRequest & { payload: Record<string, unknown> } {
  return inboundRequest({ id: 'req-77', type, timestamp: Date.now(), payload });
}

describe('MigrationHandler', () => {
  let handler: MigrationHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new MigrationHandler(deps);
  });

  it('returns false for unknown message types', async () => {
    expect(await handler.handle(createMsg('unknown:type'))).toBe(false);
  });

  it('handles migration:import error when no file reader with correlationId', async () => {
    const result = await handler.handle(
      createMsg('migration:import', { filePath: '/tmp/config.json' }),
    );
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('migration:import:response');
    expect(response.correlationId).toBe('req-77');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('Migration services not available');
  });

  it('handles migration:import-sfdmu error when no file reader with correlationId', async () => {
    const result = await handler.handle(
      createMsg('migration:import-sfdmu', { filePath: '/tmp/export.json' }),
    );
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('migration:import-sfdmu:response');
    expect(response.correlationId).toBe('req-77');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('Migration services not available');
  });

  describe('path traversal validation', () => {
    const workspaceDir = path.join(path.parse(process.cwd()).root, 'ws-root');

    beforeEach(() => {
      // A file reader is wired so validation (not the missing-service error)
      // is what decides the outcome. The read itself fails with a distinctive
      // marker so tests can prove the read was attempted (i.e. path accepted).
      handler.setFileReader({
        readFile: vi.fn().mockRejectedValue(new Error('READ_ATTEMPTED')),
        statSize: vi.fn().mockResolvedValue(10),
      });
      deps.services = {
        getWorkspaceFolders: () => [workspaceDir],
      } as unknown as NonNullable<HandlerDeps['services']>;
    });

    function lastResponse(): {
      type: string;
      payload: { success: boolean; error?: string };
    } {
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1][0] as {
        type: string;
        payload: { success: boolean; error?: string };
      };
    }

    it.each([
      ['relative path', 'config/export.json'],
      ['dot-relative path', './export.json'],
    ])('rejects %s before any read', async (_label, filePath) => {
      await handler.handle(createMsg('migration:import', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('not absolute');
    });

    it('rejects traversal escaping the home directory', async () => {
      const filePath = path.join(os.homedir(), '..', 'escaped-export.json');

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('Invalid import path');
    });

    it('rejects an absolute path outside workspace folders and home', async () => {
      const root = path.parse(process.cwd()).root;
      const filePath = path.join(root, 'sandforge-e2e-not-allowed', 'export.json');

      await handler.handle(createMsg('migration:import', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('workspace folder or your home directory');
    });

    it.each([
      ['.txt', path.join(os.homedir(), 'export.txt')],
      ['.exe', path.join(os.homedir(), 'export.exe')],
      ['no extension', path.join(os.homedir(), 'export')],
    ])('rejects unsupported extension (%s)', async (_label, filePath) => {
      await handler.handle(createMsg('migration:import', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('not a supported extension');
    });

    it('rejects a .csv path for the SFDMU importer (json only)', async () => {
      const filePath = path.join(os.homedir(), 'export.csv');

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('not a supported extension');
    });

    it('accepts a path inside the home directory and attempts the read', async () => {
      const filePath = path.join(os.homedir(), 'imports', 'export.json');

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      // READ_ATTEMPTED proves validation passed and the file read was tried.
      expect(response.payload.error).toContain('READ_ATTEMPTED');
    });

    it('accepts a path inside an open workspace folder', async () => {
      const filePath = path.join(workspaceDir, 'migration', 'export.json');

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.error).toContain('READ_ATTEMPTED');
    });

    it('normalizes inner .. segments that stay inside the allowed base', async () => {
      const filePath = path.join(os.homedir(), 'imports', '..', 'imports', 'export.json');

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.error).toContain('READ_ATTEMPTED');
    });

    it('accepts an uppercase .JSON extension (case-insensitive)', async () => {
      const filePath = path.join(os.homedir(), 'export.JSON');

      await handler.handle(createMsg('migration:import', { filePath }));

      const response = lastResponse();
      expect(response.payload.error).toContain('READ_ATTEMPTED');
    });

    it('rejects a non-string filePath with INVALID_PAYLOAD before any read', async () => {
      await handler.handle(createMsg('migration:import', { filePath: 42 }));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('migration:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects migration:import-sfdmu without filePath (INVALID_PAYLOAD)', async () => {
      await handler.handle(createMsg('migration:import-sfdmu', {}));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('migration:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it.runIf(process.platform === 'win32')(
      'accepts a path whose casing differs from the allowed base dir (win32)',
      async () => {
        // NTFS is case-insensitive: `c:\ws-root\...` IS inside `C:\WS-ROOT`.
        const upperBase = path.join(path.parse(process.cwd()).root, 'WS-CASE-ROOT');
        deps.services = {
          getWorkspaceFolders: () => [upperBase],
        } as unknown as NonNullable<HandlerDeps['services']>;
        const filePath = path.join(upperBase.toLowerCase(), 'migration', 'export.json');

        await handler.handle(createMsg('migration:import', { filePath }));

        const response = lastResponse();
        // READ_ATTEMPTED proves the containment check accepted the path.
        expect(response.payload.error).toContain('READ_ATTEMPTED');
      },
    );
  });

  describe('file size cap', () => {
    beforeEach(() => {
      deps.services = {
        getWorkspaceFolders: () => [],
      } as unknown as NonNullable<HandlerDeps['services']>;
    });

    function lastResponse(): {
      type: string;
      payload: { success: boolean; error?: string };
    } {
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1][0] as {
        type: string;
        payload: { success: boolean; error?: string };
      };
    }

    it('rejects a file past the 50 MB cap before reading it (migration:import)', async () => {
      const readFile = vi.fn();
      handler.setFileReader({
        readFile,
        statSize: vi.fn().mockResolvedValue(51 * 1024 * 1024),
      });
      const filePath = path.join(os.homedir(), 'huge.csv');

      await handler.handle(createMsg('migration:import', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('too large');
      expect(response.payload.error).toContain('50 MB');
      // The content is never loaded into memory.
      expect(readFile).not.toHaveBeenCalled();
    });

    it('rejects a file past the 50 MB cap (migration:import-sfdmu)', async () => {
      const readFile = vi.fn();
      handler.setFileReader({
        readFile,
        statSize: vi.fn().mockResolvedValue(60 * 1024 * 1024),
      });
      const filePath = path.join(os.homedir(), 'export.json');

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('too large');
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('single disk read', () => {
    it('reads the file exactly once for import + format detection', async () => {
      deps.services = {
        getWorkspaceFolders: () => [],
      } as unknown as NonNullable<HandlerDeps['services']>;
      const content = JSON.stringify([{ Name: 'Acme', Industry: 'Tech' }]);
      const readFile = vi.fn().mockResolvedValue(content);
      handler.setFileReader({
        readFile,
        statSize: vi.fn().mockResolvedValue(content.length),
      });
      const filePath = path.join(os.homedir(), 'accounts.json');

      await handler.handle(createMsg('migration:import', { filePath }));

      expect(readFile).toHaveBeenCalledTimes(1);
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      const response = calls[calls.length - 1][0] as {
        type: string;
        payload: { success: boolean; detectedFormat?: string; error?: string };
      };
      expect(response.payload.success).toBe(true);
      expect(response.payload.detectedFormat).toBe('json');
    });
  });

  describe('migration:save-sync-config', () => {
    /** A migration as the page sends it: the import as edited, with the orgs picked. */
    function migration(objects: Array<Record<string, unknown>> = []): Record<string, unknown> {
      return {
        id: 'import-placeholder',
        name: 'export.json',
        description: '',
        sourceOrgId: 'org-source',
        targetOrgId: 'org-target',
        direction: 'source_to_target',
        mode: 'full',
        objects:
          objects.length > 0
            ? objects
            : [
                {
                  objectApiName: 'Account',
                  operation: 'upsert',
                  externalIdField: 'External_Id__c',
                  fieldMappings: [],
                  transformRules: [],
                  excludedFields: ['CreatedDate'],
                  addOnFields: [],
                  batchSize: 200,
                  insertOrder: 1,
                },
              ],
        conflictStrategy: 'source_wins',
        enableRollback: false,
      };
    }

    let store: ConfigStore;

    beforeEach(() => {
      store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
    });

    async function save(name: string, config: Record<string, unknown>) {
      await handler.handle(createMsg('migration:save-sync-config', { name, config }));
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1][0];
    }

    it('saves the migration where Sync keeps its configurations, under its name, as one Sync accepts', async () => {
      const response = await save('  Nightly accounts  ', migration());

      expect(response).toMatchObject({
        type: 'migration:save-sync-config:response',
        correlationId: 'req-77',
        payload: { success: true, name: 'Nightly accounts' },
      });
      const saved = new SyncConfigStore(store).list();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        id: response.payload.id,
        name: 'Nightly accounts',
        sourceOrgId: 'org-source',
        targetOrgId: 'org-target',
        objects: [expect.objectContaining({ objectApiName: 'Account', operation: 'upsert' })],
      });
      // Not the importer's placeholder id: a new configuration of its own.
      expect(saved[0].id).not.toBe('import-placeholder');
      // What a run of it, or a schedule, is checked with.
      expect(syncConfigPayloadSchema.safeParse(saved[0]).success).toBe(true);

      // Listed where the Sync page offers saved configurations to a schedule.
      await new SyncOpsHandler(deps).handle(
        inboundRequest({ id: 'req-list', type: 'sync:config:list', timestamp: Date.now() }),
      );
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[calls.length - 1][0]).toMatchObject({
        type: 'sync:config:list:response',
        payload: { configs: [expect.objectContaining({ name: 'Nightly accounts' })] },
      });
    });

    it('refuses a configuration with no name, and saves nothing', async () => {
      const response = await save('   ', migration());

      expect(response.payload).toEqual({ success: false, code: 'NAME_REQUIRED' });
      expect(new SyncConfigStore(store).list()).toEqual([]);
    });

    it('refuses a name another saved Sync configuration has, whatever its case', async () => {
      await save('Nightly accounts', migration());

      const response = await save('nightly ACCOUNTS', migration());

      expect(response.payload).toEqual({ success: false, code: 'DUPLICATE_NAME' });
      expect(new SyncConfigStore(store).list()).toHaveLength(1);
    });

    it('names every object Sync does not copy, and saves nothing', async () => {
      const object = (objectApiName: string) => ({
        objectApiName,
        operation: 'insert',
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
      });

      const response = await save(
        'With users',
        migration([object('Account'), object('User'), object('ContentVersion')]),
      );

      expect(response.payload).toEqual({
        success: false,
        code: 'SYNC_CANNOT_COPY',
        objects: ['User', 'ContentVersion'],
      });
      expect(new SyncConfigStore(store).list()).toEqual([]);
    });

    it('refuses what Sync’s schema refuses, with its first issue, and saves nothing', async () => {
      const response = await save('Changes only', { ...migration(), mode: 'incremental' });

      expect(response.payload).toMatchObject({ success: false, code: 'INVALID_CONFIG' });
      expect(response.payload.reason).toMatch(/^mode: Sync runs a full sync only/);
      expect(new SyncConfigStore(store).list()).toEqual([]);
    });
  });
});
