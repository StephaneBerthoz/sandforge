import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';

// The adapter imports `vscode` for its default host — the one path these tests
// never take, since every case injects a host. The module still has to resolve.
vi.mock('vscode', () => ({
  window: { showSaveDialog: vi.fn() },
  workspace: { fs: { writeFile: vi.fn() } },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import { SaveDialogAdapter, type SaveDialogHost } from './SaveDialogAdapter.js';

/** A stand-in for the three VS Code calls the adapter makes. */
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
