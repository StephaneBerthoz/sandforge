// Type-only: a value import here would make every module that transitively
// reaches ExtensionHandlers fail to load outside the VS Code host, tests
// included. The real API is fetched lazily in `defaultHost()`, the same way
// SaveDialogAdapter defers it.
import type * as vscode from 'vscode';

/** What an open attempt produced, mirroring the `monitor:open-apex-jobs:response` payload. */
export type OpenExternalOutcome = { status: 'opened' } | { status: 'error'; message: string };

/** The slice of the VS Code API this needs, so tests do not need the real one. */
export interface ExternalBrowserHost {
  openExternal(target: vscode.Uri): Thenable<boolean>;
  parseUri(value: string): vscode.Uri;
}

/**
 * Opens a web page in the user's browser, through VS Code.
 *
 * It validates nothing and builds nothing: callers construct the address from
 * extension state and pass it through `parseHttpsUrl` first. No caller hands
 * it a URL that came from a webview.
 */
export class ExternalBrowserAdapter {
  private readonly host: ExternalBrowserHost | null;

  constructor(host?: ExternalBrowserHost) {
    this.host = host ?? null;
  }

  /** The real VS Code API, resolved on first use. */
  private async defaultHost(): Promise<ExternalBrowserHost> {
    const vscode = await import('vscode');
    return {
      openExternal: (target) => vscode.env.openExternal(target),
      parseUri: (value) => vscode.Uri.parse(value, true),
    };
  }

  /**
   * Open `url` in the system browser.
   *
   * @param url - An absolute address the caller has already validated.
   * @returns `opened`, or `error` with the reason. `openExternal` resolving
   *   `false` is reported as an error: VS Code says the page was not opened,
   *   and does not say whether a declined prompt or a missing opener caused it.
   */
  async open(url: string): Promise<OpenExternalOutcome> {
    const host = this.host ?? (await this.defaultHost());
    try {
      const opened = await host.openExternal(host.parseUri(url));
      return opened
        ? { status: 'opened' }
        : { status: 'error', message: 'VS Code did not open the page.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}
