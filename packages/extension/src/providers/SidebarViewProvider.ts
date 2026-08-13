import type * as vscode from 'vscode';
import { join } from 'node:path';
import { buildWebviewHtml } from './webviewHtml';
import { SIDEBAR_ROUTE_COMMANDS } from '../composition/moduleCommands';
import type { MessageBroker } from '../bridge/MessageBroker';
import { isSupportedLocaleCode, readLocaleBundle } from '../core/i18n/localeBundles';
import { extractErrorMessage } from '../core/common/extractErrorMessage.js';

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
    private selectedOrgGetter?: () => string | undefined,
    /**
     * Configured UI language for `<html lang>`. Separate from settingsGetter
     * on purpose: the shell is rebuilt on every reveal, and folding it into
     * the settings-request path would tie two unrelated read cadences.
     */
    private languageGetter?: () => string | undefined,
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

      // Enveloped bridge request from the bundle's i18n locale loader. The
      // sidebar's inbound lane bypasses the MessageBroker (raw shapes would
      // fail envelope validation), so locale requests are answered here with
      // the same contract as the I18nHandler.
      if (type === undefined && payload?.['type'] === 'i18n:locale') {
        void this.answerLocaleRequest(payload as { id?: unknown; payload?: unknown });
        return;
      }

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
        // Carry the current selection so a re-resolved sidebar (VS Code
        // recreates the view on hide/show) restores it — same contract as
        // state:sync for panels.
        this.postMessage({
          type: 'org:list:response',
          payload: { orgs, selectedOrgId: this.selectedOrgGetter?.() },
        });
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

      // Launcher dropdown "open in browser" action — the command owns the
      // org lookup, URL validation, and error surfacing.
      if (type === 'sidebar:openOrgInBrowser') {
        const orgId = payload?.orgId as string | undefined;
        if (orgId) {
          void this.executeCommand('sandforge.openOrgInBrowser', orgId);
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
   * Answer an `i18n:locale` request from the sidebar webview with the packaged
   * locale JSON (`<extension>/webview-dist/locales/<lng>.json`). The locale
   * code is whitelisted before it reaches the filesystem; failures answer
   * with `{ lng, error }` so the sidebar falls back to English.
   *
   * @param request - The inner bridge message (`envelope.payload`).
   */
  private async answerLocaleRequest(request: { id?: unknown; payload?: unknown }): Promise<void> {
    const lng = (request.payload as { lng?: unknown } | undefined)?.lng;
    const base: Record<string, unknown> = {
      id: `i18n-locale-${Date.now()}`,
      type: 'i18n:locale:response',
      timestamp: Date.now(),
      // Correlated like a broker buildResponse so the webview loader matches
      // this answer to its pending request.
      correlationId: typeof request.id === 'string' ? request.id : undefined,
    };
    if (!isSupportedLocaleCode(lng)) {
      this.postMessage({
        ...base,
        payload: { lng: typeof lng === 'string' ? lng : '', error: 'Unsupported locale code.' },
      });
      return;
    }
    try {
      const bundle = await readLocaleBundle(
        join(this.extensionUri.fsPath, 'webview-dist', 'locales'),
        lng,
      );
      this.postMessage({ ...base, payload: { lng, bundle } });
    } catch (err: unknown) {
      this.postMessage({ ...base, payload: { lng, error: extractErrorMessage(err) } });
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
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'sidepanel.js'),
    );
    const styleUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'sidepanel.css'),
    );

    return buildWebviewHtml({
      cspSource: webview.cspSource,
      scriptUri,
      styleUri,
      title: 'SandForge Sidebar',
      moduleId: 'sidepanel',
      // Stamped on the first paint, before the bundle has restored its own
      // language — the i18n `languageChanged` listener keeps it in step after.
      lang: this.languageGetter?.(),
    });
  }
}
