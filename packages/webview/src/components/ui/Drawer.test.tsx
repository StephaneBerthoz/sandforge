import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('should render title and children when open', () => {
    render(
      <Drawer open onClose={vi.fn()} title="Settings">
        <p>Drawer content</p>
      </Drawer>,
    );
    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.getByText('Drawer content')).toBeDefined();
  });

  it('should not render when closed', () => {
    render(
      <Drawer open={false} onClose={vi.fn()} title="Settings">
        <p>Drawer content</p>
      </Drawer>,
    );
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('should call onClose when overlay is clicked', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Settings">
        <p>Content</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByTestId('drawer-overlay'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Settings">
        <p>Content</p>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Settings">
        <p>Content</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should render on the left side when side is left', () => {
    render(
      <Drawer open onClose={vi.fn()} title="Nav" side="left">
        <p>Left content</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('left-0');
  });

  it('should render on the right side by default', () => {
    render(
      <Drawer open onClose={vi.fn()} title="Nav">
        <p>Right content</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('right-0');
  });
});
