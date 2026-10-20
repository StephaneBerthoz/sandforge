import React, { Suspense, lazy } from 'react';

/**
 * A page loaded the first time its route is shown.
 *
 * Every panel shows one module, and loaded all seventeen: one 2.7 MB bundle
 * holding Forge, the charts of Monitor and Reports and the graph library of
 * Forge, Autopilot and Reports, parsed before the Organizations page or Settings
 * could paint. Each page is now a chunk of its own, fetched from the panel's
 * `webview-dist` by the module script the shell loads, so a panel parses the
 * code shared by every page and its own page's.
 */
function page<K extends string>(
  load: () => Promise<Record<K, React.FC>>,
  name: K,
): React.LazyExoticComponent<React.FC> {
  return lazy(() => load().then((module) => ({ default: module[name] })));
}

/** Map of module IDs to their page components. */
const panelComponents: Record<string, React.LazyExoticComponent<React.FC>> = {
  home: page(() => import('./pages/Home/HomePage'), 'HomePage'),
  orgs: page(() => import('./pages/OrgManager/OrgManagerPage'), 'OrgManagerPage'),
  forge: page(() => import('./pages/Forge/ForgePage'), 'ForgePage'),
  frozen: page(() => import('./pages/Frozen/FrozenPage'), 'FrozenPage'),
  grappe: page(() => import('./pages/Grappe/GrappePage'), 'GrappePage'),
  monitor: page(() => import('./pages/Monitor/MonitorPage'), 'MonitorPage'),
  compare: page(() => import('./pages/Compare/ComparePage'), 'ComparePage'),
  dataops: page(() => import('./pages/DataOps/DataOpsPage'), 'DataOpsPage'),
  automation: page(() => import('./pages/Automation/AutomationPage'), 'AutomationPage'),
  migration: page(() => import('./pages/Migration/MigrationPage'), 'MigrationPage'),
  reports: page(() => import('./pages/Reports/ReportsContainer'), 'ReportsContainer'),
  settings: page(() => import('./pages/Settings/SettingsPage'), 'SettingsPage'),
  help: page(() => import('./pages/Help/HelpPage'), 'HelpPage'),
  // Legacy routes (kept for backwards compat)
  seed: page(() => import('./pages/Seed/SeedPage'), 'SeedPage'),
  sync: page(() => import('./pages/Sync/SyncPage'), 'SyncPage'),
  autopilot: page(() => import('./pages/Autopilot/AutopilotPage'), 'AutopilotPage'),
  ai: page(() => import('./pages/AI/AIPage'), 'AIPage'),
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
