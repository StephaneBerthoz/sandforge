import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelRouter } from './PanelRouter';

vi.mock('./pages/OrgManager/OrgManagerPage', () => ({
  OrgManagerPage: () => <div data-testid="page-orgs">OrgManager</div>,
}));
vi.mock('./pages/Monitor/MonitorPage', () => ({
  MonitorPage: () => <div data-testid="page-monitor">Monitor</div>,
}));
vi.mock('./pages/Compare/ComparePage', () => ({
  ComparePage: () => <div data-testid="page-compare">Compare</div>,
}));
vi.mock('./pages/Seed/SeedPage', () => ({
  SeedPage: () => <div data-testid="page-seed">Seed</div>,
}));
vi.mock('./pages/Sync/SyncPage', () => ({
  SyncPage: () => <div data-testid="page-sync">Sync</div>,
}));
vi.mock('./pages/DataOps/DataOpsPage', () => ({
  DataOpsPage: () => <div data-testid="page-dataops">DataOps</div>,
}));
vi.mock('./pages/Automation/AutomationPage', () => ({
  AutomationPage: () => <div data-testid="page-automation">Automation</div>,
}));
// The router loads the reports route through ReportsContainer: mocking the
// page alone left the container and its dependencies to load for real, past a
// CI runner's wait.
vi.mock('./pages/Reports/ReportsContainer', () => ({
  ReportsContainer: () => <div data-testid="page-reports">Reports</div>,
}));
vi.mock('./pages/Settings/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="page-settings">Settings</div>,
}));

describe('PanelRouter', () => {
  it('should render MonitorPage for moduleId "monitor"', async () => {
    render(<PanelRouter moduleId="monitor" />);
    expect(await screen.findByTestId('page-monitor')).toBeDefined();
  });

  it('should render SeedPage for moduleId "seed"', async () => {
    render(<PanelRouter moduleId="seed" />);
    expect(await screen.findByTestId('page-seed')).toBeDefined();
  });

  it('should render SyncPage for moduleId "sync"', async () => {
    render(<PanelRouter moduleId="sync" />);
    expect(await screen.findByTestId('page-sync')).toBeDefined();
  });

  it('should render ComparePage for moduleId "compare"', async () => {
    render(<PanelRouter moduleId="compare" />);
    expect(await screen.findByTestId('page-compare')).toBeDefined();
  });

  it('should render DataOpsPage for moduleId "dataops"', async () => {
    render(<PanelRouter moduleId="dataops" />);
    expect(await screen.findByTestId('page-dataops')).toBeDefined();
  });

  it('should render AutomationPage for moduleId "automation"', async () => {
    render(<PanelRouter moduleId="automation" />);
    expect(await screen.findByTestId('page-automation')).toBeDefined();
  });

  it('should render OrgManagerPage for moduleId "orgs"', async () => {
    render(<PanelRouter moduleId="orgs" />);
    expect(await screen.findByTestId('page-orgs')).toBeDefined();
  });

  it('should render SettingsPage for moduleId "settings"', async () => {
    render(<PanelRouter moduleId="settings" />);
    expect(await screen.findByTestId('page-settings')).toBeDefined();
  });

  it('should render ReportsPage for moduleId "reports"', async () => {
    render(<PanelRouter moduleId="reports" />);
    // The route loads the real ReportsContainer, only its page mocked: the
    // first import of its modules took 0.87 to 1.35 s here alone, about the
    // 1 s a find waits unless told, and failed two runs in three.
    expect(await screen.findByTestId('page-reports', {}, { timeout: 5_000 })).toBeDefined();
  });

  it('should render unknown module fallback for invalid moduleId', () => {
    render(<PanelRouter moduleId="nonexistent" />);
    expect(screen.getByTestId('panel-unknown')).toBeDefined();
    expect(screen.getByText(/Unknown module: nonexistent/)).toBeDefined();
  });
});
