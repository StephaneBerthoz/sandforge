import React from 'react';
import { cn } from '../../theme';

/** A single breadcrumb entry. */
export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

/** Breadcrumb component props. */
export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/** Navigation breadcrumbs with clickable ancestors and static current page. */
export const Breadcrumb: React.FC<BreadcrumbProps> = ({ items, className }) => {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center text-xs', className)}>
      <ol className="flex items-center gap-1">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            <li key={index} className="flex items-center gap-1">
              {isLast ? (
                <span
                  className="text-[var(--vscode-editor-foreground,#d4d4d4)] font-medium"
                  aria-current="page"
                >
                  {item.label}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    aria-label={`Navigate to ${item.label}`}
                    className={cn(
                      'text-[var(--vscode-textLink-foreground,#3794ff)] hover:underline',
                      !item.onClick && 'cursor-default no-underline',
                    )}
                    onClick={item.onClick}
                    disabled={!item.onClick}
                  >
                    {item.label}
                  </button>
                  <span
                    className="text-[var(--vscode-descriptionForeground,#868686)]"
                    aria-hidden="true"
                  >
                    /
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
