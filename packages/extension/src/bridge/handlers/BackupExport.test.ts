import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import type { SaveDialogHost } from '../../adapters/fs/SaveDialogAdapter.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { inboundRequest } from '../../test/mockFactories.js';

/**
 * A backup must be able to leave the machine.
 *
 * dataops:backup writes every object's record array into ConfigStore, which is
 * backed by VSCode globalState. There was no export channel of any kind, so a
 * backup existed only inside one editor installation: not archivable, not
 * transferable, not inspectable outside the extension.
 *
 * The export then built the whole document and posted it to the page in one
 * message, which saved it as one file: every record of every object, up to a
 * million rows per object, held at once on both sides of the bridge. The host
 * now writes it, a batch at a time, to a file the user picks.
 */

function createDeps(): HandlerDeps & { posted: Record<string, unknown>[] } {
  const values = new Map<string, unknown>();
  const posted: Record<string, unknown>[] = [];
  return {
    log: vi.fn(),
    broker: {
      postToWebview: (m: Record<string, unknown>) => posted.push(m),
    } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key: string, value: unknown) => values.set(key, value),
      getKeysByPrefix: (prefix: string) =>
        Array.from(values.keys()).filter((k) => k.startsWith(prefix)),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: () => 'gen',
    posted,
  } as HandlerDeps & { posted: Record<string, unknown>[] };
}

/** Backup files kept in memory, and the store over them. */
function memoryStore() {
  const files = new Map<string, string>();
  const store = new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    appendFile: async (p, content) => {
      files.set(p, (files.get(p) ?? '') + content);
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      yield* (files.get(p) ?? '').split('\n');
    },
    mkdir: async () => undefined,
    rm: async (p) => {
      files.delete(p);
    },
    listFiles: async () => [],
  });
  return { files, store };
}

/**
 * A Save dialog that answers `picked`, and the file it opens there: every
 * piece written to it, in order, and whether it was closed whole or abandoned.
 */
