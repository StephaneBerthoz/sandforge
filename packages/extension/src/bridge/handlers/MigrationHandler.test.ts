import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
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

  it('takes no CSV or JSON data file any more: the universal import is not one of its channels', async () => {
    // It read a data file's column names, dropped its rows and named the
    // object after the file; Seed's CSV Upload loads the rows.
    expect(
      await handler.handle(createMsg('migration:import', { filePath: '/home/u/accounts.csv' })),
    ).toBe(false);
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
  });

  describe('Browse…', () => {
    function readerPicking(pick: () => Promise<string | undefined>) {
      return { readFile: vi.fn(), statSize: vi.fn(), pickExportFile: vi.fn(pick) };
    }

    function answer(): { type: string; correlationId?: string; payload: Record<string, unknown> } {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    it('answers with the file the window’s dialog picked, for the page’s File path', async () => {
      const reader = readerPicking(async () => '/home/u/sfdmu/export.json');
      handler.setFileReader(reader);

      expect(await handler.handle(createMsg('migration:pick-file'))).toBe(true);

      expect(reader.pickExportFile).toHaveBeenCalledTimes(1);
      expect(reader.readFile).not.toHaveBeenCalled();
      expect(answer()).toMatchObject({
        type: 'migration:pick-file:response',
        correlationId: 'req-77',
        payload: { filePath: '/home/u/sfdmu/export.json' },
      });
    });

    it('answers with no path when the dialog was closed', async () => {
      handler.setFileReader(readerPicking(async () => undefined));

      await handler.handle(createMsg('migration:pick-file'));

      expect(answer()).toMatchObject({ type: 'migration:pick-file:response', payload: {} });
      expect(answer().payload).not.toHaveProperty('filePath');
    });

    it('refuses on the error channel, in the dialog’s words, a file it cannot read', async () => {
      handler.setFileReader(
        readerPicking(async () => {
          throw new Error('pick a file there');
        }),
      );

      await handler.handle(createMsg('migration:pick-file'));

      expect(answer()).toMatchObject({
        type: 'migration:error',
        correlationId: 'req-77',
        payload: { message: expect.stringContaining('pick a file there') },
      });
    });

    it('refuses on the error channel when there is no window to ask in', async () => {
      handler.setFileReader({ readFile: vi.fn(), statSize: vi.fn() });

      await handler.handle(createMsg('migration:pick-file'));

      expect(answer()).toMatchObject({
        type: 'migration:error',
        payload: { message: expect.stringContaining('Migration services not available') },
      });
    });
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
      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

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

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('workspace folder or your home directory');
    });

    it.each([
      ['.txt', path.join(os.homedir(), 'export.txt')],
      ['.exe', path.join(os.homedir(), 'export.exe')],
      ['no extension', path.join(os.homedir(), 'export')],
    ])('rejects unsupported extension (%s)', async (_label, filePath) => {
      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

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

      await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

      const response = lastResponse();
      expect(response.payload.error).toContain('READ_ATTEMPTED');
    });

    it('rejects a non-string filePath with INVALID_PAYLOAD before any read', async () => {
      await handler.handle(createMsg('migration:import-sfdmu', { filePath: 42 }));

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

        await handler.handle(createMsg('migration:import-sfdmu', { filePath }));

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

    it('rejects a file past the 50 MB cap before reading it', async () => {
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
      expect(response.payload.error).toContain('50 MB');
      // The content is never loaded into memory.
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('from a real export.json to the configuration Sync reads', () => {
    const published = (name: string): string =>
      path.join(__dirname, '../../modules/migration/fixtures/published', name, 'export.json');

    let store: ConfigStore;

    beforeEach(() => {
      store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      deps.services = {
        getWorkspaceFolders: () => [path.join(__dirname, '../../modules/migration/fixtures')],
      } as unknown as NonNullable<HandlerDeps['services']>;
      // The disk's own calls, as the extension wires them: a file that is not there is ENOENT.
      handler.setFileReader({
        readFile: (filePath) => readFile(filePath, 'utf8'),
        statSize: async (filePath) => (await stat(filePath)).size,
      });
    });

    /** The last answer the handler posted, of the message just handled. */
    const lastAnswer = () =>
      (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.lastCall?.[0];

    async function importAndSave(name: string, edit = (config: Record<string, unknown>) => config) {
      await handler.handle(createMsg('migration:import-sfdmu', { filePath: published(name) }));
      const imported = lastAnswer();
      expect(imported.payload.success).toBe(true);
      await handler.handle(
        createMsg('migration:save-sync-config', {
          name: `From ${name}`,
          config: {
            ...edit(imported.payload.config),
            sourceOrgId: 'org-source',
            targetOrgId: 'org-target',
          },
        }),
      );
      return imported.payload;
    }

    it('imports SFDMU’s published example, saves it, and Sync reads it with its filter', async () => {
      const imported = await importAndSave('simple');

      expect(lastAnswer().payload).toMatchObject({ success: true, name: 'From simple' });
      const [saved] = new SyncConfigStore(store).list();
      expect(saved.objects).toMatchObject([
        { objectApiName: 'Contact', operation: 'upsert', externalIdField: 'LastName' },
        { objectApiName: 'Account', operation: 'upsert', where: "Name = 'John Smith'" },
      ]);
      // What a run of it, or a schedule, is checked with.
      expect(syncConfigPayloadSchema.safeParse(saved).success).toBe(true);
      expect(imported.notes).toContainEqual({ code: 'notMaster', object: 'Contact' });
    });

    it('lists it where the Sync page offers its saved configurations', async () => {
      await importAndSave('lookups');

      await new SyncOpsHandler(deps).handle(
        inboundRequest({ id: 'req-list', type: 'sync:config:list', timestamp: Date.now() }),
      );

      expect(lastAnswer()).toMatchObject({
        type: 'sync:config:list:response',
        payload: { configs: [expect.objectContaining({ name: 'From lookups', mode: 'full' })] },
      });
      expect(new SyncConfigStore(store).list()[0].objects).toHaveLength(4);
    });

    it('reads the mapping file beside the export through to the saved configuration', async () => {
      await importAndSave('field-mapping-csv');

      const [saved] = new SyncConfigStore(store).list();
      expect(saved.objects[0].fieldMappings).toEqual([
        { sourceField: 'ParentId', targetField: 'ParentTestObject__c', type: 'rename' },
        { sourceField: 'ExternalID__c', targetField: 'External_ID__c', type: 'rename' },
      ]);
    });

    it('leaves a composite key for the row to name: the save asks for none of Sync’s refusals', async () => {
      // Carried, `Language__r.LangCode__c;…` would have been refused at the save
      // for an insert that needs no key: "Invalid Salesforce API name".
      await importAndSave('sfdmu-test-suite', (config) => ({
        ...config,
        objects: (config.objects as Array<Record<string, unknown>>).map((object) =>
          object.operation === 'upsert' ? { ...object, externalIdField: 'Legacy_Key__c' } : object,
        ),
      }));

      expect(lastAnswer().payload).toMatchObject({ success: true });
      expect(new SyncConfigStore(store).list()[0].objects).toHaveLength(8);
    });

    it('holds a mapping file beside the export to the size an import takes', async () => {
      handler.setFileReader({
        readFile: (filePath) => readFile(filePath, 'utf8'),
        statSize: async (filePath) =>
          filePath.endsWith('.csv') ? 60 * 1024 * 1024 : (await stat(filePath)).size,
      });

      await handler.handle(
        createMsg('migration:import-sfdmu', { filePath: published('field-mapping-csv') }),
      );

      expect(lastAnswer().payload).toMatchObject({
        success: false,
        error: expect.stringContaining('too large'),
      });
    });
  });

  describe('a file that is no export', () => {
    it.each([
      ['NOT_JSON', 'not json', []],
      ['NO_OBJECTS', '{}', []],
      ['OBJECT_NOT_NAMED', '{"objects":[{"query":"SELECT Id"}]}', ['objects[0] (SELECT Id)']],
      ['INVALID_EXPORT', '{"objects":[{"query":1}]}', ['objects[0].query']],
    ])('answers %s, by a code the page words', async (code, content, objects) => {
      handler.setFileReader({
        readFile: vi.fn().mockResolvedValue(content),
        statSize: vi.fn().mockResolvedValue(100),
      });

      await handler.handle(
        createMsg('migration:import-sfdmu', { filePath: path.join(os.homedir(), 'export.json') }),
      );

      const [[response]] = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls as [
        [{ payload: Record<string, unknown> }],
      ];
      expect(response.payload).toEqual({
        success: false,
        code,
        objects,
        error: expect.stringMatching(/^Nothing was imported: /),
      });
    });
  });

  describe('an export that sends an object to another', () => {
    it('imports nothing of it, and says which by a code the page words', async () => {
      handler.setFileReader({
        readFile: vi.fn().mockResolvedValue(
          JSON.stringify({
            objects: [
              {
                query: 'SELECT Id, Name FROM Account',
                operation: 'Upsert',
                externalId: 'Name',
                objectName: 'Account',
                useFieldMapping: true,
                fieldMapping: [
                  { targetObject: 'Lead' },
                  { sourceField: 'Name', targetField: 'Company' },
                ],
              },
            ],
          }),
        ),
        statSize: vi.fn().mockResolvedValue(100),
      });

      await handler.handle(
        createMsg('migration:import-sfdmu', { filePath: path.join(os.homedir(), 'export.json') }),
      );

      const [[response]] = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls as [
        [{ type: string; payload: unknown }],
      ];
      expect(response.type).toBe('migration:import-sfdmu:response');
      expect(response.payload).toEqual({
        success: false,
        code: 'TARGET_OBJECT_MAPPED',
        objects: ['Account → Lead (Name → Company)'],
        error: expect.stringContaining('Account → Lead (Name → Company)'),
      });
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining('[ERR] migration:import-sfdmu: Nothing was imported'),
      );
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
      expect(response.payload.reason).toMatch(/^mode: Sync runs a full or a delta sync only/);
      expect(new SyncConfigStore(store).list()).toEqual([]);
    });
  });
});
