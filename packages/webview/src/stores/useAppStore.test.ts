import { describe, it, expect, expectTypeOf, beforeEach } from 'vitest';
import { useAppStore, ALL_ROUTES } from './useAppStore';
import type { ModuleRoute, NavigationIntent } from './useAppStore';

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
    const routes: ModuleRoute[] = ['orgs', 'reports', 'settings', 'home'];
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
    expect(ALL_ROUTES).toHaveLength(19);
    expect(ALL_ROUTES).toContain('home');
    expect(ALL_ROUTES).toContain('recovery');
    expect(ALL_ROUTES).toContain('orgs');
    expect(ALL_ROUTES).toContain('forge');
    expect(ALL_ROUTES).toContain('frozen');
    expect(ALL_ROUTES).toContain('checkpoint');
    // Grappe's page is retired: its progress is read in the runs it reports on.
    expect(ALL_ROUTES).not.toContain('grappe');
    expect(ALL_ROUTES).toContain('monitor');
    expect(ALL_ROUTES).toContain('seed');
    expect(ALL_ROUTES).toContain('sync');
    expect(ALL_ROUTES).toContain('compare');
    expect(ALL_ROUTES).toContain('dataops');
    expect(ALL_ROUTES).toContain('automation');
    expect(ALL_ROUTES).toContain('migration');
    expect(ALL_ROUTES).toContain('ai');
    expect(ALL_ROUTES).toContain('autopilot');
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

  it("keeps the version last opened with What's New, and forgets it as the panel closes", () => {
    getState().setShowWhatsNew(true, '1.70.0', '1.68.0');
    expect(getState().whatsNewSince).toBe('1.68.0');
    getState().setShowWhatsNew(false);
    expect(getState().whatsNewSince).toBe('');
  });

  it("asks for a stand-in only when Help opens What's New, and forgets it as the panel closes", () => {
    getState().setShowWhatsNew(true, '1.70.1', undefined, true);
    expect(getState().whatsNewStandIn).toBe(true);
    getState().setShowWhatsNew(false);
    expect(getState().whatsNewStandIn).toBe(false);
    getState().setShowWhatsNew(true, '1.70.1', '1.70.0');
    expect(getState().whatsNewStandIn).toBe(false);
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

describe('the landing instructions a page opens with', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home', navigationIntent: null });
  });

  it('carries each instruction to the page it opens, until that page has read it', () => {
    // The steps of Back into service open DataOps on Masking with the
    // objects of the last template, Frozen Dataset on Load into the sandbox,
    // and Checkpoints on a take named for the testers and kept forever.
    getState().navigate('dataops', {
      dataopsTab: 'anonymize',
      maskObjects: ['Contact', 'Lead'],
      targetOrgId: 'org-uat',
    });
    expect(getState().navigationIntent).toEqual({
      route: 'dataops',
      dataopsTab: 'anonymize',
      maskObjects: ['Contact', 'Lead'],
      targetOrgId: 'org-uat',
    });
    getState().clearNavigationIntent();
    expect(getState().navigationIntent).toBeNull();

    getState().navigate('frozen', { frozenTab: 'load', frozenTargetOrgId: 'org-uat' });
    expect(getState().navigationIntent).toEqual({
      route: 'frozen',
      frozenTab: 'load',
      frozenTargetOrgId: 'org-uat',
    });

    getState().navigate('checkpoint', { checkpointName: 'Testers’ start', checkpointKeepDays: 0 });
    expect(getState().navigationIntent).toEqual({
      route: 'checkpoint',
      checkpointName: 'Testers’ start',
      checkpointKeepDays: 0,
    });
  });

  it('carries the pair and the tab of Compare, the tab of Sync, a Seed template, a Help section and a pipeline template', () => {
    getState().navigate('compare', {
      compareSourceOrgId: 'org-prod',
      compareTargetOrgId: 'org-uat',
      compareTab: 'deploy',
    });
    expect(getState().navigationIntent).toMatchObject({
      compareSourceOrgId: 'org-prod',
      compareTargetOrgId: 'org-uat',
      compareTab: 'deploy',
    });
    getState().navigate('sync', { syncTab: 'schedules' });
    expect(getState().navigationIntent).toEqual({ route: 'sync', syncTab: 'schedules' });
    getState().navigate('seed', { seedMode: 'quick-seed', seedTemplateId: 'uat-refresh' });
    expect(getState().navigationIntent).toMatchObject({ seedTemplateId: 'uat-refresh' });
    getState().navigate('help', { helpSection: 'checkpoint' });
    expect(getState().navigationIntent).toEqual({ route: 'help', helpSection: 'checkpoint' });
    getState().navigate('automation', { automationTemplateId: 'tpl-sandbox-refresh' });
    expect(getState().navigationIntent).toEqual({
      route: 'automation',
      automationTemplateId: 'tpl-sandbox-refresh',
    });
  });

  it('forgets an instruction at the next plain navigation, so it never outlives its trip', () => {
    getState().navigate('dataops', { dataopsTab: 'emptying' });
    getState().navigate('recovery');
    expect(getState().currentRoute).toBe('recovery');
    expect(getState().navigationIntent).toBeNull();
  });

  it('names each tab by the ids the pages already use, and Emptying', () => {
    expectTypeOf<NavigationIntent['dataopsTab']>().toEqualTypeOf<
      'backup' | 'restore' | 'anonymize' | 'gdpr' | 'cleanup' | 'quality' | 'emptying' | undefined
    >();
    expectTypeOf<NavigationIntent['frozenTab']>().toEqualTypeOf<'extract' | 'load' | undefined>();
    expectTypeOf<NavigationIntent['compareTab']>().toEqualTypeOf<
      'diff' | 'permissions' | 'objects' | 'drift' | 'deploy' | undefined
    >();
    expectTypeOf<NavigationIntent['syncTab']>().toEqualTypeOf<
      'sync' | 'history' | 'schedules' | 'realtime' | 'conflicts' | undefined
    >();
    expectTypeOf<NavigationIntent['maskObjects']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<NavigationIntent['checkpointKeepDays']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NavigationIntent['frozenTargetOrgId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NavigationIntent['checkpointName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NavigationIntent['compareSourceOrgId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NavigationIntent['compareTargetOrgId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NavigationIntent['seedTemplateId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NavigationIntent['helpSection']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NavigationIntent['automationTemplateId']>().toEqualTypeOf<string | undefined>();
  });
});
