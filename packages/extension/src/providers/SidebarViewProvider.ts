import type * as vscode from 'vscode';
import type { OrgListResponse } from '@sandforge/shared';
import { sidepanelLocaleSubset } from '@sandforge/shared';
import { join } from 'node:path';
import { buildWebviewHtml } from './webviewHtml';
import { LANDING_COMMAND, SIDEBAR_ROUTE_COMMANDS } from '../composition/moduleCommands';
import { moduleIntentSchema } from '../composition/moduleIntent';
import type { MessageBroker } from '../bridge/MessageBroker';
import { isSupportedLocaleCode, readLocaleBundle } from '../core/i18n/localeBundles';
import { extractErrorMessage } from '../core/common/extractErrorMessage.js';

/** Factory for URI path joining — uses vscode.Uri for type safety. */
export type SidebarUriJoinPath = (base: vscode.Uri, ...segments: string[]) => vscode.Uri;

/** The latest checkpoint of an org that can be rewound to, as the line under Checkpoints names it. */
export interface SidebarLastCheckpoint {
  checkpointId: string;
  name: string;
  /** When its take ended, on the org's clock. */
  takenAt: string;
}

/**
 * How long the line under Checkpoints is answered from what was read last,
 * without reading the store again: VS Code recreates the view at every
 * reveal, and the sidebar asks at each, at each change of org, and every
 * minute. A checkpoint taken, changed or deleted in this window clears it at
 * once. One taken from the command line or another window shows at the
 * sidebar's first ask after it has run out: within two minutes, since the
 * ask a minute after the read may come just before.
 */
export const LAST_CHECKPOINT_CACHE_MS = 60_000;

/**
 * A message the provider posts straight to the sidebar webview, outside the
 * broker envelope. Each channel names the payload it carries: the org list
 * used to travel with an undeclared `selectedOrgId` that the sidebar read back
 * through a cast, and nothing checked the two ends agreed.
 */
