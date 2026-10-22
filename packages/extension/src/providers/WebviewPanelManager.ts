import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import type { MessageBroker } from '../bridge/MessageBroker';
import { panelReloadPayloadSchema, panelRoutePayloadSchema } from '../bridge/validatePayload';
import { isRebuiltWhenHidden } from '../composition/moduleCommands';
import { buildWebviewHtml } from './webviewHtml';
import { parsePagePreload } from './pagePreload';

/**
 * What a released panel holds while hidden: a page with no script, which
 * frees the page's bundle, React tree and catalogue until the panel is shown
 * again and its shell is set back.
 */
const RELEASED_HTML =
  '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" ' +
  'content="default-src \'none\';"></head><body></body></html>';

/** What a panel's page last said it shows (`panel:route`). */
interface PageShown {
  route: string;
  overlay: boolean;
}

/** Configuration for opening a webview panel. */
export interface PanelConfig {
  viewType: string;
  title: string;
  column?: number;
  preserveFocus?: boolean;
  /** Module identifier injected into the webview HTML for routing. */
  moduleId?: string;
}

/** Options passed to the panel factory when creating a new webview panel. */
export interface PanelFactoryOptions {
  enableScripts: boolean;
  retainContextWhenHidden: boolean;
  localResourceRoots?: readonly { toString(): string }[];
}

/** Factory function type for creating webview panels (for DI/testability). */
export type WebviewPanelFactory = (
  viewType: string,
  title: string,
  column: number,
  options: PanelFactoryOptions,
) => vscode.WebviewPanel;

/**
 * Joins a base URI with path segments.
 * Abstracted for testability (avoids direct vscode.Uri.joinPath dependency).
 */
export type UriJoinPath = (base: unknown, ...segments: string[]) => unknown;

/**
 * Manages full-editor webview panels for SandForge modules.
 * Each module opens in a separate tab in the editor area.
 * Panels are tracked by viewType and reused on re-open.
 *
 * When a moduleId is provided in the PanelConfig, the panel HTML
 * is generated with a `window.__SANDFORGE_MODULE__` script injection
 * so the React app can determine which module to render.
 *
 * Hidden, a panel keeps its page, except Help's and Reports': their page is
 * released and rebuilt from its shell when the panel is shown again (the
 * policy, and what the other modules would need, is on
 * `ModuleCommand.rebuiltWhenHidden`).
 */
