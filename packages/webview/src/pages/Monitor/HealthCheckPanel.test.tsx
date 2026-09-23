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
    failedJobs: 0,
    recentErrorLogs: 0,
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

  it('shows the failed jobs and error logs the refresh counted, under count labels', () => {
    render(
      <HealthCheckPanel
        orgHealthStatus={createHealthStatus({
          recentErrorLogs: 5,
          failedJobs: 3,
        })}
      />,
    );
    expect(screen.getByTestId('health-check-panel')).toBeDefined();
    expect(screen.getByText('Failed Jobs')).toBeDefined();
    expect(screen.getByText('Recent Error Logs')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('says how many of the latest jobs the failed ones were counted among', () => {
    // A bare "3" read as the org's total: the refresh reads the latest jobs only.
    render(
      <HealthCheckPanel
        orgHealthStatus={createHealthStatus({ failedJobs: 3, failedJobsOutOf: 50 })}
      />,
    );

    expect(screen.getByTestId('health-failed-jobs-out-of').textContent).toBe(
      'of the 50 latest jobs',
    );
  });

  it('gives no window for failed jobs that could not be read', () => {
    render(
      <HealthCheckPanel
        orgHealthStatus={createHealthStatus({ failedJobs: null, failedJobsOutOf: null })}
      />,
    );

    expect(screen.queryByTestId('health-failed-jobs-out-of')).toBeNull();
  });
});

describe('HealthCheckPanel — what could not be read', () => {
  it('says unknown, not healthy, and marks the counts not read', () => {
    // An org the monitor could not read used to come out "healthy, 100",
    // with zero failed jobs and zero errors.
    render(
      <HealthCheckPanel
        orgHealthStatus={createHealthStatus({
          overall: 'unknown',
          apiLimitsStatus: 'unknown',
          storageStatus: 'unknown',
          failedJobs: null,
          recentErrorLogs: null,
        })}
      />,
    );
    expect(screen.getByText('Unknown')).toBeDefined();
    expect(screen.getAllByText('Not read')).toHaveLength(2);
    expect(screen.getAllByText('not read')).toHaveLength(2);
  });

  it('names each signal through the catalogue, not as a raw code', () => {
    // The badges printed `ok` and `warning` as they came, in every language.
    render(
      <HealthCheckPanel
        orgHealthStatus={createHealthStatus({ overall: 'degraded', apiLimitsStatus: 'warning' })}
      />,
    );
    expect(screen.getByText('Warning')).toBeDefined();
    expect(screen.queryByText('warning')).toBeNull();
  });
});
