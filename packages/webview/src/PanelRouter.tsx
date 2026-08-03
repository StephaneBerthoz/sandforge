import React from 'react';
import { OrgManagerPage } from './pages/OrgManager/OrgManagerPage';
import { MonitorPage } from './pages/Monitor/MonitorPage';
import { ComparePage } from './pages/Compare/ComparePage';
import { SeedPage } from './pages/Seed/SeedPage';
import { SyncPage } from './pages/Sync/SyncPage';
import { DataOpsPage } from './pages/DataOps/DataOpsPage';
import { AutomationPage } from './pages/Automation/AutomationPage';
import { ReportsPage } from './pages/Reports/ReportsPage';
import { SettingsPage } from './pages/Settings/SettingsPage';
import { HelpPage } from './pages/Help/HelpPage';
import { ForgePage } from './pages/Forge/ForgePage';
import { FrozenPage } from './pages/Frozen/FrozenPage';
import { GrappePage } from './pages/Grappe/GrappePage';
import { AutopilotPage } from './pages/Autopilot/AutopilotPage';
import { AIPage } from './pages/AI/AIPage';
import { HomePage } from './pages/Home/HomePage';

/** Map of module IDs to their page components. */
const panelComponents: Record<string, React.FC> = {
  home: HomePage,
  orgs: OrgManagerPage,
  forge: ForgePage,
  frozen: FrozenPage,
  grappe: GrappePage,
  monitor: MonitorPage,
  compare: ComparePage,
  dataops: DataOpsPage,
  automation: AutomationPage,
  reports: ReportsPage,
  settings: SettingsPage,
  help: HelpPage,
  // Legacy routes (kept for backwards compat)
  seed: SeedPage,
  sync: SyncPage,
  autopilot: AutopilotPage,
  ai: AIPage,
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
        <p className="text-[var(--vscode-descriptionForeground,#868686)]">
          Unknown module: {moduleId}
        </p>
      </div>
    );
  }

  return <Component />;
};
