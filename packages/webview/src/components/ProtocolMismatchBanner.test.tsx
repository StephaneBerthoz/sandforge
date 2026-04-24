import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { ProtocolMismatchBanner } from './ProtocolMismatchBanner';

function fireBanner(): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: 'bridge-1',
        type: 'bridge:reload-banner',
        timestamp: Date.now(),
        payload: { reason: 'protocol-mismatch' },
      },
    }),
  );
}

describe('ProtocolMismatchBanner', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('renders nothing when no mismatch has been reported', () => {
    const { container } = render(<ProtocolMismatchBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the banner when a bridge:reload-banner message is received', () => {
    render(<ProtocolMismatchBanner />);

    act(() => {
      fireBanner();
    });

    expect(screen.getByTestId('protocol-mismatch-banner')).toBeDefined();
    expect(screen.getByText(/reload the window/i)).toBeDefined();
  });

  it('sends a workbench:reload envelope when the Reload button is clicked', () => {
    render(<ProtocolMismatchBanner />);

    act(() => {
      fireBanner();
    });

    fireEvent.click(screen.getByTestId('protocol-mismatch-reload'));

    expect(mockPostMessage).toHaveBeenCalledOnce();
    // useSendMessage wraps outbound in envelope — unwrap payload.
    const envelope = mockPostMessage.mock.calls[0][0] as { payload: { type: string } };
    expect(envelope.payload.type).toBe('workbench:reload');
  });

  it('dismisses the banner when the × button is clicked', () => {
    const { container } = render(<ProtocolMismatchBanner />);

    act(() => {
      fireBanner();
    });

    expect(screen.getByTestId('protocol-mismatch-banner')).toBeDefined();

    fireEvent.click(screen.getByTestId('protocol-mismatch-dismiss'));

    expect(container.firstChild).toBeNull();
  });

  it('re-appears after dismissal if the mismatch fires again', () => {
    const { container } = render(<ProtocolMismatchBanner />);

    act(() => {
      fireBanner();
    });

    fireEvent.click(screen.getByTestId('protocol-mismatch-dismiss'));
    expect(container.firstChild).toBeNull();

    act(() => {
      fireBanner();
    });

    expect(screen.getByTestId('protocol-mismatch-banner')).toBeDefined();
  });
});
