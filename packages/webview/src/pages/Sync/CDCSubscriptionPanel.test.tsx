import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { CDCSubscriptionPanel } from './CDCSubscriptionPanel';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

const defaultProps = {
  availableObjects: ['Account', 'Contact', 'Opportunity'],
};

describe('CDCSubscriptionPanel', () => {
  beforeEach(() => {
    useCDCLiveStore.getState().reset();
    mockPostMessage.mockClear();
  });

  it('should render status badge with correct variant for disconnected', () => {
    render(<CDCSubscriptionPanel {...defaultProps} />);
    const badge = screen.getByTestId('cdc-status-badge');
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain('Disconnected');
  });

  it('should render status badge with correct variant for syncing', () => {
    useCDCLiveStore.getState().setStatus('syncing');
    render(<CDCSubscriptionPanel {...defaultProps} />);
    const badge = screen.getByTestId('cdc-status-badge');
    expect(badge.textContent).toContain('Syncing');
  });

  it('should render status badge with correct variant for error', () => {
    useCDCLiveStore.getState().setStatus('error');
    render(<CDCSubscriptionPanel {...defaultProps} />);
    const badge = screen.getByTestId('cdc-status-badge');
    expect(badge.textContent).toContain('Error');
  });

  it('should render start button that posts realtime:start message', () => {
    useCDCLiveStore.getState().setWatchedObjects(['Account']);
    render(<CDCSubscriptionPanel {...defaultProps} />);
    const startBtn = screen.getByTestId('cdc-start-btn');
    fireEvent.click(startBtn);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    // Store senders post through the broker envelope — unwrap to assert.
    const startEnvelope = mockPostMessage.mock.calls[0][0] as {
      payload: { type: string };
    };
    expect(startEnvelope.payload.type).toBe('realtime:start');
  });

  it('should render stop button when streaming and post realtime:stop', () => {
    useCDCLiveStore.getState().setStatus('syncing');
    render(<CDCSubscriptionPanel {...defaultProps} />);
    const stopBtn = screen.getByTestId('cdc-stop-btn');
    fireEvent.click(stopBtn);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const stopEnvelope = mockPostMessage.mock.calls[0][0] as {
      payload: { type: string };
    };
    expect(stopEnvelope.payload.type).toBe('realtime:stop');
  });

  it('should render object checkboxes that toggle watchedObjects', () => {
    render(<CDCSubscriptionPanel {...defaultProps} />);

    const accountCb = screen.getByTestId('cdc-object-checkbox-Account') as HTMLInputElement;
    expect(accountCb.checked).toBe(false);

    fireEvent.click(accountCb);
    expect(useCDCLiveStore.getState().watchedObjects).toContain('Account');

    // Re-render to check state
    const { unmount } = render(<CDCSubscriptionPanel {...defaultProps} />);
    const updatedCb = screen.getAllByTestId('cdc-object-checkbox-Account')[1] as HTMLInputElement;
    expect(updatedCb.checked).toBe(true);
    unmount();
  });

  it('should show auto-sync toggle that reveals conflict strategy selector', () => {
    useCDCLiveStore.getState().setWatchedObjects(['Account']);
    render(<CDCSubscriptionPanel {...defaultProps} />);

    const autoSyncToggle = screen.getByTestId('cdc-autosync-toggle-Account') as HTMLInputElement;
    expect(autoSyncToggle).toBeDefined();
    expect(autoSyncToggle.checked).toBe(false);

    // Enable auto-sync
    fireEvent.click(autoSyncToggle);
    expect(useCDCLiveStore.getState().autoSyncObjects['Account']).toBeDefined();
  });

  it('should disable object checkboxes during connecting state', () => {
    useCDCLiveStore.getState().setStatus('connecting');
    render(<CDCSubscriptionPanel {...defaultProps} />);

    const accountCb = screen.getByTestId('cdc-object-checkbox-Account') as HTMLInputElement;
    expect(accountCb.disabled).toBe(true);
  });
});
