import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';

const items: ContextMenuItem[] = [
  { label: 'Copy', action: vi.fn() },
  { label: 'Paste', action: vi.fn() },
  { label: '', action: vi.fn(), separator: true },
  { label: 'Delete', action: vi.fn(), disabled: true },
];

describe('ContextMenu', () => {
  it('should render children', () => {
    render(
      <ContextMenu items={items}>
        <div>Right-click me</div>
      </ContextMenu>,
    );
    expect(screen.getByText('Right-click me')).toBeDefined();
  });

  it('should not show menu by default', () => {
    render(
      <ContextMenu items={items}>
        <div>Target</div>
      </ContextMenu>,
    );
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('should show menu on right-click', () => {
    render(
      <ContextMenu items={items}>
        <div>Target</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    expect(screen.getByTestId('context-menu')).toBeDefined();
    expect(screen.getByText('Copy')).toBeDefined();
    expect(screen.getByText('Paste')).toBeDefined();
  });

  it('should call action and close menu on item click', () => {
    const copyAction = vi.fn();
    const menuItems: ContextMenuItem[] = [{ label: 'Copy', action: copyAction }];
    render(
      <ContextMenu items={menuItems}>
        <div>Target</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    fireEvent.click(screen.getByText('Copy'));
    expect(copyAction).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('should render separators', () => {
    render(
      <ContextMenu items={items}>
        <div>Target</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    const separators = screen.getByTestId('context-menu').querySelectorAll('[role="separator"]');
    expect(separators.length).toBe(1);
  });

  it('should not call action on disabled items', () => {
    const deleteAction = vi.fn();
    const menuItems: ContextMenuItem[] = [
      { label: 'Delete', action: deleteAction, disabled: true },
    ];
    render(
      <ContextMenu items={menuItems}>
        <div>Target</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    fireEvent.click(screen.getByText('Delete'));
    expect(deleteAction).not.toHaveBeenCalled();
  });

  it('should close on Escape key', () => {
    render(
      <ContextMenu items={items}>
        <div>Target</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    expect(screen.getByTestId('context-menu')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });
});
