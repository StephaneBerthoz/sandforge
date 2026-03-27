import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { CDCEventFeed } from './CDCEventFeed';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import type { CDCFeedEvent } from '../../stores/useCDCLiveStore';

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/**
 * Mock VirtualList to render all items directly (jsdom has no layout engine).
 */
vi.mock('../../components/ui/VirtualList', () => ({
  VirtualList: <T,>({ items, renderItem, keyExtractor, emptyMessage }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    keyExtractor: (item: T, index: number) => string;
    emptyMessage?: string;
  }) => {
    if (items.length === 0) {
      return <div data-testid="virtual-list">{emptyMessage ?? 'No items'}</div>;
    }
    return (
      <div data-testid="virtual-list" role="list">
        {items.map((item, index) => (
          <div key={keyExtractor(item, index)} role="listitem">
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    );
  },
}));

function makeMockEvent(replayId: number, overrides?: Partial<CDCFeedEvent>): CDCFeedEvent {
  return {
    replayId,
    objectApiName: 'Account',
    changeType: 'UPDATE',
    recordIds: [`001${String(replayId).padStart(15, '0')}`],
    commitTimestamp: new Date().toISOString(),
    changedFields: { Name: `Test ${replayId}` },
    commitUser: '005xx000001Sv0p',
    applied: false,
    ...overrides,
  };
}

describe('CDCEventFeed', () => {
  beforeEach(() => {
    useCDCLiveStore.getState().reset();
  });

  it('should render empty state when no events', () => {
    render(<CDCEventFeed />);
    expect(screen.getByTestId('cdc-event-feed')).toBeDefined();
    expect(screen.getByText(/No events yet/)).toBeDefined();
  });

  it('should render event rows with correct data', () => {
    useCDCLiveStore.getState().pushEvents([
      makeMockEvent(1, { objectApiName: 'Account', changeType: 'CREATE' }),
      makeMockEvent(2, { objectApiName: 'Contact', changeType: 'UPDATE' }),
    ]);

    render(<CDCEventFeed />);
    expect(screen.getByTestId('cdc-event-row-0')).toBeDefined();
    expect(screen.getByTestId('cdc-event-row-1')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });

  it('should render change type badges with correct variants', () => {
    useCDCLiveStore.getState().pushEvents([
      makeMockEvent(1, { changeType: 'CREATE' }),
      makeMockEvent(2, { changeType: 'DELETE' }),
    ]);

    render(<CDCEventFeed />);
    expect(screen.getByText('Create')).toBeDefined();
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('should render applied status indicator as checkmark for applied events', () => {
    useCDCLiveStore.getState().pushEvents([
      makeMockEvent(1, { applied: true }),
    ]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    const checkIcon = row.querySelector('.codicon-check');
    expect(checkIcon).not.toBeNull();
  });

  it('should render error status indicator for events with errors', () => {
    useCDCLiveStore.getState().pushEvents([
      makeMockEvent(1, { error: 'Insert failed' }),
    ]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    const errorIcon = row.querySelector('.codicon-error');
    expect(errorIcon).not.toBeNull();
  });

  it('should show event count in footer', () => {
    useCDCLiveStore.getState().pushEvents([
      makeMockEvent(1),
      makeMockEvent(2),
      makeMockEvent(3),
    ]);

    render(<CDCEventFeed />);
    const countEl = screen.getByTestId('cdc-event-count');
    expect(countEl.textContent).toContain('3');
  });

  it('should truncate record IDs with "+N more" when more than 2', () => {
    useCDCLiveStore.getState().pushEvents([
      makeMockEvent(1, {
        recordIds: ['001A', '001B', '001C', '001D'],
      }),
    ]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    expect(row.textContent).toContain('+2 more');
  });
});
