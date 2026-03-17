import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MojitoOverlay } from './MojitoOverlay';

describe('MojitoOverlay', () => {
  it('should render the overlay container', () => {
    render(<MojitoOverlay onClose={vi.fn()} />);
    expect(screen.getByTestId('mojito-overlay')).toBeDefined();
  });

  it('should render the SVG mojito', () => {
    render(<MojitoOverlay onClose={vi.fn()} />);
    expect(screen.getByTestId('mojito-svg')).toBeDefined();
  });

  it('should call onClose when the overlay is clicked', () => {
    const onClose = vi.fn();
    render(<MojitoOverlay onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mojito-overlay'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(<MojitoOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should not call onClose for non-Escape keys', () => {
    const onClose = vi.fn();
    render(<MojitoOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should have fixed positioning for full-screen overlay', () => {
    render(<MojitoOverlay onClose={vi.fn()} />);
    const overlay = screen.getByTestId('mojito-overlay');
    expect(overlay.style.position).toBe('fixed');
  });

  it('should clean up the Escape listener on unmount', () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<MojitoOverlay onClose={vi.fn()} />);
    unmount();
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    spy.mockRestore();
  });
});
