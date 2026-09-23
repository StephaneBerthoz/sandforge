import { create } from 'zustand';

/** Available module routes for webview navigation */
export type ModuleRoute =
  | 'home'
  | 'orgs'
  | 'forge'
  | 'frozen'
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
  /** Org to write to (clone target, sync target). */
  targetOrgId?: string;
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
}));
