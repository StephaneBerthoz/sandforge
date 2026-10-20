import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Which pages a panel loads. Each stand-in page notes when its module is
 * evaluated: a router that imports its pages up front evaluates all of them
 * the moment it is imported, which is what every panel paid for — Forge,
 * Monitor's charts and Reports' graph included — before showing one page.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(route: string, exportName: string) {
  evaluated.add(route);
  return { [exportName]: () => <div data-testid={`page-${route}`}>{route}</div> };
}

vi.mock('./pages/Home/HomePage', () => stand('home', 'HomePage'));
vi.mock('./pages/OrgManager/OrgManagerPage', () => stand('orgs', 'OrgManagerPage'));
vi.mock('./pages/Forge/ForgePage', () => stand('forge', 'ForgePage'));
vi.mock('./pages/Frozen/FrozenPage', () => stand('frozen', 'FrozenPage'));
vi.mock('./pages/Grappe/GrappePage', () => stand('grappe', 'GrappePage'));
vi.mock('./pages/Monitor/MonitorPage', () => stand('monitor', 'MonitorPage'));
vi.mock('./pages/Compare/ComparePage', () => stand('compare', 'ComparePage'));
vi.mock('./pages/DataOps/DataOpsPage', () => stand('dataops', 'DataOpsPage'));
vi.mock('./pages/Automation/AutomationPage', () => stand('automation', 'AutomationPage'));
vi.mock('./pages/Migration/MigrationPage', () => stand('migration', 'MigrationPage'));
vi.mock('./pages/Reports/ReportsContainer', () => stand('reports', 'ReportsContainer'));
vi.mock('./pages/Settings/SettingsPage', () => stand('settings', 'SettingsPage'));
vi.mock('./pages/Help/HelpPage', () => stand('help', 'HelpPage'));
vi.mock('./pages/Seed/SeedPage', () => stand('seed', 'SeedPage'));
vi.mock('./pages/Sync/SyncPage', () => stand('sync', 'SyncPage'));
vi.mock('./pages/Autopilot/AutopilotPage', () => stand('autopilot', 'AutopilotPage'));
vi.mock('./pages/AI/AIPage', () => stand('ai', 'AIPage'));

import { PanelRouter } from './PanelRouter';

describe('PanelRouter loading', () => {
  it('loads no page until a route is shown, then the page of that route only', async () => {
    expect([...evaluated]).toEqual([]);

    const { rerender } = render(<PanelRouter moduleId="orgs" />);
    expect(screen.getByTestId('panel-loading').getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByTestId('page-orgs')).toBeDefined();
    expect([...evaluated]).toEqual(['orgs']);

    // A panel navigated to another module loads that one when it is shown.
    rerender(<PanelRouter moduleId="forge" />);
    expect(await screen.findByTestId('page-forge')).toBeDefined();
    expect([...evaluated].sort()).toEqual(['forge', 'orgs']);
  });
});
