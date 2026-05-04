import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../theme';
import { buttonPress } from '../../motion/presets';

/** Button visual variant. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Button size. */
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Props omitted to avoid Framer Motion event-handler type conflicts. */
type MotionEventConflicts =
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onDragOver'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration';

/** Button component props. */
export interface ButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  MotionEventConflicts
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)] hover:bg-[var(--vscode-button-hoverBackground,#1177bb)]',
  secondary:
    'bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#fff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)]',
  ghost:
    'bg-transparent text-[var(--vscode-editor-foreground,#d4d4d4)] hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]',
  danger: 'bg-[var(--vscode-errorForeground,#f48771)] text-white hover:opacity-90',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-base',
};

/** Styled button component matching VSCode theme. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...props },
    ref,
  ) => {
    return (
      <motion.button
        ref={ref}
        whileTap={!(disabled || loading) ? buttonPress.whileTap : undefined}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vscode-focusBorder,#007fd4)]',
          variantClasses[variant],
          sizeClasses[size],
          (disabled || loading) && 'opacity-50 cursor-not-allowed',
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <span
            className="animate-spin inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full"
            role="status"
          />
        ) : icon ? (
          <span className="shrink-0">{icon}</span>
        ) : null}
        {children}
      </motion.button>
    );
  },
);
Button.displayName = 'Button';
