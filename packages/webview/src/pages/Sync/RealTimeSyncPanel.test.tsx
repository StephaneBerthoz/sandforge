import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RealTimePublishingObject } from '@sandforge/shared';
import '../../i18n';
import { RealTimeSyncPanel } from './RealTimeSyncPanel';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** What the host answers `realtime:objects` with, and how the panel asked. */
let objectsAnswer: {
  data: { objects: RealTimePublishingObject[] } | null;
  loading: boolean;
  error: string | null;
};
const queries: Array<{ type: string; payload?: Record<string, unknown>; skip?: boolean }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (
    type: string,
    payload?: Record<string, unknown>,
    options?: { skip?: boolean },
  ) => {
    queries.push({ type, payload, skip: options?.skip });
    return { ...objectsAnswer, refetch: vi.fn() };
  },
}));

/** Mock VirtualList for jsdom (no layout engine). */
vi.mock('../../components/ui/VirtualList', () => ({
  VirtualList: <T,>({
    items,
    renderItem,
    keyExtractor,
  }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    keyExtractor: (item: T, index: number) => string;
  }) => (
    <div data-testid="virtual-list" role="list">
      {items.map((item, index) => (
        <div key={keyExtractor(item, index)} role="listitem">
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  ),
}));

const LEAD: RealTimePublishingObject = {
  objectApiName: 'Lead',
  channel: 'ActivityEngagementVirtualChannel',
  inTarget: true,
  externalIdFields: [],
  syncConfigs: [],
};

const orgs = { sourceOrgId: 'org-src-001', targetOrgId: 'org-tgt-001' };

/** Types of the messages the panel posted, unwrapped from their envelopes. */
function sentTypes(): string[] {
  return mockPostMessage.mock.calls.map(
    ([envelope]) => (envelope as { payload: { type: string } }).payload.type,
  );
}

describe('RealTimeSyncPanel', () => {
  beforeEach(() => {
    useCDCLiveStore.getState().reset();
    mockPostMessage.mockClear();
    queries.length = 0;
    objectsAnswer = { data: { objects: [LEAD] }, loading: false, error: null };
  });

  it('asks the host which objects the source publishes, for the pair picked', () => {
    render(<RealTimeSyncPanel {...orgs} />);

    expect(queries[0]).toEqual({ type: 'realtime:objects', payload: orgs, skip: false });
    expect(screen.getByTestId('cdc-object-checkbox-Lead')).toBeDefined();
    expect(screen.getByTestId('cdc-event-feed')).toBeDefined();
  });

  it('asks what session runs, since one outlives the panel', () => {
    render(<RealTimeSyncPanel {...orgs} />);

    expect(sentTypes()).toContain('realtime:status');
  });

  it('carries the org pair into the store it starts from', () => {
    render(<RealTimeSyncPanel {...orgs} />);

    expect(useCDCLiveStore.getState().sourceOrgId).toBe('org-src-001');
    expect(useCDCLiveStore.getState().targetOrgId).toBe('org-tgt-001');
  });

  it('asks nothing until both orgs are picked, and says so', () => {
    render(<RealTimeSyncPanel sourceOrgId="org-src-001" targetOrgId="" />);

    expect(queries[0].skip).toBe(true);
    expect(screen.getByTestId('realtime-pick-orgs').textContent).toBe(
      'Pick a source org and a target org on the Sync tab first.',
    );
    expect(screen.queryByTestId('cdc-subscription-panel')).toBeNull();
  });

  it('says why nothing can be watched when the source publishes nothing', () => {
    objectsAnswer = { data: { objects: [] }, loading: false, error: null };
    render(<RealTimeSyncPanel {...orgs} />);

    const empty = screen.getByTestId('realtime-no-publishing');
    expect(empty.textContent).toContain(
      'No object publishes change events on the source org: its Change Data Capture selection is empty.',
    );
    expect(empty.textContent).toContain('Setup → Change Data Capture');
    expect(screen.queryByTestId('cdc-subscription-panel')).toBeNull();
  });

  it('shows the org’s answer when it would not say what publishes', () => {
    objectsAnswer = {
      data: null,
      loading: false,
      error: "sObject type 'PlatformEventChannelMember' is not supported.",
    };
    render(<RealTimeSyncPanel {...orgs} />);

    expect(screen.getByTestId('realtime-objects-error').textContent).toContain(
      "sObject type 'PlatformEventChannelMember' is not supported.",
    );
  });

  it('lists the objects the org refused, in its words, and how to enable them', () => {
    useCDCLiveStore.setState({
      status: 'syncing',
      refused: [
        {
          objectApiName: 'Account',
          reason: '403::User not allowed to subscribe CDC without required permissions',
        },
      ],
    });
    render(<RealTimeSyncPanel {...orgs} />);

    const refused = screen.getByTestId('realtime-refused');
    expect(refused.textContent).toContain(
      'Account: 403::User not allowed to subscribe CDC without required permissions',
    );
    expect(refused.textContent).toContain('Setup → Change Data Capture');
  });

  it('shows why a session stopped working, and what it settled for', () => {
    useCDCLiveStore.setState({
      status: 'error',
      error: 'The connection to the source org was closed (401::Authentication invalid).',
      notes: ['Lead: every change the org still holds is replayed.'],
    });
    render(<RealTimeSyncPanel {...orgs} />);

    expect(screen.getByTestId('realtime-session-error').textContent).toContain(
      '401::Authentication invalid',
    );
    expect(screen.getByTestId('realtime-notes').textContent).toContain(
      'every change the org still holds is replayed',
    );
  });
});
