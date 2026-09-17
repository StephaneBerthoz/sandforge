import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveOperationsPanel } from './LiveOperationsPanel';
import type { LiveOperationSnapshot } from '@sandforge/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue: string) => defaultValue,
  }),
}));

function makeOperation(overrides: Partial<LiveOperationSnapshot> = {}): LiveOperationSnapshot {
  return {
    operationId: 'op-1',
    module: 'sync',
    description: 'Syncing Account',
    status: 'running',
    percentage: 50,
    processedRecords: 250,
    totalRecords: 500,
    currentStep: 'Processing batch 3/6',
    startedAt: new Date().toISOString(),
    elapsedMs: 15000,
    recordsPerSecond: 17,
    ...overrides,
  };
}

describe('LiveOperationsPanel', () => {
  it('renders empty state when no operations', () => {
    render(<LiveOperationsPanel operations={[]} />);
    expect(screen.getByTestId('live-ops-empty')).toBeTruthy();
  });

  it('renders operations list', () => {
    const ops = [
      makeOperation({ operationId: 'op-1' }),
      makeOperation({ operationId: 'op-2', module: 'seed', description: 'Seeding Contact' }),
    ];
    render(<LiveOperationsPanel operations={ops} />);
    expect(screen.getByTestId('live-ops-panel')).toBeTruthy();
    expect(screen.getByTestId('live-op-op-1')).toBeTruthy();
    expect(screen.getByTestId('live-op-op-2')).toBeTruthy();
  });

  it('displays active count badge', () => {
    const ops = [
      makeOperation({ operationId: 'op-1', status: 'running' }),
      makeOperation({ operationId: 'op-2', status: 'completed' }),
    ];
    render(<LiveOperationsPanel operations={ops} />);
    expect(screen.getByText('1 active')).toBeTruthy();
  });

  it('offers no pause or resume on a Seed or Sync run, only cancel', () => {
    render(
      <LiveOperationsPanel
        operations={[
          makeOperation({ operationId: 'op-1', module: 'seed', status: 'running' }),
          makeOperation({ operationId: 'op-2', module: 'sync', status: 'running' }),
        ]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pause-op-1')).toBeNull();
    expect(screen.queryByTestId('pause-op-2')).toBeNull();
    expect(screen.queryByTestId('resume-op-1')).toBeNull();
    expect(screen.getByTestId('cancel-op-1')).toBeTruthy();
    expect(screen.getByTestId('cancel-op-2')).toBeTruthy();
  });

  it('shows cancel button for active operations', () => {
    const onCancel = vi.fn();
    render(
      <LiveOperationsPanel
        operations={[makeOperation({ status: 'running' })]}
        onCancel={onCancel}
      />,
    );
    const cancelBtn = screen.getByTestId('cancel-op-1');
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledWith('op-1');
  });

  it('does not show action buttons for completed operations', () => {
    render(
      <LiveOperationsPanel
        operations={[makeOperation({ status: 'completed' })]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('cancel-op-1')).toBeNull();
  });

  it('shows error message for failed operations', () => {
    render(
      <LiveOperationsPanel
        operations={[makeOperation({ status: 'failed', error: 'Connection timeout' })]}
      />,
    );
    expect(screen.getByText('Connection timeout')).toBeTruthy();
  });

  it('displays progress stats', () => {
    render(
      <LiveOperationsPanel
        operations={[
          makeOperation({
            processedRecords: 250,
            totalRecords: 500,
            percentage: 50,
            recordsPerSecond: 17,
          }),
        ]}
      />,
    );
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('17 rec/s')).toBeTruthy();
  });
});

describe('LiveOperationsPanel progress bars', () => {
  it('names each bar after the operation on its row', () => {
    render(
      <LiveOperationsPanel
        operations={[makeOperation({ operationId: 'op-9', description: 'Seeding Contact' })]}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'Seeding Contact' })).toBeDefined();
  });
});