export class WebviewPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private visiblePanels = new Set<string>();
  /** The panels whose page is released while hidden, by viewType: see `isRebuiltWhenHidden`. */
  private readonly released = new Set<string>();
  /** What the page of each module's panel shows, as it last said; absent, its own module. */
  private readonly pagesShown = new Map<string, PageShown>();
  /** The module of each open panel, by viewType: the panel a `panel:reload` names. */
  private readonly modules = new Map<string, string>();
  /**
   * Per-panel disposables (view-state + dispose listeners + broker
   * registration, registered when the panel was opened). Cleared when the
   * panel is disposed or the manager is disposed — prevents VSCode
   * event-listener leaks across panel lifecycles.
   */
  private panelSubscriptions = new Map<string, vscode.Disposable[]>();
  /** Reads a module panel's title in the panels' language: see {@link setTitleOf}. */
  private titleOf?: (moduleId: string) => Promise<string | undefined>;
  /** Reads a file of the extension's own: see {@link setFileReader}. */
  private readFile?: (uri: unknown) => string | undefined;
  /** The files each page needs before it paints, read once from the build. */
  private pagePreload?: ReadonlyMap<string, readonly string[]>;

  /**
   * @param broker - MessageBroker for webview communication
   * @param panelFactory - Factory function to create webview panels
   * @param extensionUri - Extension URI for resolving webview resources
   * @param uriJoinPath - URI path joiner (defaults to noop for backward compat)
   * @param languageGetter - Reads the configured UI language for `<html lang>`
   * @param editorLanguageGetter - Reads the editor display language (`vscode.env.language`)
   */
  constructor(
    private broker: MessageBroker,
    private panelFactory: WebviewPanelFactory,
    private extensionUri?: { toString(): string },
    private uriJoinPath?: UriJoinPath,
    private languageGetter?: () => string | undefined,
    private editorLanguageGetter?: () => string | undefined,
  ) {}

  /**
   * Whether the panel of `viewType` is open with its page loaded: open, and
   * not released while hidden. A command that posts to a released panel waits
   * for its rebuilt page, as it waits for a new one.
   */
  isLive(viewType: string): boolean {
    return this.panels.has(viewType) && !this.released.has(viewType);
  }

  /**
   * Open a webview panel or reveal it if already open.
   * If moduleId is provided and extensionUri is set, the panel HTML
   * is generated with the module identifier injected.
   * @returns The opened or existing webview panel.
   */
  openPanel(config: PanelConfig): vscode.WebviewPanel {
    const existing = this.panels.get(config.viewType);
    if (existing) {
      existing.reveal(config.column ?? 1, config.preserveFocus);
      this.retitle(config, existing);
      return existing;
    }

    // The shell loads only webview-dist (bundle, stylesheet); the locales are
    // read from disk by the host. Rooting the webview at the whole extension
    // let it request any packaged file, compiled host code included.
    const localResourceRoots = this.extensionUri
      ? [
          (this.uriJoinPath
            ? this.uriJoinPath(this.extensionUri, 'webview-dist')
            : this.extensionUri) as { toString(): string },
        ]
      : undefined;

    const panel = this.panelFactory(config.viewType, config.title, config.column ?? 1, {
      enableScripts: true,
      // Kept for every panel. VS Code delivers postMessage only to a live
      // webview, so a Sync, Seed or DataOps panel moved to a background tab
      // would miss the progress and completion messages of the run it started,
      // and a half-filled wizard would be rebuilt empty on return. A panel
      // whose page holds neither is released here instead, and only while its
      // page shows nothing else (`releaseIfAtRest`): VS Code's own release
      // would also drop a page the panel had routed to another module.
      retainContextWhenHidden: true,
      localResourceRoots,
    });

    if (config.moduleId && this.extensionUri && this.uriJoinPath) {
      panel.webview.html = this.buildHtml(panel.webview, config.moduleId);
    }

    this.panels.set(config.viewType, panel);
    if (config.moduleId) this.modules.set(config.viewType, config.moduleId);
    // Keep the broker registration disposable with the panel's other
    // subscriptions so the broker drops the panel when it closes — otherwise
    // MessageBroker.panels accumulates dead panels across open/close cycles.
    const brokerRegistration = this.broker.registerPanel(panel);

    this.visiblePanels.add(config.viewType);
    const viewStateSub = panel.onDidChangeViewState((e) => {
      const visible = e.webviewPanel.visible;
      if (visible) {
        this.visiblePanels.add(config.viewType);
        // A page released while hidden is rebuilt from its shell, on its own
        // module, before anything else reaches it.
        if (this.released.delete(config.viewType) && config.moduleId) {
          this.pagesShown.delete(config.moduleId);
          panel.webview.html = this.buildHtml(panel.webview, config.moduleId);
          return;
        }
      } else {
        this.visiblePanels.delete(config.viewType);
      }
      // Hidden, the page keeps running: it is told, so what reads an org on
      // a timer waits for its return. Only this panel: the others did not move.
      void panel.webview.postMessage({
        type: 'panel:visibility',
        id: `panel-visibility-${Date.now()}`,
        timestamp: Date.now(),
        payload: { visible },
      });
      if (!visible) this.releaseIfAtRest(config, panel);
    });

    const disposeSub = panel.onDidDispose(() => {
      this.panels.delete(config.viewType);
      this.visiblePanels.delete(config.viewType);
      this.released.delete(config.viewType);
      this.modules.delete(config.viewType);
      if (config.moduleId) this.pagesShown.delete(config.moduleId);
      // Release the paired view-state listener along with the panel itself.
      for (const sub of this.panelSubscriptions.get(config.viewType) ?? []) {
        sub.dispose();
      }
      this.panelSubscriptions.delete(config.viewType);
    });

    this.panelSubscriptions.set(config.viewType, [viewStateSub, disposeSub, brokerRegistration]);
    this.retitle(config, panel);

    return panel;
  }

  /**
   * Name each module's panel as the panels' navigation does, in their
   * language (`panelTitleOf`): a panel opens under the English title it is
   * given, and takes this one once it is read. Reopening a panel reads it
   * again, after the panels' language changed.
   */
  setTitleOf(titleOf: (moduleId: string) => Promise<string | undefined>): void {
    this.titleOf = titleOf;
  }

  /**
   * Read the extension's own files with `read`: the build's list of the files
   * each page needs before it paints (`webview-dist/assets/preload.json`),
   * which the shell links for the webview to fetch at once. Without a reader,
   * or with a list that cannot be read, the shell links none of them.
   */
  setFileReader(read: (uri: unknown) => string | undefined): void {
    this.readFile = read;
    this.pagePreload = undefined;
  }

  /** The files of `webview-dist` the page of `moduleId` needs before it paints. */
  private preloadOf(moduleId: string): readonly string[] {
    if (!this.readFile || !this.extensionUri || !this.uriJoinPath) return [];
    if (!this.pagePreload) {
      const joinPath = this.uriJoinPath;
      let text: string | undefined;
      try {
        text = this.readFile(joinPath(this.extensionUri, 'webview-dist', 'assets', 'preload.json'));
      } catch {
        text = undefined;
      }
      this.pagePreload = parsePagePreload(text);
    }
    return this.pagePreload.get(moduleId) ?? [];
  }

  /** Give a module's panel its title in the panels' language, while it is still the one open. */
  private retitle(config: PanelConfig, panel: vscode.WebviewPanel): void {
    const { moduleId } = config;
    if (moduleId === undefined || !this.titleOf) return;
    this.titleOf(moduleId).then(
      (title) => {
        if (title !== undefined && this.panels.get(config.viewType) === panel) panel.title = title;
      },
      // Unread, the panel keeps the title it opened with.
      () => undefined,
    );
  }

  /** Close and dispose a panel by its viewType. */
  closePanel(viewType: string): void {
    const panel = this.panels.get(viewType);
    if (panel) {
      panel.dispose();
      this.panels.delete(viewType);
      this.visiblePanels.delete(viewType);
      this.modules.delete(viewType);
    }
  }

  /** Check whether a panel with the given viewType is currently open. */
  hasPanel(viewType: string): boolean {
    return this.panels.has(viewType);
  }

  /** Get the viewTypes of all currently open panels. */
  getOpenPanels(): string[] {
    return [...this.panels.keys()];
  }

  /** Check whether any managed panel is currently visible in the editor. */
  isAnyPanelVisible(): boolean {
    return this.visiblePanels.size > 0;
  }

  /** Post a message to all currently open panels (broadcast). */
  postToAllPanels(message: Record<string, unknown>): void {
    for (const panel of this.panels.values()) {
      void panel.webview.postMessage(message);
    }
  }

  /** Dispose all managed panels. */
  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    // Safety net: ensure per-panel listener disposables are released even if
    // a panel's onDidDispose callback didn't fire (e.g. forced manager dispose).
    for (const subs of this.panelSubscriptions.values()) {
      for (const sub of subs) {
        sub.dispose();
      }
    }
    this.panelSubscriptions.clear();
    this.panels.clear();
    this.visiblePanels.clear();
    this.released.clear();
    this.pagesShown.clear();
    this.modules.clear();
  }

  /**
   * Keep what a panel's page says it shows (`panel:route`, routed here by
   * `ExtensionHandlers`), for {@link releaseIfAtRest}. A payload of another
   * shape is ignored.
   */
  notePageShown(message: BaseMessage): void {
    const parsed = panelRoutePayloadSchema.safeParse((message as { payload?: unknown }).payload);
    if (!parsed.success) return;
    const { moduleId, route, overlay } = parsed.data;
    this.pagesShown.set(moduleId, { route, overlay });
  }

  /**
   * Set the shell of the panel whose page asks for it again (`panel:reload`,
   * routed here by `ExtensionHandlers`): a part of the page could not be
   * loaded, and React keeps a part whose file failed to load failed for as
   * long as the document lives, so the page's own Recover drew the same
   * failure again. The new document fetches every file afresh: the shell's
   * nonce is new, so VS Code loads it even though nothing else changed. A
   * payload of another shape, or a module with no panel open, is ignored.
   */
  reloadPage(message: BaseMessage): void {
    const parsed = panelReloadPayloadSchema.safeParse((message as { payload?: unknown }).payload);
    if (!parsed.success || !this.extensionUri || !this.uriJoinPath) return;
    const { moduleId } = parsed.data;
    for (const [viewType, panelModule] of this.modules) {
      const panel = this.panels.get(viewType);
      if (panelModule !== moduleId || !panel) continue;
      this.released.delete(viewType);
      this.pagesShown.delete(moduleId);
      panel.webview.html = this.buildHtml(panel.webview, moduleId);
      return;
    }
  }

  /**
   * Release the page of a panel just hidden when its module is one released
   * while hidden (Help, Reports) and the page is at rest: on its own module,
   * no overlay open. Any other page it routed to could be holding a run's
   * progress or an edit, and is kept.
   */
  private releaseIfAtRest(config: PanelConfig, panel: vscode.WebviewPanel): void {
    const moduleId = config.moduleId;
    if (!moduleId || !this.extensionUri || !this.uriJoinPath) return;
    if (!isRebuiltWhenHidden(moduleId)) return;
    const shown = this.pagesShown.get(moduleId);
    if (shown && (shown.route !== moduleId || shown.overlay)) return;
    this.released.add(config.viewType);
    panel.webview.html = RELEASED_HTML;
  }

  /**
   * Build the HTML content for a webview panel.
   * Injects the moduleId as `window.__SANDFORGE_MODULE__` so the
   * React application can route to the correct module view.
   * The shell (strict CSP + crypto nonce) is shared with the sidebar —
   * see ./webviewHtml.ts.
   */
  private buildHtml(webview: vscode.Webview, moduleId: string): string {
    const joinPath = this.uriJoinPath!;
    const scriptUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'index.js') as vscode.Uri,
    );
    const styleUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'style.css') as vscode.Uri,
    );

    return buildWebviewHtml({
      cspSource: webview.cspSource,
      scriptUri,
      styleUri,
      // index.js is an ES module that imports each page as it is shown.
      moduleScript: true,
      title: `SandForge: ${moduleId}`,
      moduleId,
      // Read per panel, not per manager: the user can switch language between
      // two openPanel calls and each shell must announce the current one.
      lang: this.languageGetter?.(),
      editorLanguage: this.editorLanguageGetter?.(),
      // The page's chunks, fetched as the shell is read rather than one round
      // of imports after another once index.js runs.
      preloadUris: this.preloadOf(moduleId).map((file) =>
        webview.asWebviewUri(
          joinPath(this.extensionUri, 'webview-dist', ...file.split('/')) as vscode.Uri,
        ),
      ),
    });
  }
}
