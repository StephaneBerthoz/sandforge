import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useForgeRunGateStore } from './runGate';
import { ForgeRunGateNotice } from './ForgeRunGateNotice';

describe('ForgeRunGateNotice', () => {
  beforeEach(() => {
    act(() => useForgeRunGateStore.getState().clear());
  });

  it('says nothing while no run stopped at its gate', () => {
    render(<ForgeRunGateNotice />);
    expect(screen.queryByTestId('forge-run-gate-notice')).toBeNull();
  });

  it('alerts that a production target was refused before anything was read', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'PRODUCTION_TARGET' }));
    render(<ForgeRunGateNotice />);

    const notice = screen.getByTestId('forge-run-gate-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run did not start: the target org is a production org, or one SandForge cannot tell is a sandbox, a scratch org or a Developer Edition org. Forge writes to those only, and nothing was read or written. Pick one of them as the target.',
    );
  });

  it('says what the records take and what the target had left, for a refusal for storage', () => {
    act(() =>
      useForgeRunGateStore
        .getState()
        .setStop({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 66.9, remainingMB: 12 } }),
    );
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was refused before it wrote anything: its records take about 66.9 MB of data storage, and the target org has 12 MB left. Leave objects out, lower the records per object, or free data storage in the target org.',
    );
  });

  it.each([
    [
      'AUTOMATION_DECLINED' as const,
      'You cancelled the run at the confirmation of what the target org runs as the records are inserted. Nothing was read or written.',
    ],
    [
      'READ_DECLINED' as const,
      'You cancelled the run at the confirmation of the tables it reads with no cap per object, each past 50,000 records. Nothing was read or written. Set Records per object to read fewer.',
    ],
    [
      'WRITE_DECLINED' as const,
      'You cancelled the run before it wrote anything. The source records were read; nothing was written to the target org.',
    ],
  ])('tells, without alarm, of a run the user cancelled at a question (%s)', (code, text) => {
    act(() => useForgeRunGateStore.getState().setStop({ code }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-notice').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(text);
  });

  it('says a run that needed a confirmation nobody could give was stopped', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'CONFIRMATION_UNAVAILABLE' }));
    render(<ForgeRunGateNotice />);

    expect(screen.getByTestId('forge-run-gate-reason').textContent).toBe(
      'The run was stopped before it wrote anything: it needed your confirmation, and none could be asked.',
    );
  });

  it('goes once dismissed', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' }));
    render(<ForgeRunGateNotice />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('forge-run-gate-notice')).toBeNull();
    expect(useForgeRunGateStore.getState().stop).toBeNull();
  });
});
