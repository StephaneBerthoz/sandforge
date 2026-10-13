// Type-only: a value import here would make every module that transitively
// reaches ExtensionHandlers fail to load outside the VS Code host, tests
// included. The real API is fetched lazily in `defaultHost()`, the same way
// AnthropicAdapter defers its SDK.
import type * as vscode from 'vscode';

/** What a save attempt produced, mirroring the `file:save:response` payload. */
export type SaveOutcome =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** What a save written a piece at a time produced: as {@link SaveOutcome}, with what the writing returned. */
export type StreamedSaveOutcome<T> =
  | { status: 'saved'; path: string; result: T }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** A file being written a piece at a time, at the place the user picked. */
export interface SaveFileWriter {
  /** Add text to the end of the file. */
  write(text: string): Promise<void>;
  /** The file is whole: it is now at the place picked. */
  close(): Promise<void>;
  /** The file is not whole: nothing of it is left at the place picked. */
  abort(): Promise<void>;
}

/** The slice of the VS Code API this needs, so tests do not need the real one. */
export interface SaveDialogHost {
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  fileUri(fsPath: string): vscode.Uri;
  /** Open a file to write a piece at a time, at the place picked. */
  openFile(uri: vscode.Uri): Promise<SaveFileWriter>;
}

/**
 * A file on disk written a piece at a time: into a file of its own beside
 * the place picked, moved there once whole. A write that fails part-way
 * leaves whatever the place held as it was, rather than a document cut off
 * in the middle under the name the user gave.
 */
async function openDiskFile(fsPath: string): Promise<SaveFileWriter> {
  const { open, rename, rm } = await import('node:fs/promises');
  const { randomBytes } = await import('node:crypto');
  const partial = `${fsPath}.${randomBytes(4).toString('hex')}.partial`;
  const handle = await open(partial, 'w');
  let closed = false;
  return {
    write: async (text) => {
      const bytes = Buffer.from(text, 'utf8');
      // A write may take fewer bytes than it was handed.
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
        offset += bytesWritten;
      }
    },
    close: async () => {
      closed = true;
      await handle.close();
      await rename(partial, fsPath);
    },
    abort: async () => {
      if (!closed) await handle.close().catch(() => undefined);
      closed = true;
      await rm(partial, { force: true });
    },
  };
}

/**
 * A file outside the disk the extension reaches — a virtual file system the
 * dialog offered — has no way to be added to: what is written is held, and
 * handed to VS Code whole once the writing ends.
 */
function heldFile(write: (content: Uint8Array) => Thenable<void>): SaveFileWriter {
  const pieces: string[] = [];
  return {
    write: async (text) => {
      pieces.push(text);
    },
    close: async () => {
      await write(new TextEncoder().encode(pieces.join('')));
    },
    abort: async () => {
      pieces.length = 0;
    },
  };
}

/**
 * Writes a file to a location the user picks.
 *
 * Deliberately NOT {@link FsAdapter}, which confines every write inside the
 * workspace root: an export is the one case where the destination is the
 * user's to choose, and confining it would be the wrong safety property. The
 * safety here comes from the dialog itself — the host never invents a path,
 * it only writes where the user pointed.
 *
 * This exists because the webview cannot save anything. Every export in the
 * product built a Blob, clicked a detached `<a>`, and toasted "downloaded
 * successfully" with no branch and nothing to branch on — inside a sandbox
 * without `allow-downloads`, where the click frequently saved nothing at all.
 */
export class SaveDialogAdapter {
  private readonly host: SaveDialogHost | null;

  constructor(host?: SaveDialogHost) {
    this.host = host ?? null;
  }

  /** The real VS Code dialog, resolved on first use. */
  private async defaultHost(): Promise<SaveDialogHost> {
    const vscode = await import('vscode');
    return {
      showSaveDialog: (options) => vscode.window.showSaveDialog(options),
      writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
      fileUri: (fsPath) => vscode.Uri.file(fsPath),
      openFile: async (uri) =>
        uri.scheme === 'file'
          ? openDiskFile(uri.fsPath)
          : heldFile((content) => vscode.workspace.fs.writeFile(uri, content)),
    };
  }

  /** The dialog's filter: the extensions given, or else the one of the suggested name. */
  private static filtersOf(
    suggestedName: string,
    extensions?: string[],
  ): Record<string, string[]> | undefined {
    const suffix = suggestedName.includes('.') ? suggestedName.split('.').pop() : undefined;
    return extensions?.length
      ? { [extensions.join('/').toUpperCase()]: extensions }
      : suffix
        ? { [suffix.toUpperCase()]: [suffix] }
        : undefined;
  }

  /** Ask where to save: the place picked, or undefined when the dialog was dismissed. */
  private static ask(
    host: SaveDialogHost,
    suggestedName: string,
    extensions?: string[],
  ): Thenable<vscode.Uri | undefined> {
    const filters = SaveDialogAdapter.filtersOf(suggestedName, extensions);
    return host.showSaveDialog({
      saveLabel: 'Save',
      defaultUri: host.fileUri(suggestedName),
      ...(filters ? { filters } : {}),
    });
  }

  /**
   * Ask where to save, then write there.
   *
   * @param suggestedName - Pre-filled name in the dialog.
   * @param content - UTF-8 text to write.
   * @param extensions - Extensions offered by the filter, without the dot.
   *   Falls back to the one in `suggestedName`.
   * @returns Where it landed, that the user cancelled, or why it failed.
   *   Cancelling is not an error: dismissing the dialog is a normal action,
   *   and reporting it as a failure is the same lie in the other direction.
   */
  async save(suggestedName: string, content: string, extensions?: string[]): Promise<SaveOutcome> {
    const host = this.host ?? (await this.defaultHost());
    try {
      const uri = await SaveDialogAdapter.ask(host, suggestedName, extensions);
      if (!uri) return { status: 'cancelled' };

      await host.writeFile(uri, new TextEncoder().encode(content));
      return { status: 'saved', path: uri.fsPath };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Ask where to save, then write there a piece at a time, as `write` hands
   * the pieces over: for an export too large to build as one string, such as
   * a backup of up to a million records per object.
   *
   * @param suggestedName - Pre-filled name in the dialog.
   * @param write - Writes the file through the function it is given; called
   *   once a place is picked, never when the dialog is dismissed. What it
   *   returns comes back with the outcome; what it throws fails the save.
   * @param extensions - As for {@link save}.
   * @returns Where it landed and what `write` returned, that the user
   *   cancelled, or why it failed. A save that fails leaves nothing of the
   *   file at the place picked.
   */
  async saveStream<T>(
    suggestedName: string,
    write: (append: (text: string) => Promise<void>) => Promise<T>,
    extensions?: string[],
  ): Promise<StreamedSaveOutcome<T>> {
    const host = this.host ?? (await this.defaultHost());
    let file: SaveFileWriter | undefined;
    try {
      const uri = await SaveDialogAdapter.ask(host, suggestedName, extensions);
      if (!uri) return { status: 'cancelled' };

      const opened = await host.openFile(uri);
      file = opened;
      const result = await write((text) => opened.write(text));
      await opened.close();
      file = undefined;
      return { status: 'saved', path: uri.fsPath, result };
    } catch (err) {
      await file?.abort().catch(() => undefined);
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}
