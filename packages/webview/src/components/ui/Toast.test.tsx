import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should render title and message', () => {
    render(
      <Toast id="1" level="info" title="Info" message="Something happened" onDismiss={vi.fn()} />,
    );
    expect(screen.getByText('Info')).toBeDefined();
    expect(screen.getByText('Something happened')).toBeDefined();
  });

  it('should have role=alert', () => {
    render(<Toast id="1" level="success" title="Done" message="OK" onDismiss={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('should call onDismiss when close button is clicked', () => {
    const onDismiss = vi.fn();
    render(<Toast id="t1" level="error" title="Error" message="Bad" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('should auto-dismiss after specified time', () => {
    const onDismiss = vi.fn();
    render(
      <Toast
        id="t2"
        level="info"
        title="Auto"
        message="Bye"
        onDismiss={onDismiss}
        autoDismissMs={3000}
      />,
    );
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDismiss).toHaveBeenCalledWith('t2');
  });

  it('should render action buttons', () => {
    const action = vi.fn();
    render(
      <Toast
        id="t3"
        level="warning"
        title="Warning"
        message="Check this"
        onDismiss={vi.fn()}
        actions={[{ label: 'View Details', onClick: action }]}
      />,
    );
    const actionBtn = screen.getByText('View Details');
    expect(actionBtn).toBeDefined();
    fireEvent.click(actionBtn);
    expect(action).toHaveBeenCalledOnce();
  });

  it('should apply correct level border class', () => {
    render(<Toast id="1" level="error" title="Err" message="msg" onDismiss={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-l-[var(--vscode-errorForeground');
  });
});
