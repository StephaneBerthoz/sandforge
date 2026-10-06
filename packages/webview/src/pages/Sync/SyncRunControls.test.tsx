import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { SyncRunControls } from './SyncRunControls';

const posted = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>> }));

const vscodeApi = vi.hoisted(() => ({
  postMessage: (envelope: { payload: Record<string, unknown> }) => {
    posted.messages.push(envelope.payload);
  },
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => vscodeApi,
  useVSCodeApi: () => vscodeApi,
}));

/** Every request of `type` the page sent. */
function sentOf(type: string): Array<Record<string, unknown>> {
  return posted.messages.filter((m) => m.type === type);
}

describe('SyncRunControls', () => {
  beforeEach(() => {
    posted.messages = [];
  });

  it('offers nothing before the run has an id to be named by', () => {
    const { container } = render(<SyncRunControls operationId={null} kind="run" />);

    expect(container.innerHTML).toBe('');
  });

  it('asks before cancelling a run, then cancels it as Live Operations does', () => {
    render(<SyncRunControls operationId="wv-run-1" kind="run" />);

    fireEvent.click(screen.getByTestId('sync-cancel'));
    expect(sentOf('execution:abort')).toEqual([]);
    expect(screen.getByText(/records already written stay in the target org/)).toBeDefined();

    // The confirmation asks for the word typed, as the Seed page's does.
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Cancel' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(sentOf('execution:abort').map((m) => m.payload)).toEqual([{ operationId: 'wv-run-1' }]);
    expect(screen.getByTestId('sync-run-state').textContent).toContain('Stopping');
  });

  it('stops a simulation at once, since it writes nothing, and offers it no pause', () => {
    render(<SyncRunControls operationId="wv-sim-1" kind="simulation" />);

    expect(screen.queryByTestId('sync-pause')).toBeNull();
    expect(screen.getByTestId('sync-cancel').textContent).toBe('Cancel simulation');

    fireEvent.click(screen.getByTestId('sync-cancel'));
    expect(sentOf('execution:abort').map((m) => m.payload)).toEqual([{ operationId: 'wv-sim-1' }]);
  });

  it('turns Pause into Resume once the run is held, and says nothing is written meanwhile', () => {
    render(<SyncRunControls operationId="wv-run-1" kind="run" />);

    fireEvent.click(screen.getByTestId('sync-pause'));
    const [pause] = sentOf('sync:pause');
    expect(pause.payload).toEqual({ operationId: 'wv-run-1' });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'host-1',
            type: 'sync:pause:response',
            timestamp: Date.now(),
            correlationId: pause.id,
            payload: { success: true, operationId: 'wv-run-1', paused: true },
          },
        }),
      );
    });

    expect(screen.queryByTestId('sync-pause')).toBeNull();
    const state = screen.getByTestId('sync-run-state');
    expect(state.getAttribute('role')).toBe('status');
    expect(state.textContent).toContain('nothing more is written until you resume');

    fireEvent.click(screen.getByTestId('sync-resume'));
    expect(sentOf('sync:resume').map((m) => m.payload)).toEqual([{ operationId: 'wv-run-1' }]);
  });
});
