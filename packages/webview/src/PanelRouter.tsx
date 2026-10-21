import React, { Suspense, lazy } from 'react';
import { withEnglish, type EnglishNamespace } from './i18n/englishNamespaces';

/**
 * A page loaded the first time its route is shown, with the namespaces of the
 * English catalogue it renders beyond the shell's.
 *
 * Every panel shows one module, and loaded all seventeen: one 2.7 MB bundle
 * holding Forge, the charts of Monitor and Reports and the graph library of
 * Forge, Autopilot and Reports, parsed before the Organizations page or Settings
 * could paint. Each page is now a chunk of its own, fetched from the panel's
 * `webview-dist` by the module script the shell loads, so a panel parses the
 * code shared by every page and its own page's — and its own page's English:
 * the whole catalogue was in the code every page shares. A namespace named
 * here and not rendered is parsed for nothing, one rendered and not named
 * shows its keys: src/PanelRouter.english.test.ts reads each list against
 * the keys its page spells, and the parts it loads on demand.
 */
function page<K extends string>(
  load: () => Promise<Record<K, React.FC>>,
  name: K,
  english: readonly EnglishNamespace[],
): React.LazyExoticComponent<React.FC> {
  return lazy(() => withEnglish(load, english)().then((module) => ({ default: module[name] })));
}

/** Map of module IDs to their page components. */
const panelComponents: Record<string, React.LazyExoticComponent<React.FC>> = {
  home: page(() => import('./pages/Home/HomePage'), 'HomePage', [
    'errors',
    'forge',
    'moduleSummary',
    'onboarding',
    'org',
    'seed',
    'status',
  ]),
  orgs: page(() => import('./pages/OrgManager/OrgManagerPage'), 'OrgManagerPage', [
    'auth',
    'errors',
    'monitor',
    'org',
    'seed',
    'sidePanel',
  ]),
  forge: page(() => import('./pages/Forge/ForgePage'), 'ForgePage', [
    'ai',
    'emptyState',
    'errors',
    'forge',
    'frozen',
    'list',
    'moduleSummary',
    'org',
    'seed',
  ]),
  frozen: page(() => import('./pages/Frozen/FrozenPage'), 'FrozenPage', [
    'errors',
    'forge',
    'frozen',
    'org',
    'seed',
  ]),
  grappe: page(() => import('./pages/Grappe/GrappePage'), 'GrappePage', ['grappe']),
  monitor: page(() => import('./pages/Monitor/MonitorPage'), 'MonitorPage', [
    'emptyState',
    'errors',
    'governance',
    'monitor',
    'org',
    'reports',
    'seed',
    'sidePanel',
    'sync',
  ]),
  compare: page(() => import('./pages/Compare/ComparePage'), 'ComparePage', [
    'compare',
    'emptyState',
    'errors',
    'list',
    'org',
    'seed',
    'sidePanel',
  ]),
  dataops: page(() => import('./pages/DataOps/DataOpsPage'), 'DataOpsPage', [
    'dataops',
    'emptyState',
    'errors',
    'org',
    'seed',
  ]),
  automation: page(() => import('./pages/Automation/AutomationPage'), 'AutomationPage', [
    'ai',
    'automation',
    'compare',
    'dataops',
    'errors',
    'org',
    'seed',
    'sidePanel',
    'sync',
  ]),
  migration: page(() => import('./pages/Migration/MigrationPage'), 'MigrationPage', [
    'automation',
    'errors',
    'migration',
    'org',
    'seed',
    'sync',
  ]),
  reports: page(() => import('./pages/Reports/ReportsContainer'), 'ReportsContainer', [
    'errors',
    'org',
    'reports',
    'seed',
  ]),
  settings: page(() => import('./pages/Settings/SettingsPage'), 'SettingsPage', [
    'config',
    'errors',
    'org',
    'seed',
    'settings',
  ]),
  help: page(() => import('./pages/Help/HelpPage'), 'HelpPage', [
    'help',
    'moduleSummary',
    'onboarding',
  ]),
  // Legacy routes (kept for backwards compat)
  seed: page(() => import('./pages/Seed/SeedPage'), 'SeedPage', [
    'emptyState',
    'errors',
    'forge',
    'frozen',
    'grappe',
    'help',
    'list',
    'moduleSummary',
    'org',
    'pagination',
    'seed',
    'sidePanel',
    'sync',
  ]),
  sync: page(() => import('./pages/Sync/SyncPage'), 'SyncPage', [
    'automation',
    'emptyState',
    'errors',
    'forge',
    'frozen',
    'grappe',
    'list',
    'onboarding',
    'org',
    'pagination',
    'quickSync',
    'reports',
    'seed',
    'sidePanel',
    'sync',
  ]),
  autopilot: page(() => import('./pages/Autopilot/AutopilotPage'), 'AutopilotPage', [
    'autopilot',
    'emptyState',
    'errors',
    'forge',
    'grappe',
    'moduleSummary',
    'org',
    'seed',
  ]),
  ai: page(() => import('./pages/AI/AIPage'), 'AIPage', ['ai', 'errors']),
};

/** Props for PanelRouter. */
export interface PanelRouterProps {
  moduleId: string;
}

/**
 * Renders the page component for a given moduleId.
 * Used inside WebviewPanels to display a single module at full width.
 */
export const PanelRouter: React.FC<PanelRouterProps> = ({ moduleId }) => {
  const Component = panelComponents[moduleId];

  if (!Component) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="panel-unknown">
        <p className="text-(--sf-text-secondary)">Unknown module: {moduleId}</p>
      </div>
    );
  }

  return (
    // The chunk is read from the extension's own folder: the wait is a few
    // milliseconds, too short for a message to be worth reading.
    <Suspense fallback={<div className="h-full" aria-busy="true" data-testid="panel-loading" />}>
      <Component />
    </Suspense>
  );
};
