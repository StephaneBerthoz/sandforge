import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { DangerConfirm } from './DangerConfirm';

describe('DangerConfirm', () => {
  const baseProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Delete All Data',
    description: 'This will permanently delete all records.',
    confirmText: 'DELETE',
  };

  it('should not render when closed', () => {
    render(<DangerConfirm {...baseProps} open={false} />);
    expect(screen.queryByText('Delete All Data')).toBeNull();
  });

  it('should render title and description when open', () => {
    render(<DangerConfirm {...baseProps} />);
    expect(screen.getByText('Delete All Data')).toBeDefined();
    expect(screen.getByText('This will permanently delete all records.')).toBeDefined();
  });

  it('should display the confirm text to type', () => {
    render(<DangerConfirm {...baseProps} />);
    expect(screen.getByText('DELETE')).toBeDefined();
  });

  it('should disable confirm button until text matches', () => {
    render(<DangerConfirm {...baseProps} />);
    const confirmBtn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('should enable confirm button when text matches', () => {
    render(<DangerConfirm {...baseProps} />);
    const input = screen.getByTestId('danger-input');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    const confirmBtn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });

  it('should call onConfirm when text matches and button clicked', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('should not call onConfirm when text does not match', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('should call onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<DangerConfirm {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<DangerConfirm {...baseProps} onClose={onClose} />);
    const overlay = screen.getByTestId('danger-overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should show warning colors when variant is warning', () => {
    render(<DangerConfirm {...baseProps} variant="warning" />);
    const titleEl = screen.getByTestId('danger-title');
    expect(titleEl.className).toContain('text-monitor');
  });

  it('should show info colors when variant is info', () => {
    render(<DangerConfirm {...baseProps} variant="info" />);
    const titleEl = screen.getByTestId('danger-title');
    expect(titleEl.className).toContain('text-sync');
  });

  it('should confirm on Enter key when text matches', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    const input = screen.getByTestId('danger-input');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('should not confirm on Enter key when text does not match', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    const input = screen.getByTestId('danger-input');
    fireEvent.change(input, { target: { value: 'WRONG' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
