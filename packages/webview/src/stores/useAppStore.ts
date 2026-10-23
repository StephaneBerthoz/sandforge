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
  /** Seed mode to open on: the clone wizard, or the quick-seed template gallery. */
  seedMode?: 'clone' | 'quick-seed';
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
   * would do: Home's "Rewind…", for the org's latest.
   */
  previewCheckpointId?: string;
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
  setShowWhatsNew: (show: boolean, version?: string) => void;
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

  setShowWhatsNew(show: boolean, version?: string): void {
    set({ showWhatsNew: show, whatsNewVersion: version ?? '' });
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
