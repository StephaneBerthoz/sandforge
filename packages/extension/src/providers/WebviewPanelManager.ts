import type * as vscode from 'vscode';
import type { MessageBroker } from '../bridge/MessageBroker';
import { buildWebviewHtml } from './webviewHtml';

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
 */
export class WebviewPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private visiblePanels = new Set<string>();
  /**
   * Per-panel disposables (view-state + dispose listeners + broker
   * registration, registered when the panel was opened). Cleared when the
   * panel is disposed or the manager is disposed — prevents VSCode
   * event-listener leaks across panel lifecycles.
   */
  private panelSubscriptions = new Map<string, vscode.Disposable[]>();

  /** Optional callback invoked when any panel's visibility changes. */
  onVisibilityChange?: (anyVisible: boolean) => void;

  /**
   * @param broker - MessageBroker for webview communication
   * @param panelFactory - Factory function to create webview panels
   * @param extensionUri - Extension URI for resolving webview resources
   * @param uriJoinPath - URI path joiner (defaults to noop for backward compat)
   */
  constructor(
    private broker: MessageBroker,
    private panelFactory: WebviewPanelFactory,
    private extensionUri?: { toString(): string },
    private uriJoinPath?: UriJoinPath,
  ) {}

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
      return existing;
    }

    const localResourceRoots = this.extensionUri
      ? [this.extensionUri as { toString(): string }]
      : undefined;

    const panel = this.panelFactory(config.viewType, config.title, config.column ?? 1, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots,
    });

    if (config.moduleId && this.extensionUri && this.uriJoinPath) {
      panel.webview.html = this.buildHtml(panel.webview, config.moduleId);
    }

    this.panels.set(config.viewType, panel);
    // Keep the broker registration disposable with the panel's other
    // subscriptions so the broker drops the panel when it closes — otherwise
    // MessageBroker.panels accumulates dead panels across open/close cycles.
    const brokerRegistration = this.broker.registerPanel(panel);

    this.visiblePanels.add(config.viewType);
    const viewStateSub = panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.visiblePanels.add(config.viewType);
      } else {
        this.visiblePanels.delete(config.viewType);
      }
      this.onVisibilityChange?.(this.isAnyPanelVisible());
    });

    const disposeSub = panel.onDidDispose(() => {
      this.panels.delete(config.viewType);
      this.visiblePanels.delete(config.viewType);
      // Release the paired view-state listener along with the panel itself.
      for (const sub of this.panelSubscriptions.get(config.viewType) ?? []) {
        sub.dispose();
      }
      this.panelSubscriptions.delete(config.viewType);
    });

    this.panelSubscriptions.set(config.viewType, [viewStateSub, disposeSub, brokerRegistration]);

    return panel;
  }

  /** Close and dispose a panel by its viewType. */
  closePanel(viewType: string): void {
    const panel = this.panels.get(viewType);
    if (panel) {
      panel.dispose();
      this.panels.delete(viewType);
      this.visiblePanels.delete(viewType);
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
      title: `SandForge: ${moduleId}`,
      moduleId,
    });
  }
}
