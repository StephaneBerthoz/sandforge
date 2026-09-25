import React from 'react';
import { m } from 'framer-motion';
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
  /**
   * Keep the button focusable while it is disabled or loading: it says so with
   * `aria-disabled` and ignores its clicks, instead of taking the `disabled`
   * attribute. A button that has the focus when it takes that attribute hands
   * the focus to the page, and the keyboard starts again from the top. For a
   * button that turns unavailable under the Enter that pressed it, as a
   * wizard's Next does.
   */
  focusableWhenDisabled?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-(--vscode-button-background,#0e639c) text-(--vscode-button-foreground,#fff) hover:bg-(--vscode-button-hoverBackground,#1177bb)',
  secondary:
    'bg-(--vscode-button-secondaryBackground,#3a3d41) text-(--vscode-button-secondaryForeground,#fff) hover:bg-(--vscode-button-secondaryHoverBackground,#45494e)',
  ghost:
    'bg-transparent text-(--vscode-editor-foreground,#d4d4d4) hover:bg-(--vscode-list-hoverBackground,#2a2d2e)',
  // The severity token as the fill and the editor background as the label: the
  // token is sized to read against that background on every measured theme but
  // Solarized Light, so the pair holds both ways round, where white on
  // errorForeground reads 2.4:1 on Dark+.
  danger: 'bg-status-error text-(--sf-bg-primary)',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-base',
};

/** Styled button component matching VSCode theme. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading,
      icon,
      focusableWhenDisabled = false,
      className,
      children,
      disabled,
      onClick,
      ...props
    },
    ref,
  ) => {
    /** Disabled or loading, and kept focusable: a click, Enter and Space included, does nothing. */
    const focusableDisabled = (disabled || loading) && focusableWhenDisabled;
    return (
      <m.button
        ref={ref}
        whileTap={!(disabled || loading) ? buttonPress.whileTap : undefined}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--vscode-focusBorder,#007fd4)',
          variantClasses[variant],
          sizeClasses[size],
          (disabled || loading) && 'opacity-50 cursor-not-allowed',
          className,
        )}
        disabled={(disabled || loading) && !focusableWhenDisabled}
        aria-disabled={focusableDisabled || undefined}
        aria-busy={loading || undefined}
        onClick={focusableDisabled ? (event) => event.preventDefault() : onClick}
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
      </m.button>
    );
  },
);
Button.displayName = 'Button';
