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
  VirtualList: <T,>({
    items,
    renderItem,
    keyExtractor,
    emptyMessage,
  }: {
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
    expect(screen.getByText(/No change received yet/)).toBeDefined();
  });

  it('should render event rows with correct data', () => {
    useCDCLiveStore
      .getState()
      .pushEvents([
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
    useCDCLiveStore
      .getState()
      .pushEvents([
        makeMockEvent(1, { changeType: 'CREATE' }),
        makeMockEvent(2, { changeType: 'DELETE' }),
      ]);

    render(<CDCEventFeed />);
    expect(screen.getByText('Create')).toBeDefined();
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('should render applied status indicator as checkmark for applied events', () => {
    useCDCLiveStore.getState().pushEvents([makeMockEvent(1, { applied: true })]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    const checkIcon = row.querySelector('.codicon-check');
    expect(checkIcon).not.toBeNull();
  });

  it('should render error status indicator for events with errors', () => {
    useCDCLiveStore.getState().pushEvents([makeMockEvent(1, { error: 'Insert failed' })]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    const errorIcon = row.querySelector('.codicon-error');
    expect(errorIcon).not.toBeNull();
  });

  it.each([
    ['applied', 'codicon-check', 'Written to the target'],
    ['watched', 'codicon-eye', 'Watched only, not written'],
    [
      'kept-target',
      'codicon-shield',
      'Not written: the target record was edited after this change',
    ],
    ['held', 'codicon-question', 'Held for a decision on the Conflicts tab'],
    [
      'deletes-off',
      'codicon-circle-slash',
      'Deletion not applied: deletes are off for this object',
    ],
    ['own-write', 'codicon-reply', 'Written by this session; not applied again'],
  ] as const)('says in words what became of a %s change', (outcome, icon, words) => {
    useCDCLiveStore.getState().pushEvents([makeMockEvent(1, { outcome })]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    expect(row.getAttribute('data-outcome')).toBe(outcome);
    expect(row.querySelector(`.${icon}`)?.getAttribute('title')).toBe(words);
    expect(row.textContent).toContain(words);
  });

  it('gives a screen reader the reason a change was not written', () => {
    useCDCLiveStore
      .getState()
      .pushEvents([
        makeMockEvent(1, { outcome: 'failed', error: 'ENTITY_IS_LOCKED: the record is locked' }),
      ]);

    render(<CDCEventFeed />);
    const row = screen.getByTestId('cdc-event-row-0');
    expect(row.querySelector('.codicon-error')?.getAttribute('title')).toBe(
      'ENTITY_IS_LOCKED: the record is locked',
    );
    expect(row.textContent).toContain('Not written: ENTITY_IS_LOCKED: the record is locked');
  });

  it('keeps events of two objects apart when their replay ids meet', () => {
    // A replay id counts within its channel: Lead and Contact can each send a
    // 42. Keyed on the id alone, React takes the two rows for one and may
    // drop or reuse either on the next batch — it says so on the console.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    useCDCLiveStore
      .getState()
      .pushEvents([
        makeMockEvent(42, { objectApiName: 'Lead' }),
        makeMockEvent(42, { objectApiName: 'Contact' }),
      ]);

    render(<CDCEventFeed />);

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const duplicateKeys = consoleError.mock.calls.filter((args) =>
      String(args[0]).includes('same key'),
    );
    consoleError.mockRestore();
    expect(duplicateKeys).toEqual([]);
  });

  it('should show event count in footer', () => {
    useCDCLiveStore.getState().pushEvents([makeMockEvent(1), makeMockEvent(2), makeMockEvent(3)]);

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
