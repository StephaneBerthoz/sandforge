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

/**
 * A severity badge fills with its status token and writes in the editor
 * background, which the token is sized to read against on every measured theme
 * but Solarized Light (src/styles/theme.css). The fixed -700 fills with -100 text
 * they replace painted the same pill on every theme instead of following it.
 */
const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-(--vscode-badge-background,#4d4d4d) text-(--vscode-badge-foreground,#fff)',
  success: 'bg-status-success text-(--sf-bg-primary)',
  warning: 'bg-status-warning text-(--sf-bg-primary)',
  error: 'bg-status-error text-(--sf-bg-primary)',
  info: 'bg-status-info text-(--sf-bg-primary)',
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
