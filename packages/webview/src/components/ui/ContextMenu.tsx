import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '../../theme';

/** A single context menu entry. */
export interface ContextMenuItem {
  label: string;
  icon?: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean;
}

/** Context menu component props. */
export interface ContextMenuProps {
  items: ContextMenuItem[];
  children: React.ReactNode;
  className?: string;
}

/** Right-click context menu that positions near the cursor. */
export const ContextMenu: React.FC<ContextMenuProps> = ({ items, children, className }) => {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPosition({ x: e.clientX, y: e.clientY });
    setVisible(true);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) return;

    function handleClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleClose();
      }
    }

    function handleEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape') handleClose();
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [visible, handleClose]);

  return (
    <div onContextMenu={handleContextMenu} className={className}>
      {children}
      {visible && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Context menu"
          className={cn(
            'fixed z-50 min-w-[160px] py-1 rounded-md shadow-lg',
            'bg-[var(--vscode-menu-background,#252526)]',
            'border border-[var(--vscode-menu-border,#3c3c3c)]',
          )}
          style={{ top: position.y, left: position.x }}
          data-testid="context-menu"
        >
          {items.map((item, index) => {
            if (item.separator) {
              return (
                <div
                  key={index}
                  className="my-1 border-t border-[var(--vscode-menu-separatorBackground,#3c3c3c)]"
                  role="separator"
                />
              );
            }

            return (
              <button
                key={index}
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  'flex items-center w-full px-3 py-1.5 text-xs text-left',
                  'text-[var(--vscode-menu-foreground,#cccccc)]',
                  'hover:bg-[var(--vscode-menu-selectionBackground,#094771)]',
                  'hover:text-[var(--vscode-menu-selectionForeground,#fff)]',
                  item.disabled && 'opacity-50 cursor-not-allowed',
                )}
                onClick={() => {
                  if (!item.disabled) {
                    item.action();
                    handleClose();
                  }
                }}
              >
                {item.icon && <span className="mr-2 w-4 text-center">{item.icon}</span>}
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
