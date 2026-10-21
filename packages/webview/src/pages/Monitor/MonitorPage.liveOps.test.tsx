import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { LiveOperationSnapshot, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { MonitorPage } from './MonitorPage';

/*
 * Live-operation controls.
 *
 * The operations listed are Seed and Sync runs. Cancel goes out on
 * `execution:abort`, which reaches the AbortController each run registers.
 * A Sync run can be paused and resumed as well, on `sync:pause` and
 * `sync:resume`, the channels its page uses; the extension marks it
 * `pausable`, and a run it does not mark — a seed, a sync's simulation — is
 * offered neither. Every reply is read: a run the extension no longer knows
 * is refused, the page says so, and the list is read again either way.
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

const mockPauseMutate = vi.fn();
const mockResumeMutate = vi.fn();
const mockResumeRunMutate = vi.fn();

/** The code of the extension's refusal of the last `forge:resume-run`, as the page sees it. */
let resumeRunCode: string | null = null;

/** The extension's answer to the last `sync:pause`, as the page sees it. */
let pauseReply: { success: boolean; operationId: string; paused: boolean; error?: string } | null =
  null;

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
  makeOperation({ operationId: 'op-1', status: 'running', pausable: true }),
  makeOperation({ operationId: 'op-2', module: 'seed', status: 'paused' }),
  makeOperation({ operationId: 'op-3', status: 'paused', pausable: true }),
  makeOperation({ operationId: 'op-4', description: 'Simulation of a sync', status: 'running' }),
  makeOperation({
    operationId: 'op-5',
    module: 'forge',
    description: 'Executing forge operation',
    status: 'cancelled',
    resumeRun: 'forge-77',
  }),
];

/** The query's answer, one object as a hook's state is: a new one each render read as a new answer. */
const liveOpsAnswer = { operations: liveOperations };

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:refresh') {
      return { data: monitorPayload, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'monitor:live-operations') {
      return {
        data: liveOpsAnswer,
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
    if (type === 'sync:pause') {
      return {
        mutate: mockPauseMutate,
        data: pauseReply,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    if (type === 'sync:resume') {
      return { mutate: mockResumeMutate, data: null, loading: false, error: null, reset: vi.fn() };
    }
    if (type === 'forge:resume-run') {
      return {
        mutate: mockResumeRunMutate,
        data: null,
        loading: false,
        error: resumeRunCode ? 'refused' : null,
        errorCode: resumeRunCode,
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
    mockLiveOpsRefetch.mockClear();
    mockAbortMutate.mockClear();
    mockPauseMutate.mockClear();
    mockResumeMutate.mockClear();
    mockResumeRunMutate.mockClear();
    resumeRunCode = null;
    abortReply = null;
    pauseReply = null;
    monitorPayload = { ...monitorPayload, lastUpdated: '2026-09-15T10:00:00.000Z' };
    useNotificationStore.getState().clearAll();
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [mockOrg] });
  });

  it('cancels the clicked operation on execution:abort, where Seed and Sync runs stop', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('cancel-op-1'));
    expect(mockAbortMutate).toHaveBeenCalledWith({ operationId: 'op-1' });
  });

  it('pauses a running sync on sync:pause, the channel its page uses', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('pause-op-1'));
    expect(mockPauseMutate).toHaveBeenCalledWith({ operationId: 'op-1' });
    expect(screen.queryByTestId('resume-op-1')).toBeNull();
  });

  it('resumes a paused sync on sync:resume', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('resume-op-3'));
    expect(mockResumeMutate).toHaveBeenCalledWith({ operationId: 'op-3' });
    expect(screen.queryByTestId('pause-op-3')).toBeNull();
  });

  it('offers no pause nor resume on a run the extension does not say can pause', () => {
    // A paused seed, and a sync's simulation, which has no pause.
    render(<MonitorPage />);
    expect(screen.getByTestId('cancel-op-2')).toBeTruthy();
    expect(screen.queryByTestId('resume-op-2')).toBeNull();
    expect(screen.queryByTestId('pause-op-2')).toBeNull();
    expect(screen.getByTestId('cancel-op-4')).toBeTruthy();
    expect(screen.queryByTestId('pause-op-4')).toBeNull();
  });

  it('takes a stopped clone up on forge:resume-run, by the run it names, and reads the list again', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('resume-run-op-5'));
    expect(mockResumeRunMutate).toHaveBeenCalledWith({ forgeId: 'forge-77' });
    expect(mockLiveOpsRefetch).toHaveBeenCalledTimes(1);
  });

  it('says why the extension refused to take the clone up', () => {
    const { rerender } = render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('resume-run-op-5'));

    resumeRunCode = 'RESUME_TARGET_CHANGED';
    rerender(<MonitorPage />);

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification?.level).toBe('warning');
    expect(notification?.title).toBe('The clone could not be taken up');
    expect(notification?.message).toMatch(/^The org this run wrote to is no longer the one it was/);
  });

  it('warns when the extension refuses the pause, and reads the list again', () => {
    const { rerender } = render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('pause-op-1'));

    pauseReply = {
      success: false,
      operationId: 'op-1',
      paused: false,
      error: 'No sync with this id is running',
    };
    rerender(<MonitorPage />);

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification?.level).toBe('warning');
    expect(notification?.title).toBe('Could not pause or resume the run');
    expect(mockLiveOpsRefetch).toHaveBeenCalledTimes(1);
  });

  it('reads the list again after an accepted pause, without a warning', () => {
    const { rerender } = render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('pause-op-1'));

    pauseReply = { success: true, operationId: 'op-1', paused: true };
    rerender(<MonitorPage />);

    expect(useNotificationStore.getState().notifications).toEqual([]);
    expect(mockLiveOpsRefetch).toHaveBeenCalledTimes(1);
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

  it('shows the list the extension pushes as runs start and end, with no refresh of the org', () => {
    render(<MonitorPage />);
    expect(screen.queryByTestId('cancel-op-9')).toBeNull();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'ext-push-1',
            type: 'monitor:live-operations:changed',
            timestamp: Date.now(),
            payload: {
              operations: [
                makeOperation({
                  operationId: 'op-9',
                  module: 'autopilot',
                  description: 'Autopilot run',
                }),
              ],
            },
          },
        }),
      );
    });

    // A run started after the Monitor opened is listed, with its Cancel, and
    // its module read by the navigation's name.
    expect(screen.getByTestId('cancel-op-9')).toBeTruthy();
    expect(screen.getByText('Autopilot')).toBeTruthy();
    // The list it replaced is gone: op-1 ended meanwhile.
    expect(screen.queryByTestId('cancel-op-1')).toBeNull();
    expect(mockLiveOpsRefetch).not.toHaveBeenCalled();
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
