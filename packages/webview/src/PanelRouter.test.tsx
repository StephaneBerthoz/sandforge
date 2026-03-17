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
vi.mock('./pages/Reports/ReportsPage', () => ({
  ReportsPage: () => <div data-testid="page-reports">Reports</div>,
}));
vi.mock('./pages/Settings/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="page-settings">Settings</div>,
}));

describe('PanelRouter', () => {
  it('should render MonitorPage for moduleId "monitor"', () => {
    render(<PanelRouter moduleId="monitor" />);
    expect(screen.getByTestId('page-monitor')).toBeDefined();
  });

  it('should render SeedPage for moduleId "seed"', () => {
    render(<PanelRouter moduleId="seed" />);
    expect(screen.getByTestId('page-seed')).toBeDefined();
  });

  it('should render SyncPage for moduleId "sync"', () => {
    render(<PanelRouter moduleId="sync" />);
    expect(screen.getByTestId('page-sync')).toBeDefined();
  });

  it('should render ComparePage for moduleId "compare"', () => {
    render(<PanelRouter moduleId="compare" />);
    expect(screen.getByTestId('page-compare')).toBeDefined();
  });

  it('should render DataOpsPage for moduleId "dataops"', () => {
    render(<PanelRouter moduleId="dataops" />);
    expect(screen.getByTestId('page-dataops')).toBeDefined();
  });

  it('should render AutomationPage for moduleId "automation"', () => {
    render(<PanelRouter moduleId="automation" />);
    expect(screen.getByTestId('page-automation')).toBeDefined();
  });

  it('should render OrgManagerPage for moduleId "orgs"', () => {
    render(<PanelRouter moduleId="orgs" />);
    expect(screen.getByTestId('page-orgs')).toBeDefined();
  });

  it('should render SettingsPage for moduleId "settings"', () => {
    render(<PanelRouter moduleId="settings" />);
    expect(screen.getByTestId('page-settings')).toBeDefined();
  });

  it('should render ReportsPage for moduleId "reports"', () => {
    render(<PanelRouter moduleId="reports" />);
    expect(screen.getByTestId('page-reports')).toBeDefined();
  });

  it('should render unknown module fallback for invalid moduleId', () => {
    render(<PanelRouter moduleId="nonexistent" />);
    expect(screen.getByTestId('panel-unknown')).toBeDefined();
    expect(screen.getByText(/Unknown module: nonexistent/)).toBeDefined();
  });
});
