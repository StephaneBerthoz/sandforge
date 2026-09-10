import React from 'react';
import { cn } from '../../theme';

/** Badge visual variant. */
export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

/**
 * Badge component props.
 *
 * Extends the span's own attributes so `data-*`, `title`, `aria-*` and the
 * rest reach the DOM. They used to be dropped in silence: TypeScript does not
 * check hyphenated JSX attributes against a component's props, so
 * `<Badge data-testid="conflict-count-badge">` compiled, rendered nothing of
 * the sort, and the testid was simply absent from the page.
 */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-[var(--vscode-badge-background,#4d4d4d)] text-[var(--vscode-badge-foreground,#fff)]',
  success: 'bg-emerald-700 text-emerald-100',
  warning: 'bg-amber-700 text-amber-100',
  error: 'bg-red-700 text-red-100',
  info: 'bg-blue-700 text-blue-100',
};

/** Small badge/label for counts or status indicators. */
export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  className,
  ...rest
}) => {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-medium leading-none rounded-full',
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
};
