import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore, ALL_ROUTES } from './useAppStore';
import type { ModuleRoute } from './useAppStore';

function getState(): ReturnType<typeof useAppStore.getState> {
  return useAppStore.getState();
}

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentRoute: 'home',
      sidebarCollapsed: false,
      isLoading: false,
      extensionReady: false,
      showWelcome: false,
      showWhatsNew: false,
      whatsNewVersion: '',
    });
  });

  it('should have correct initial state', () => {
    const state = getState();
    expect(state.currentRoute).toBe('home');
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.extensionReady).toBe(false);
    expect(state.showWelcome).toBe(false);
    expect(state.showWhatsNew).toBe(false);
    expect(state.whatsNewVersion).toBe('');
  });

  it('should navigate to a different route', () => {
    getState().navigate('forge');
    expect(getState().currentRoute).toBe('forge');
  });

  it('should navigate through multiple routes sequentially', () => {
    const routes: ModuleRoute[] = ['orgs', 'grappe', 'settings', 'home'];
    for (const route of routes) {
      getState().navigate(route);
      expect(getState().currentRoute).toBe(route);
    }
  });

  it('should toggle sidebar collapsed state', () => {
    expect(getState().sidebarCollapsed).toBe(false);
    getState().toggleSidebar();
    expect(getState().sidebarCollapsed).toBe(true);
    getState().toggleSidebar();
    expect(getState().sidebarCollapsed).toBe(false);
  });

  it('should set sidebar collapsed to a specific value', () => {
    getState().setSidebarCollapsed(true);
    expect(getState().sidebarCollapsed).toBe(true);
    getState().setSidebarCollapsed(true);
    expect(getState().sidebarCollapsed).toBe(true);
    getState().setSidebarCollapsed(false);
    expect(getState().sidebarCollapsed).toBe(false);
  });

  it('should set loading state', () => {
    getState().setLoading(true);
    expect(getState().isLoading).toBe(true);
    getState().setLoading(false);
    expect(getState().isLoading).toBe(false);
  });

  it('should set extension ready state', () => {
    getState().setExtensionReady(true);
    expect(getState().extensionReady).toBe(true);
    getState().setExtensionReady(false);
    expect(getState().extensionReady).toBe(false);
  });

  it('should expose ALL_ROUTES with all module routes', () => {
    expect(ALL_ROUTES).toHaveLength(14);
    expect(ALL_ROUTES).toContain('home');
    expect(ALL_ROUTES).toContain('orgs');
    expect(ALL_ROUTES).toContain('forge');
    expect(ALL_ROUTES).toContain('grappe');
    expect(ALL_ROUTES).toContain('monitor');
    expect(ALL_ROUTES).toContain('seed');
    expect(ALL_ROUTES).toContain('sync');
    expect(ALL_ROUTES).toContain('compare');
    expect(ALL_ROUTES).toContain('dataops');
    expect(ALL_ROUTES).toContain('automation');
    expect(ALL_ROUTES).toContain('reports');
    expect(ALL_ROUTES).toContain('settings');
    expect(ALL_ROUTES).toContain('welcome');
    expect(ALL_ROUTES).toContain('help');
  });

  it('should allow navigating to every route in ALL_ROUTES', () => {
    for (const route of ALL_ROUTES) {
      getState().navigate(route);
      expect(getState().currentRoute).toBe(route);
    }
  });

  it('should set showWelcome state', () => {
    getState().setShowWelcome(true);
    expect(getState().showWelcome).toBe(true);
    getState().setShowWelcome(false);
    expect(getState().showWelcome).toBe(false);
  });

  it('should set showWhatsNew state with version', () => {
    getState().setShowWhatsNew(true, '1.0.0');
    expect(getState().showWhatsNew).toBe(true);
    expect(getState().whatsNewVersion).toBe('1.0.0');
    getState().setShowWhatsNew(false);
    expect(getState().showWhatsNew).toBe(false);
    expect(getState().whatsNewVersion).toBe('');
  });

  it('should handle multiple state changes independently', () => {
    getState().navigate('monitor');
    getState().setLoading(true);
    getState().setSidebarCollapsed(true);
    getState().setExtensionReady(true);

    const state = getState();
    expect(state.currentRoute).toBe('monitor');
    expect(state.isLoading).toBe(true);
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.extensionReady).toBe(true);
  });
});
