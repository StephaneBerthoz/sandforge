import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { RunStopControl } from './RunStopControl';

describe('RunStopControl', () => {
  it('sends the cancel once clicked, and says nothing more until it is sent', () => {
    const onStop = vi.fn();
    render(<RunStopControl onStop={onStop} requested={false} testId="backup-stop" />);

    expect(screen.queryByTestId('backup-stop-stopping')).toBeNull();
    fireEvent.click(screen.getByTestId('backup-stop'));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('backup-stop').textContent).toBe(en.common.cancelRun);
  });

  it('is not offered twice once sent, and says what happens to what the run did', () => {
    const onStop = vi.fn();
    render(<RunStopControl onStop={onStop} requested testId="restore-stop" />);

    expect(screen.getByTestId('restore-stop').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('restore-stop'));
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(en.common.runStopping);
  });
});
