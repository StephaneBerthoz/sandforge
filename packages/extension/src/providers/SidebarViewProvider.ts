import type * as vscode from 'vscode';
import { buildWebviewHtml } from './webviewHtml';
import { SIDEBAR_ROUTE_COMMANDS } from '../composition/moduleCommands';
import type { MessageBroker } from '../bridge/MessageBroker';

/** Factory for URI path joining — uses vscode.Uri for type safety. */
export type SidebarUriJoinPath = (base: vscode.Uri, ...segments: string[]) => vscode.Uri;

/**
 * Provides a WebviewView for the SandForge sidebar.
 * Loads the same React bundle as the main panels but with
 * `__SANDFORGE_MODULE__="sidepanel"` to render the sidebar navigation.
 *
 * Listens for navigation messages from the sidebar and executes
 * the corresponding VSCode commands to open module panels.
 *
 * When a {@link MessageBroker} is injected the view is registered with
 * `{ inbound: false }` so broker broadcasts (`postToWebview`) reach the
 * sidebar — its Running / Last operation blocks are driven by those. The
 * sidebar's own outbound messages stay on the provider's raw
 * `onDidReceiveMessage` subscription: they carry no id/timestamp envelope
 * and would fail broker validation + rate limiting.
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
  /** Broker registration for the currently resolved view (outbound-only). */
  private brokerRegistration?: vscode.Disposable;
  /** Subscription to the current view's `onDidDispose`. */
  private viewDisposeSubscription?: vscode.Disposable;

  constructor(
    private extensionUri: vscode.Uri,
    private uriJoinPath: SidebarUriJoinPath,
    private executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>,
    private orgGetter?: () => Record<string, unknown>[],
    private onOrgSelected?: (orgId: string) => void,
    private broker?: MessageBroker,
    private settingsGetter?: () => Record<string, unknown>,
  ) {}

  /**
   * Release the message listener + broker registration (test hook + manual
   * tear-down for hosts that dispose providers outside VSCode's normal
   * lifecycle).
   */
  dispose(): void {
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.releaseView();
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

    // Register the view with the broker so broadcasts (operation lifecycle,
    // state sync) reach the sidebar. Outbound-only: inbound sidebar traffic
    // stays on the raw subscription below. VSCode destroys WebviewViews when
    // they are hidden, so the previous registration is disposed first and the
    // new one is released on the view's own onDidDispose (no leak — same bug
    // class as the 1.3.0 fix).
    this.brokerRegistration?.dispose();
    this.brokerRegistration = this.broker?.registerPanel(webviewView, { inbound: false });
    this.viewDisposeSubscription?.dispose();
    this.viewDisposeSubscription = webviewView.onDidDispose(() => {
      this.releaseView(webviewView);
    });

    // Handle navigation messages from the sidebar React component
    this.messageSubscription = webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      const type = message.type as string | undefined;
      const payload = message.payload as Record<string, unknown> | undefined;

      if (type === 'sidebar:navigate') {
        const route = payload?.route as string | undefined;
        if (route) {
          // Map derived from MODULE_COMMANDS (composition/moduleCommands.ts) —
          // unknown routes keep falling back to Monitor.
          const command = SIDEBAR_ROUTE_COMMANDS[route] ?? 'sandforge.openMonitor';
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

      // The sidebar cannot reach the broker's settings:get (its inbound
      // traffic is raw, unenveloped) — answer its settings request here so it
      // can sync its UI language with the configured one.
      if (type === 'sidebar:requestSettings' && this.settingsGetter) {
        const settings = this.settingsGetter();
        this.postMessage({ type: 'settings:response', payload: { settings } });
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
   * Release the broker registration + dispose subscription tied to a resolved
   * view. When called from the view's own `onDidDispose`, only a matching
   * view clears `this.view` (a stale dispose event must not detach a newer
   * re-resolved view).
   */
  private releaseView(disposedView?: vscode.WebviewView): void {
    this.brokerRegistration?.dispose();
    this.brokerRegistration = undefined;
    this.viewDisposeSubscription?.dispose();
    this.viewDisposeSubscription = undefined;
    if (!disposedView || this.view === disposedView) {
      this.view = undefined;
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
