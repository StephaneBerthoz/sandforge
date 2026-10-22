import React, { Suspense, lazy, useEffect, useState } from 'react';
import { withEnglish, type EnglishNamespace } from './i18n/englishNamespaces';
import { Spinner } from './components/ui/Spinner';

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
    'moduleSummary',
    'status',
  ]),
  orgs: page(() => import('./pages/OrgManager/OrgManagerPage'), 'OrgManagerPage', [
    'auth',
    'errors',
    'org',
  ]),
  forge: page(() => import('./pages/Forge/ForgePage'), 'ForgePage', [
    'ai',
    'emptyState',
    'errors',
    'forge',
    'moduleSummary',
    'orgAutomation',
    'runRemoval',
    'runResults',
  ]),
  frozen: page(() => import('./pages/Frozen/FrozenPage'), 'FrozenPage', [
    'errors',
    'frozen',
    'orgAutomation',
    'runRemoval',
    'runResults',
  ]),
  grappe: page(() => import('./pages/Grappe/GrappePage'), 'GrappePage', ['grappe']),
  monitor: page(() => import('./pages/Monitor/MonitorPage'), 'MonitorPage', [
    'emptyState',
    'errors',
    'governance',
    'monitor',
  ]),
  compare: page(() => import('./pages/Compare/ComparePage'), 'ComparePage', [
    'compare',
    'emptyState',
    'errors',
    'list',
  ]),
  dataops: page(() => import('./pages/DataOps/DataOpsPage'), 'DataOpsPage', [
    'dataops',
    'emptyState',
    'errors',
  ]),
  automation: page(() => import('./pages/Automation/AutomationPage'), 'AutomationPage', [
    'ai',
    'automation',
    'compare',
    'errors',
    'sync',
  ]),
  migration: page(() => import('./pages/Migration/MigrationPage'), 'MigrationPage', [
    'errors',
    'migration',
    'sync',
  ]),
  reports: page(() => import('./pages/Reports/ReportsContainer'), 'ReportsContainer', [
    'errors',
    'reports',
  ]),
  settings: page(() => import('./pages/Settings/SettingsPage'), 'SettingsPage', [
    'config',
    'errors',
    'settings',
  ]),
  help: page(() => import('./pages/Help/HelpPage'), 'HelpPage', ['help', 'moduleSummary']),
  // Legacy routes (kept for backwards compat)
  seed: page(() => import('./pages/Seed/SeedPage'), 'SeedPage', [
    'emptyState',
    'errors',
    'grappe',
    'list',
    'moduleSummary',
    'orgAutomation',
    'pagination',
    'runRemoval',
    'runResults',
    'seed',
  ]),
  sync: page(() => import('./pages/Sync/SyncPage'), 'SyncPage', [
    'emptyState',
    'errors',
    'grappe',
    'list',
    'orgAutomation',
    'pagination',
    'quickSync',
    'runRemoval',
    'runResults',
    'sync',
  ]),
  autopilot: page(() => import('./pages/Autopilot/AutopilotPage'), 'AutopilotPage', [
    'autopilot',
    'emptyState',
    'errors',
    'grappe',
    'moduleSummary',
    'runResults',
  ]),
  ai: page(() => import('./pages/AI/AIPage'), 'AIPage', ['ai', 'errors']),
};

/** How long a page's chunk is waited for before the wait is shown. */
const PAGE_WAIT_SHOWN_AFTER_MS = 300;

/**
 * What a page shows while its chunk loads: nothing at first, then a spinner.
 * From a local disk the wait is a few milliseconds, too short for anything
 * to be worth drawing; on a remote workspace each round of fetches is a
 * network round trip, and the panel stayed empty with no sign that it was
 * loading.
 */
const PageLoading: React.FC = () => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), PAGE_WAIT_SHOWN_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      className="h-full flex items-center justify-center"
      aria-busy="true"
      data-testid="panel-loading"
    >
      {shown && <Spinner size="lg" />}
    </div>
  );
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
    <Suspense fallback={<PageLoading />}>
      <Component />
    </Suspense>
  );
};
