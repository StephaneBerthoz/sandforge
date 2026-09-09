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

/** The slice of the VS Code API this needs, so tests do not need the real one. */
export interface SaveDialogHost {
  showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  fileUri(fsPath: string): vscode.Uri;
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
    };
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
    const suffix = suggestedName.includes('.') ? suggestedName.split('.').pop() : undefined;
    const filters = extensions?.length
      ? { [extensions.join('/').toUpperCase()]: extensions }
      : suffix
        ? { [suffix.toUpperCase()]: [suffix] }
        : undefined;

    const host = this.host ?? (await this.defaultHost());
    try {
      const uri = await host.showSaveDialog({
        saveLabel: 'Save',
        defaultUri: host.fileUri(suggestedName),
        ...(filters ? { filters } : {}),
      });
      if (!uri) return { status: 'cancelled' };

      await host.writeFile(uri, new TextEncoder().encode(content));
      return { status: 'saved', path: uri.fsPath };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}