function dialog(picked: string | undefined) {
  const writes: string[] = [];
  const file = {
    write: vi.fn(async (text: string) => {
      writes.push(text);
    }),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const host = {
    showSaveDialog: vi.fn(async () => (picked === undefined ? undefined : { fsPath: picked })),
    writeFile: vi.fn(async () => undefined),
    fileUri: (fsPath: string) => ({ fsPath }) as vscode.Uri,
    openFile: vi.fn(async () => file),
  } as unknown as SaveDialogHost & {
    showSaveDialog: ReturnType<typeof vi.fn>;
    openFile: ReturnType<typeof vi.fn>;
  };
  return { adapter: new SaveDialogAdapter(host), host, file, writes };
}

function msg(type: string, payload: Record<string, unknown>): InboundRequest {
  return inboundRequest({
    id: 'req-1',
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** `count` contacts, as a backup holds them. */
function contactsOf(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `003-${i + 1}`,
    Name: `Contact ${i + 1}`,
  }));
}

/** How many records one piece written holds: one to a line, each line opening an object. */
function recordsIn(piece: string): number {
  return piece.split('\n      {').length - 1;
}

describe('backup:export', () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
    // What dataops:backup keeps: a meta record, each object's records in its
    // file — or, for a backup taken before the files, in the config store.
    deps.configStore.set('backup:op-1', {
      orgId: 'org-1',
      timestamp: '2026-01-01T00:00:00Z',
      totalRecords: 452,
      objects: [
        { objectApiName: 'Contact', recordCount: 450 },
        { objectApiName: 'Account', recordCount: 2 },
        { objectApiName: 'Lead', recordCount: 0 },
      ],
    });
    deps.configStore.set('backup:op-1:Account', [{ Id: '001a' }, { Id: '001b' }]);
  });

  it('writes a backup larger than a batch to the file picked, a batch at a time, and tells the page where and how many', async () => {
    const { files, store } = memoryStore();
    await store.begin('op-1', 'Contact');
    await store.append('op-1', 'Contact', contactsOf(450));
    const { adapter, host, file, writes } = dialog('/home/u/backup.json');
    const handler = new DataOpsHandler(deps, adapter);
    handler.setBackupRecordStore(store);

    await handler.handle(msg('backup:export', { orgId: 'org-1', operationId: 'op-1' }));

    expect(host.showSaveDialog.mock.calls[0][0].defaultUri.fsPath).toBe(
      'sandforge-backup-op-1.json',
    );
    // Never more than one batch of the backup handed over at once.
    expect(writes.map(recordsIn).filter((n) => n > 0)).toEqual([200, 200, 50, 2]);
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(file.abort).not.toHaveBeenCalled();
    // The document the page used to save, whole.
    expect(JSON.parse(writes.join(''))).toEqual({
      sandforgeBackupVersion: 1,
      operationId: 'op-1',
      orgId: 'org-1',
      timestamp: '2026-01-01T00:00:00Z',
      totalRecords: 452,
      objects: {
        Contact: contactsOf(450),
        Account: [{ Id: '001a' }, { Id: '001b' }],
        Lead: [],
      },
    });
    expect(files.size).toBe(1);

    // The page hears where the file went and what it holds — no record.
    const result = deps.posted.find((m) => m.type === 'backup:export:result');
    expect(result?.payload).toEqual({
      operationId: 'op-1',
      status: 'saved',
      path: '/home/u/backup.json',
      objects: [
        { objectApiName: 'Contact', records: 450 },
        { objectApiName: 'Account', records: 2 },
        { objectApiName: 'Lead', records: 0 },
      ],
    });
    expect(JSON.stringify(deps.posted)).not.toContain('003-1');
  });

  it('writes nothing, and reads nothing, when the dialog is dismissed', async () => {
    const { store } = memoryStore();
    const batches = vi.spyOn(store, 'batches');
    const { adapter, host, file } = dialog(undefined);
    const handler = new DataOpsHandler(deps, adapter);
    handler.setBackupRecordStore(store);

    await handler.handle(msg('backup:export', { orgId: 'org-1', operationId: 'op-1' }));

    expect(host.openFile).not.toHaveBeenCalled();
    expect(file.write).not.toHaveBeenCalled();
    expect(batches).not.toHaveBeenCalled();
    const result = deps.posted.find((m) => m.type === 'backup:export:result');
    expect(result?.payload).toEqual({ operationId: 'op-1', status: 'cancelled' });
    expect(deps.posted.some((m) => m.type === 'dataops:error')).toBe(false);
  });

  it('leaves nothing at the place picked, and says why, when the backup cannot be read whole', async () => {
    const { files, store } = memoryStore();
    files.set(
      path.join('/storage', 'backups', 'op-1__Contact.ndjson'),
      '{"Id":"003-1"}\n{"Id":"003-2"\n',
    );
    const { adapter, file } = dialog('/home/u/backup.json');
    const handler = new DataOpsHandler(deps, adapter);
    handler.setBackupRecordStore(store);

    await handler.handle(msg('backup:export', { orgId: 'org-1', operationId: 'op-1' }));

    expect(file.abort).toHaveBeenCalledTimes(1);
    expect(file.close).not.toHaveBeenCalled();
    expect(deps.posted.some((m) => m.type === 'backup:export:result')).toBe(false);
    const error = deps.posted.find((m) => m.type === 'dataops:error') as
      { payload: { message: string } } | undefined;
    expect(error?.payload.message).toContain(
      'The backup of Contact is damaged at line 2 of its file',
    );
  });

  it('refuses to export a backup belonging to another org, before any dialog', async () => {
    const { adapter, host } = dialog('/home/u/backup.json');

    await new DataOpsHandler(deps, adapter).handle(
      msg('backup:export', { orgId: 'org-OTHER', operationId: 'op-1' }),
    );

    expect(host.showSaveDialog).not.toHaveBeenCalled();
    expect(deps.posted.some((m) => m.type === 'backup:export:result')).toBe(false);
    expect(deps.posted.some((m) => m.type === 'dataops:error')).toBe(true);
  });
});
