import React from 'react';
import { useAppStore } from './stores/useAppStore';
import type { ModuleRoute } from './stores/useAppStore';
import { HomePage } from './pages/Home/HomePage';
import { OrgManagerPage } from './pages/OrgManager/OrgManagerPage';
import { MonitorPage } from './pages/Monitor/MonitorPage';
import { ComparePage } from './pages/Compare/ComparePage';
import { DataOpsPage } from './pages/DataOps/DataOpsPage';
import { AutomationPage } from './pages/Automation/AutomationPage';
import { MigrationPage } from './pages/Migration/MigrationPage';
import { ForgePage } from './pages/Forge/ForgePage';
import { FrozenPage } from './pages/Frozen/FrozenPage';
import { GrappePage } from './pages/Grappe/GrappePage';
import { ReportsPage } from './pages/Reports/ReportsPage';
import { SettingsPage } from './pages/Settings/SettingsPage';
import { HelpPage } from './pages/Help/HelpPage';
import { SeedPage } from './pages/Seed/SeedPage';
import { SyncPage } from './pages/Sync/SyncPage';
import { AutopilotPage } from './pages/Autopilot/AutopilotPage';
import { AIPage } from './pages/AI/AIPage';

/** Placeholder for welcome route (handled in App.tsx overlay). */
const WelcomePlaceholder: React.FC = () => null;

/** Route mapping from ModuleRoute to component. */
const routeComponents: Record<ModuleRoute, React.FC> = {
  home: HomePage,
  orgs: OrgManagerPage,
  forge: ForgePage,
  frozen: FrozenPage,
  grappe: GrappePage,
  monitor: MonitorPage,
  seed: SeedPage,
  sync: SyncPage,
  compare: ComparePage,
  dataops: DataOpsPage,
  automation: AutomationPage,
  migration: MigrationPage,
  ai: AIPage,
  autopilot: AutopilotPage,
  reports: ReportsPage,
  settings: SettingsPage,
  welcome: WelcomePlaceholder,
  help: HelpPage,
};

/** State-based router that renders the component for the current route. */
export const Router: React.FC = () => {
  const currentRoute = useAppStore((s) => s.currentRoute);
  const Component = routeComponents[currentRoute];
  return <Component />;
};
