import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { HealthCheckPanel } from './HealthCheckPanel';
import type { OrgHealthStatus } from './HealthCheckPanel';

/** Creates a base health status object for tests. */
function createHealthStatus(overrides: Partial<OrgHealthStatus> = {}): OrgHealthStatus {
  return {
    orgId: 'org-1',
    overall: 'healthy',
    apiLimitsStatus: 'ok',
    storageStatus: 'ok',
    activeJobs: 0,
    recentErrors: 0,
    lastChecked: '2026-03-20T10:00:00Z',
    ...overrides,
  };
}

describe('HealthCheckPanel', () => {
  it('renders empty state when no orgHealthStatus', () => {
    render(<HealthCheckPanel />);
    expect(screen.getByTestId('health-check-panel-empty')).toBeDefined();
    expect(screen.getByText('Org Health Check')).toBeDefined();
  });

  it('renders health check data with overall healthy status', () => {
    render(<HealthCheckPanel orgHealthStatus={createHealthStatus({ overall: 'healthy' })} />);
    expect(screen.getByTestId('health-check-panel')).toBeDefined();
    expect(screen.getByText('Healthy')).toBeDefined();
  });

  it('renders degraded status with warning badge', () => {
    render(<HealthCheckPanel orgHealthStatus={createHealthStatus({ overall: 'degraded' })} />);
    expect(screen.getByTestId('health-check-panel')).toBeDefined();
    expect(screen.getByText('Degraded')).toBeDefined();
  });

  it('shows error count and active jobs', () => {
    render(
      <HealthCheckPanel
        orgHealthStatus={createHealthStatus({
          recentErrors: 5,
          activeJobs: 3,
        })}
      />,
    );
    expect(screen.getByTestId('health-check-panel')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });
});
