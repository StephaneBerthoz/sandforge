import { mkdtemp, readFile, readdir, rm, writeFile as writeDiskFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';

// The adapter imports `vscode` for its default host. Every case but those of
// the file written on disk injects a host; the module still has to resolve.
vi.mock('vscode', () => ({
  window: { showSaveDialog: vi.fn() },
  workspace: { fs: { writeFile: vi.fn() } },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import { SaveDialogAdapter, type SaveDialogHost } from './SaveDialogAdapter.js';

/** A stand-in for the VS Code calls the adapter makes. */
function makeHost(overrides?: Partial<SaveDialogHost>): {
  host: SaveDialogHost;
  showSaveDialog: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
} {
  const showSaveDialog = vi.fn().mockResolvedValue({ fsPath: '/home/u/limits.csv' });
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const host = {
    showSaveDialog,
    writeFile,
    fileUri: (fsPath: string) => ({ fsPath }) as vscode.Uri,
    ...overrides,
  } as unknown as SaveDialogHost;
  return { host, showSaveDialog, writeFile };
}

describe('SaveDialogAdapter', () => {
  it('writes what the user chose and reports the path', async () => {
    // The path is the whole point: the exports it replaces reported success
    // and never said where the file went, in a sandbox where it usually went
    // nowhere at all.
    const { host, writeFile } = makeHost();

    const outcome = await new SaveDialogAdapter(host).save('limits.csv', 'Id,Name\n001,Acme\n');

    expect(outcome).toEqual({ status: 'saved', path: '/home/u/limits.csv' });
    const [uri, bytes] = writeFile.mock.calls[0];
    expect(uri.fsPath).toBe('/home/u/limits.csv');
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('Id,Name\n001,Acme\n');
  });

  it('treats a dismissed dialog as cancelled, not as a failure', async () => {
    const { host, writeFile } = makeHost({
      showSaveDialog: vi.fn().mockResolvedValue(undefined),
    });

    const outcome = await new SaveDialogAdapter(host).save('limits.csv', 'x');

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('reports a write failure instead of claiming a save', async () => {
    const { host } = makeHost({
      writeFile: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
    });

    const outcome = await new SaveDialogAdapter(host).save('limits.csv', 'x');

    expect(outcome).toEqual({ status: 'error', message: 'EACCES: permission denied' });
  });

  it('offers the explicit extension filter when one is given', async () => {
    const { host, showSaveDialog } = makeHost();

    await new SaveDialogAdapter(host).save('report.json', '{}', ['json']);

    expect(showSaveDialog.mock.calls[0][0].filters).toEqual({ JSON: ['json'] });
  });

  it('falls back to the suffix of the suggested name', async () => {
    const { host, showSaveDialog } = makeHost();

    await new SaveDialogAdapter(host).save('sandforge-limits-2026-09-09.csv', 'x');

    expect(showSaveDialog.mock.calls[0][0].filters).toEqual({ CSV: ['csv'] });
    expect(showSaveDialog.mock.calls[0][0].defaultUri.fsPath).toBe(
      'sandforge-limits-2026-09-09.csv',
    );
  });

  it('omits the filter entirely for a name with no extension', async () => {
    const { host, showSaveDialog } = makeHost();

    await new SaveDialogAdapter(host).save('export', 'x');

    expect(showSaveDialog.mock.calls[0][0].filters).toBeUndefined();
  });
});

describe('SaveDialogAdapter.saveStream', () => {
  /** A file opened at the place picked: each piece written to it, and how it ended. */
  function openedFile() {
    const pieces: string[] = [];
    return {
      pieces,
      write: vi.fn(async (text: string) => {
        pieces.push(text);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
  }

  it('writes the pieces handed over to the file picked, and reports where with what the writing returned', async () => {
    const file = openedFile();
    const openFile = vi.fn().mockResolvedValue(file);
    const { host } = makeHost({ openFile });

    const outcome = await new SaveDialogAdapter(host).saveStream(
      'backup.json',
      async (append) => {
        await append('{"a":');
        await append('1}');
        return 2;
      },
      ['json'],
    );

    expect(outcome).toEqual({ status: 'saved', path: '/home/u/limits.csv', result: 2 });
    expect(openFile.mock.calls[0][0].fsPath).toBe('/home/u/limits.csv');
    expect(file.pieces).toEqual(['{"a":', '1}']);
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(file.abort).not.toHaveBeenCalled();
  });

  it('opens nothing and writes nothing when the dialog is dismissed', async () => {
    const openFile = vi.fn();
    const write = vi.fn();
    const { host } = makeHost({ showSaveDialog: vi.fn().mockResolvedValue(undefined), openFile });

    const outcome = await new SaveDialogAdapter(host).saveStream('backup.json', write);

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(openFile).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('abandons the file, and says why, when the writing fails part-way', async () => {
    const file = openedFile();
    const { host } = makeHost({ openFile: vi.fn().mockResolvedValue(file) });

    const outcome = await new SaveDialogAdapter(host).saveStream('backup.json', async (append) => {
      await append('{"a":');
      throw new Error('The backup of Contact is damaged at line 2 of its file');
    });

    expect(outcome).toEqual({
      status: 'error',
      message: 'The backup of Contact is damaged at line 2 of its file',
    });
    expect(file.abort).toHaveBeenCalledTimes(1);
    expect(file.close).not.toHaveBeenCalled();
  });

  describe('on disk', () => {
    let dir: string | undefined;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    /** The real dialog, answering `picked` as a file on disk. */
    function pick(picked: string): void {
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({
        scheme: 'file',
        fsPath: picked,
      } as vscode.Uri);
    }

    it('writes the file piece by piece and leaves nothing else beside it', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'sandforge-save-'));
      const target = path.join(dir, 'backup.json');
      pick(target);
      const big = 'x'.repeat(1_000_000);

      const outcome = await new SaveDialogAdapter().saveStream('backup.json', async (append) => {
        await append('{"pieces":["');
        await append(big);
        await append('"]}\n');
        return 'done';
      });

      expect(outcome).toEqual({ status: 'saved', path: target, result: 'done' });
      expect(await readFile(target, 'utf8')).toBe(`{"pieces":["${big}"]}\n`);
      expect(await readdir(dir)).toEqual(['backup.json']);
    });

    it('leaves the file picked as it was when the writing fails part-way', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'sandforge-save-'));
      const target = path.join(dir, 'backup.json');
      await writeDiskFile(target, 'the export of yesterday', 'utf8');
      pick(target);

      const outcome = await new SaveDialogAdapter().saveStream('backup.json', async (append) => {
        await append('{"half":');
        throw new Error('ENOSPC: no space left on device');
      });

      expect(outcome).toEqual({ status: 'error', message: 'ENOSPC: no space left on device' });
      expect(await readFile(target, 'utf8')).toBe('the export of yesterday');
      expect(await readdir(dir)).toEqual(['backup.json']);
    });
  });
});
