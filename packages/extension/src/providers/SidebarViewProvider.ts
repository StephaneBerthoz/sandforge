import type * as vscode from 'vscode';
import { buildWebviewHtml } from './webviewHtml';

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
  resolveWebviewView(webviewView: vscode.WebviewView, _context: unknown, _token: unknown): void {
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
            frozen: 'sandforge.openFrozen',
            grappe: 'sandforge.openGrappe',
            compare: 'sandforge.openCompare',
            dataops: 'sandforge.openDataOps',
            automation: 'sandforge.openAutomation',
            ai: 'sandforge.openAI',
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

  /**
   * Build the HTML content for the sidebar webview.
   * The shell (strict CSP + crypto nonce) is shared with the panel
   * manager — see ./webviewHtml.ts.
   */
  private buildHtml(webview: vscode.Webview): string {
    const joinPath = this.uriJoinPath;
    const scriptUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'style.css'),
    );

    return buildWebviewHtml({
      cspSource: webview.cspSource,
      scriptUri,
      styleUri,
      title: 'SandForge Sidebar',
      moduleId: 'sidepanel',
    });
  }
}
