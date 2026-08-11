import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { MigrationHandler } from './MigrationHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';

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
): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'req-77', type, timestamp: Date.now(), payload };
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

    function lastResponse(): { type: string; payload: { success: boolean; error?: string } } {
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

    function lastResponse(): { type: string; payload: { success: boolean; error?: string } } {
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
      handler.setFileReader({ readFile, statSize: vi.fn().mockResolvedValue(content.length) });
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
});
