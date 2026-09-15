import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { LiveOperationSnapshot, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { MonitorPage } from './MonitorPage';

/*
 * Live-operation controls.
 *
 * The operations listed are Seed and Sync runs. Cancel goes out on
 * `execution:abort`, which reaches the AbortController each run registers;
 * `operation:cancel` reached pipeline orchestrators only and answered "No
 * active operation found" for every row. Neither run can pause, so no pause or
 * resume is offered. The abort's reply is read: a run the extension no longer
 * knows is refused, the page says so, and the list is read again either way.
 */

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'monitor' }),
}));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 400, height: 200 }}>{children}</div>
    ),
  };
});

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: vi.fn(),
  postEnvelopedMessage: vi.fn(),
}));

let monitorPayload = {
  limits: [{ name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 }],
  jobs: [],
  healthScore: 78,
  lastUpdated: '2026-09-15T10:00:00.000Z',
};

/** Reads `monitor:live-operations` again. */
const mockLiveOpsRefetch = vi.fn();
const mockAbortMutate = vi.fn();

/** The extension's answer to the last `execution:abort`, as the page sees it. */
let abortReply: { success: boolean; operationId?: string; error?: string } | null = null;

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

const liveOperations = [
  makeOperation({ operationId: 'op-1', status: 'running' }),
  makeOperation({ operationId: 'op-2', module: 'seed', status: 'paused' }),
];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:refresh') {
      return { data: monitorPayload, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'monitor:live-operations') {
      return {
        data: { operations: liveOperations },
        loading: false,
        error: null,
        refetch: mockLiveOpsRefetch,
      };
    }
    if (type === 'monitor:alerts') {
      return { data: { alerts: [] }, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'execution:abort') {
      return {
        mutate: mockAbortMutate,
        data: abortReply,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'DevSandbox',
  username: 'admin@dev.sandbox',
  instanceUrl: 'https://dev-sandbox.salesforce.com',
  orgId: '00D000000000001',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
};

describe('MonitorPage live-operation controls', () => {
  beforeEach(() => {
    vi.mocked(sendBridgeMessage).mockClear();
    mockLiveOpsRefetch.mockClear();
    mockAbortMutate.mockClear();
    abortReply = null;
    monitorPayload = { ...monitorPayload, lastUpdated: '2026-09-15T10:00:00.000Z' };
    useNotificationStore.getState().clearAll();
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [mockOrg] });
  });

  it('cancels the clicked operation on execution:abort, where Seed and Sync runs stop', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('cancel-op-1'));
    expect(mockAbortMutate).toHaveBeenCalledWith({ operationId: 'op-1' });
    expect(sendBridgeMessage).not.toHaveBeenCalledWith('operation:cancel', expect.anything());
  });

  it('offers no pause on a running operation and no resume on a paused one', () => {
    render(<MonitorPage />);
    expect(screen.getByTestId('cancel-op-2')).toBeTruthy();
    expect(screen.queryByTestId('pause-op-1')).toBeNull();
    expect(screen.queryByTestId('resume-op-2')).toBeNull();
  });

  it('warns when the extension refuses the cancel, and reads the list again', () => {
    const { rerender } = render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('cancel-op-1'));

    abortReply = { success: false, error: 'Operation not found: op-1' };
    rerender(<MonitorPage />);

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification?.level).toBe('warning');
    expect(notification?.title).toBe('Could not cancel the operation');
    expect(mockLiveOpsRefetch).toHaveBeenCalledTimes(1);
  });

  it('reads the list again after an accepted cancel, without a warning', () => {
    const { rerender } = render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('cancel-op-1'));

    abortReply = { success: true, operationId: 'op-1' };
    rerender(<MonitorPage />);

    expect(useNotificationStore.getState().notifications).toEqual([]);
    expect(mockLiveOpsRefetch).toHaveBeenCalledTimes(1);
  });

  it('reads the list again on each dashboard refresh, not on the first one', () => {
    const { rerender } = render(<MonitorPage />);
    rerender(<MonitorPage />);
    expect(mockLiveOpsRefetch).not.toHaveBeenCalled();

    monitorPayload = { ...monitorPayload, lastUpdated: '2026-09-15T10:00:30.000Z' };
    rerender(<MonitorPage />);
    expect(mockLiveOpsRefetch).toHaveBeenCalledTimes(1);
  });
});
