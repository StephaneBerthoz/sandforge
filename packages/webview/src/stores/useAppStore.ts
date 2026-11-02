import { create } from 'zustand';
import type { OrgPageAction } from '@sandforge/shared';

/** Available module routes for webview navigation */
export type ModuleRoute =
  | 'home'
  | 'orgs'
  | 'forge'
  | 'frozen'
  | 'checkpoint'
  | 'grappe'
  | 'monitor'
  | 'seed'
  | 'sync'
  | 'compare'
  | 'dataops'
  | 'automation'
  | 'migration'
  | 'ai'
  | 'autopilot'
  | 'reports'
  | 'settings'
  | 'welcome'
  | 'help';

/** All available routes as a constant array */
export const ALL_ROUTES: readonly ModuleRoute[] = [
  'home',
  'orgs',
  'forge',
  'frozen',
  'checkpoint',
  'grappe',
  'monitor',
  'seed',
  'sync',
  'compare',
  'dataops',
  'automation',
  'migration',
  'ai',
  'autopilot',
  'reports',
  'settings',
  'welcome',
  'help',
] as const;

/**
 * Where a navigation should land inside its page, set by a caller that knows
 * more than the route — Home's recommended action — and read once by the page
 * it opens. A plain navigation clears it, so it never outlives its trip.
 */
export interface NavigationIntent {
  route: ModuleRoute;
  /**
   * Seed mode to open on: the clone wizard, the quick-seed template gallery,
   * or CSV Upload, where Migration sends a CSV file of records.
   */
  seedMode?: 'clone' | 'quick-seed' | 'csv';
  /** Org to read from (clone source, sync source). */
  sourceOrgId?: string;
  /** Org to write to (clone target, sync target), or the one a checkpoint is to be taken of. */
  targetOrgId?: string;
  /**
   * What Organizations starts as it opens: an import from the Salesforce CLI
   * or the browser sign-in, asked by the launcher's first card.
   */
  orgAction?: OrgPageAction;
  /** Org whose Reconnect Organizations runs as it opens: one whose session expired mid-run. */
  reconnectOrgId?: string;
  /**
   * The record Forge starts a run from, typed in Home's hero field. Home
   * handed it over through the Forge store, which put zod and the store's
   * module on Home for one id.
   */
  recordId?: string;
  /**
   * Open Checkpoints on a take of the selected org: Home's "Take a checkpoint",
   * and "Take a checkpoint now" on the result of a run that filled an org,
   * which selects that org and names it in `targetOrgId`.
   */
  takeCheckpoint?: true;
  /**
   * Open Checkpoints on what a rewind of the selected org to this checkpoint
   * would do: Home's "Rewind…", for the org's latest, and a run's "Rewind to
   * before this run…", for the checkpoint it took first.
   */
  previewCheckpointId?: string;
  /**
   * The preview of `previewCheckpointId` opens with its mute ticked: the run
   * whose checkpoint it is muted the target's automation, and its rewind
   * fires the same automation.
   */
  previewMuted?: true;
  /**
   * A saved Sync configuration to open on Sync's execute step, by its id and
   * the name it was saved under: Migration's "Open in Sync", with the two
   * orgs it runs between in `sourceOrgId` and `targetOrgId`. Sync's own
   * Simulate, run, results and removal then apply to it.
   */
  syncConfig?: { id: string; name: string };
  /** The Settings tab to open on: the tour's "Open AI settings" asks for the AI tab. */
  settingsTab?: 'ai';
}

/** Application-level state for routing, sidebar, and extension readiness */
export interface AppState {
  currentRoute: ModuleRoute;
  /** Landing instructions for the page `navigate` last opened, until it reads them. */
  navigationIntent: NavigationIntent | null;
  sidebarCollapsed: boolean;
  isLoading: boolean;
  extensionReady: boolean;
  showWelcome: boolean;
  showWhatsNew: boolean;
  whatsNewVersion: string;
  /**
   * The version last opened before `whatsNewVersion`, when the extension
   * knows it: What's New lists every release after it, not the current one
   * alone, so an upgrade that skipped 1.69 still shows it.
   */
  whatsNewSince: string;
  aiAvailable: boolean;
  /** Whether VS Code shows this panel; a hidden one keeps running. */
  panelVisible: boolean;
  /**
   * Whether `sandforge.grappe.enabled` is on: Home offers Grappe only then,
   * an empty page otherwise.
   */
  grappeEnabled: boolean;
  navigate: (route: ModuleRoute, intent?: Omit<NavigationIntent, 'route'>) => void;
  /** Called by the page that read the intent, so a later visit opens normally. */
  clearNavigationIntent: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLoading: (loading: boolean) => void;
  setExtensionReady: (ready: boolean) => void;
  setShowWelcome: (show: boolean) => void;
  setShowWhatsNew: (show: boolean, version?: string, since?: string) => void;
  setAiAvailable: (available: boolean) => void;
  setPanelVisible: (visible: boolean) => void;
  setGrappeEnabled: (enabled: boolean) => void;
}

/** Zustand store for application-level state */
export const useAppStore = create<AppState>((set) => ({
  currentRoute: 'home',
  navigationIntent: null,
  sidebarCollapsed: false,
  isLoading: false,
  extensionReady: false,
  showWelcome: false,
  showWhatsNew: false,
  whatsNewVersion: '',
  whatsNewSince: '',
  aiAvailable: false,
  panelVisible: true,
  grappeEnabled: false,

  navigate(route: ModuleRoute, intent?: Omit<NavigationIntent, 'route'>): void {
    set({ currentRoute: route, navigationIntent: intent ? { route, ...intent } : null });
  },

  clearNavigationIntent(): void {
    set({ navigationIntent: null });
  },

  toggleSidebar(): void {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
  },

  setSidebarCollapsed(collapsed: boolean): void {
    set({ sidebarCollapsed: collapsed });
  },

  setLoading(loading: boolean): void {
    set({ isLoading: loading });
  },

  setExtensionReady(ready: boolean): void {
    set({ extensionReady: ready });
  },

  setShowWelcome(show: boolean): void {
    set({ showWelcome: show });
  },

  setShowWhatsNew(show: boolean, version?: string, since?: string): void {
    set({ showWhatsNew: show, whatsNewVersion: version ?? '', whatsNewSince: since ?? '' });
  },

  setAiAvailable(available: boolean): void {
    set({ aiAvailable: available });
  },

  setPanelVisible(visible: boolean): void {
    set({ panelVisible: visible });
  },

  setGrappeEnabled(enabled: boolean): void {
    set({ grappeEnabled: enabled });
  },
}));
