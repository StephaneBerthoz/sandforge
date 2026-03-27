import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { RealTimeSyncPanel } from './RealTimeSyncPanel';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/**
 * Mock VirtualList for jsdom (no layout engine).
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

const defaultProps = {
  sourceOrgId: 'org-src-001',
  targetOrgId: 'org-tgt-001',
  availableObjects: ['Account', 'Contact', 'Opportunity'],
};

describe('RealTimeSyncPanel', () => {
  beforeEach(() => {
    useCDCLiveStore.getState().reset();
  });

  it('should render the panel with test ID', () => {
    render(<RealTimeSyncPanel {...defaultProps} />);
    expect(screen.getByTestId('realtime-sync-panel')).toBeDefined();
  });

  it('should render CDCSubscriptionPanel', () => {
    render(<RealTimeSyncPanel {...defaultProps} />);
    expect(screen.getByTestId('cdc-subscription-panel')).toBeDefined();
  });

  it('should render CDCEventFeed', () => {
    render(<RealTimeSyncPanel {...defaultProps} />);
    expect(screen.getByTestId('cdc-event-feed')).toBeDefined();
  });

  it('should call setOrgs on mount with source and target org IDs', () => {
    render(<RealTimeSyncPanel {...defaultProps} />);
    const state = useCDCLiveStore.getState();
    expect(state.sourceOrgId).toBe('org-src-001');
    expect(state.targetOrgId).toBe('org-tgt-001');
  });

  it('should not render Coming Soon badge', () => {
    render(<RealTimeSyncPanel {...defaultProps} />);
    expect(screen.queryByTestId('realtime-coming-soon')).toBeNull();
  });

  it('should not have pointer-events-none wrapper', () => {
    render(<RealTimeSyncPanel {...defaultProps} />);
    const container = screen.getByTestId('realtime-sync-panel');
    const disabledContent = container.querySelector('.pointer-events-none');
    expect(disabledContent).toBeNull();
  });
});