export type SidebarOutboundMessage =
  | {
      type: 'org:list:response';
      payload: {
        orgs: Record<string, unknown>[];
        selectedOrgId?: OrgListResponse['payload']['selectedOrgId'];
      };
    }
  | {
      type: 'settings:response';
      payload: { settings: Record<string, unknown>; grappeEnabled?: boolean };
    }
  | {
      type: 'sidebar:cliOrgs';
      /** How many orgs the Salesforce CLI holds that SandForge could import. */
      payload: { count: number };
    }
  | {
      type: 'sidebar:lastCheckpoint';
      /** The org asked about, and its latest usable checkpoint: none, no line. */
      payload: { orgId: string; checkpoint?: SidebarLastCheckpoint };
    }
  | {
      id: string;
      type: 'i18n:locale:response';
      timestamp: number;
      correlationId?: string;
      payload: { lng: string; bundle?: Record<string, unknown>; error?: string };
    };

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
  /**
   * The line under Checkpoints last read for each org, with when its read
   * began. Kept across views: the view is recreated at every reveal.
   */
  private readonly lastCheckpoints = new Map<
    string,
    { readAt: number; checkpoint?: SidebarLastCheckpoint }
  >();
  /**
   * Raised each time the checkpoints change: a read begun before is not kept,
   * since it may have listed the store before the change.
   */
  private lastCheckpointGeneration = 0;
  /** The org the sidebar last asked the line of: the one told again when the checkpoints change. */
  private lastCheckpointOrg?: string;

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
    /** Editor display language (`vscode.env.language`) for the `auto` setting. */
    private editorLanguageGetter?: () => string | undefined,
    /** Whether `sandforge.grappe.enabled` is on: the launcher lists Grappe only then. */
    private grappeEnabledGetter?: () => boolean,
    /**
     * How many orgs the Salesforce CLI holds, read from its own files. Asked
     * only while no org is registered, for the launcher's first card.
     */
    private cliOrgCounter?: () => Promise<number>,
    /**
     * The registered org's latest checkpoint that can be rewound to, read
     * from this machine's store: nothing for a production org.
     */
    private lastCheckpointGetter?: (orgId: string) => Promise<SidebarLastCheckpoint | undefined>,
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
      // Only the bundle folder: the sidebar shell loads nothing else, and the
      // locales are read from disk by the host (answerLocaleRequest).
      localResourceRoots: [this.uriJoinPath(this.extensionUri, 'webview-dist')],
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
          // an unknown route opens Home, the landing page.
          const command = SIDEBAR_ROUTE_COMMANDS[route] ?? LANDING_COMMAND;
          // What to start on the page it opens, from the launcher's first
          // card: checked here, where the raw lane enters, and again by the
          // command that hands it to the panel.
          const intent = moduleIntentSchema.safeParse(payload?.intent);
          if (payload?.intent !== undefined && intent.success) {
            void this.executeCommand(command, intent.data);
          } else {
            void this.executeCommand(command);
          }
        }
      }

      // The full UI is Home: the recommended next step, the orgs and the
      // recent runs, rather than Monitor's API limits.
      if (type === 'sidebar:openFull') {
        void this.executeCommand(LANDING_COMMAND);
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
        // No org yet: say how many the Salesforce CLI would bring in, so the
        // launcher's first card can offer them.
        if (orgs.length === 0 && this.cliOrgCounter) {
          void this.cliOrgCounter()
            .then((count) => this.postMessage({ type: 'sidebar:cliOrgs', payload: { count } }))
            .catch(() => undefined);
        }
      }

      // The sidebar cannot reach the broker's settings:get (its inbound
      // traffic is raw, unenveloped) — answer its settings request here so it
      // can sync its UI language with the configured one.
      if (type === 'sidebar:requestSettings' && this.settingsGetter) {
        const settings = this.settingsGetter();
        this.postMessage({
          type: 'settings:response',
          payload: { settings, grappeEnabled: this.grappeEnabledGetter?.() ?? false },
        });
      }

      if (type === 'sidebar:selectOrg' && this.onOrgSelected) {
        const orgId = payload?.orgId as string | undefined;
        if (orgId) {
          this.onOrgSelected(orgId);
        }
      }

      // The line under Checkpoints, of the org selected.
      if (type === 'sidebar:requestLastCheckpoint') {
        const orgId = payload?.orgId;
        if (typeof orgId === 'string' && orgId !== '') {
          void this.answerLastCheckpoint(orgId);
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
  postMessage(message: SidebarOutboundMessage): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    }
  }

  /**
   * The checkpoints kept on this machine have changed in this window: what
   * was read of them is let go, and the org the sidebar shows is told again.
   */
  checkpointsChanged(): void {
    this.lastCheckpoints.clear();
    this.lastCheckpointGeneration++;
    if (this.view && this.lastCheckpointOrg !== undefined) {
      void this.answerLastCheckpoint(this.lastCheckpointOrg);
    }
  }

  /**
   * Answer the line under Checkpoints for `orgId`: from what was read within
   * {@link LAST_CHECKPOINT_CACHE_MS}, else from the store. A read that fails
   * answers no checkpoint, and is not kept: the next request reads again.
   */
  private async answerLastCheckpoint(orgId: string): Promise<void> {
    const getter = this.lastCheckpointGetter;
    if (!getter) return;
    this.lastCheckpointOrg = orgId;
    const kept = this.lastCheckpoints.get(orgId);
    let checkpoint: SidebarLastCheckpoint | undefined;
    if (kept !== undefined && Date.now() - kept.readAt < LAST_CHECKPOINT_CACHE_MS) {
      checkpoint = kept.checkpoint;
    } else {
      const generation = this.lastCheckpointGeneration;
      const readAt = Date.now();
      let failed = false;
      try {
        checkpoint = await getter(orgId);
      } catch {
        failed = true;
      }
      // The checkpoints changed while this read listed them: it may be of
      // the store before, and the read the change began answers in its place.
      if (generation !== this.lastCheckpointGeneration) return;
      if (!failed) this.lastCheckpoints.set(orgId, { readAt, checkpoint });
    }
    this.postMessage({
      type: 'sidebar:lastCheckpoint',
      payload: checkpoint ? { orgId, checkpoint } : { orgId },
    });
  }

  /**
   * Answer an `i18n:locale` request from the sidebar webview with the packaged
   * locale JSON (`<extension>/webview-dist/locales/<lng>.json`), cut to the
   * namespaces the sidebar renders: the whole catalogue, about 320 kB, went
   * to it at every reveal for some fifty keys. The locale code is whitelisted
   * before it reaches the filesystem; failures answer with `{ lng, error }`
   * so the sidebar falls back to English.
   *
   * @param request - The inner bridge message (`envelope.payload`).
   */
  private async answerLocaleRequest(request: { id?: unknown; payload?: unknown }): Promise<void> {
    const lng = (request.payload as { lng?: unknown } | undefined)?.lng;
    const base = {
      id: `i18n-locale-${Date.now()}`,
      type: 'i18n:locale:response',
      timestamp: Date.now(),
      // Correlated like a broker buildResponse so the webview loader matches
      // this answer to its pending request.
      correlationId: typeof request.id === 'string' ? request.id : undefined,
    } as const;
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
      this.postMessage({ ...base, payload: { lng, bundle: sidepanelLocaleSubset(bundle) } });
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
      editorLanguage: this.editorLanguageGetter?.(),
    });
  }
}
