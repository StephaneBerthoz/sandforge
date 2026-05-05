import { create } from 'zustand';

/** Available module routes for webview navigation */
export type ModuleRoute =
  | 'home'
  | 'orgs'
  | 'forge'
  | 'grappe'
  | 'monitor'
  | 'seed'
  | 'sync'
  | 'compare'
  | 'dataops'
  | 'automation'
  | 'ai'
  | 'reports'
  | 'settings'
  | 'welcome'
  | 'help';

/** All available routes as a constant array */
export const ALL_ROUTES: readonly ModuleRoute[] = [
  'home',
  'orgs',
  'forge',
  'grappe',
  'monitor',
  'seed',
  'sync',
  'compare',
  'dataops',
  'automation',
  'ai',
  'reports',
  'settings',
  'welcome',
  'help',
] as const;

/** Application-level state for routing, sidebar, and extension readiness */
export interface AppState {
  currentRoute: ModuleRoute;
  sidebarCollapsed: boolean;
  isLoading: boolean;
  extensionReady: boolean;
  showWelcome: boolean;
  showWhatsNew: boolean;
  whatsNewVersion: string;
  aiAvailable: boolean;
  navigate: (route: ModuleRoute) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLoading: (loading: boolean) => void;
  setExtensionReady: (ready: boolean) => void;
  setShowWelcome: (show: boolean) => void;
  setShowWhatsNew: (show: boolean, version?: string) => void;
  setAiAvailable: (available: boolean) => void;
}

/** Zustand store for application-level state */
export const useAppStore = create<AppState>((set) => ({
  currentRoute: 'home',
  sidebarCollapsed: false,
  isLoading: false,
  extensionReady: false,
  showWelcome: false,
  showWhatsNew: false,
  whatsNewVersion: '',
  aiAvailable: false,

  navigate(route: ModuleRoute): void {
    set({ currentRoute: route });
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
}));
