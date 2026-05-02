import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';

/** Factory for URI path joining — uses vscode.Uri for type safety. */
export type SidebarUriJoinPath = (base: vscode.Uri, ...segments: string[]) => vscode.Uri;

/**
 * Provides a WebviewView for the SandForge sidebar.
 * Loads the same React bundle as the main panels but with
 * `__SANDFORGE_MODULE__="sidepanel"` to render the sidebar navigation.
 *
 * Listens for navigation messages from the sidebar and executes
 * the corresponding VSCode commands to open module panels.
 */
export class SidebarViewProvider {
  /** The view ID registered in package.json. */
  static readonly viewType = 'sandforge.sidebarView';

  private view?: vscode.WebviewView;
  /**
   * Disposable for the `onDidReceiveMessage` subscription registered the last
   * time the view was resolved. Kept so we can release the previous listener
   * if the view is re-resolved (VSCode resolves views on reveal, not once).
   */
  private messageSubscription?: vscode.Disposable;

  constructor(
    private extensionUri: vscode.Uri,
    private uriJoinPath: SidebarUriJoinPath,
    private executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>,
    private orgGetter?: () => Record<string, unknown>[],
    private onOrgSelected?: (orgId: string) => void,
  ) {}

  /**
   * Release the message listener (test hook + manual tear-down for hosts that
   * dispose providers outside VSCode's normal lifecycle).
   */
  dispose(): void {
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.view = undefined;
  }

  /** Called by VSCode when the sidebar view becomes visible. */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: unknown,
    _token: unknown,
  ): void {
    this.view = webviewView;

    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webview.html = this.buildHtml(webview);

    // Release any prior subscription in case the view is re-resolved.
    this.messageSubscription?.dispose();

    // Handle navigation messages from the sidebar React component
    this.messageSubscription = webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      const type = message.type as string | undefined;
      const payload = message.payload as Record<string, unknown> | undefined;

      if (type === 'sidebar:navigate') {
        const route = payload?.route as string | undefined;
        if (route) {
          const commandMap: Record<string, string> = {
            home: 'sandforge.openMonitor',
            monitor: 'sandforge.openMonitor',
            forge: 'sandforge.openForge',
            grappe: 'sandforge.openGrappe',
            compare: 'sandforge.openCompare',
            dataops: 'sandforge.openDataOps',
            automation: 'sandforge.openAutomation',
            orgs: 'sandforge.openOrgs',
            settings: 'sandforge.openSettings',
            help: 'sandforge.openHelp',
          };
          const command = commandMap[route] ?? 'sandforge.openMonitor';
          void this.executeCommand(command);
        }
      }

      if (type === 'sidebar:openFull') {
        void this.executeCommand('sandforge.openMonitor');
      }

      if (type === 'sidebar:requestOrgs' && this.orgGetter) {
        const orgs = this.orgGetter();
        this.postMessage({ type: 'org:list:response', payload: { orgs } });
      }

      if (type === 'sidebar:selectOrg' && this.onOrgSelected) {
        const orgId = payload?.orgId as string | undefined;
        if (orgId) {
          this.onOrgSelected(orgId);
        }
      }
    });
  }

  /** Post a message to the sidebar webview (if visible). */
  postMessage(message: Record<string, unknown>): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    }
  }

  /** Build the HTML content for the sidebar webview. */
  private buildHtml(webview: vscode.Webview): string {
    const joinPath = this.uriJoinPath;
    const scriptUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'style.css'),
    );
    const nonce = this.generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link href="${String(styleUri)}" rel="stylesheet">
  <title>SandForge Sidebar</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__SANDFORGE_MODULE__="sidepanel";</script>
  <script nonce="${nonce}" src="${String(scriptUri)}"></script>
</body>
</html>`;
  }

  /**
   * Generate a cryptographically-random ~32-character nonce for CSP script tags.
   * Uses node:crypto so the nonce is unguessable — Math.random is a PRNG.
   */
  private generateNonce(): string {
    return randomBytes(24).toString('base64url');
  }
}
