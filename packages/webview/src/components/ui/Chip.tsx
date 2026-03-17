import React from 'react';
import { cn } from '../../theme';

/** Chip variant types. */
export type ChipVariant = 'default' | 'primary' | 'success' | 'warning' | 'error';

/** Chip size types. */
export type ChipSize = 'sm' | 'md';

/** Chip component props. */
export interface ChipProps {
  label: string;
  /** Callback when the remove button is clicked. Renders a close icon when provided. */
  onRemove?: () => void;
  variant?: ChipVariant;
  size?: ChipSize;
  className?: string;
}

const variantClasses: Record<ChipVariant, string> = {
  default:
    'bg-[var(--vscode-badge-background,#4d4d4d)] text-[var(--vscode-badge-foreground,#fff)]',
  primary: 'bg-blue-700 text-blue-100',
  success: 'bg-emerald-700 text-emerald-100',
  warning: 'bg-amber-700 text-amber-100',
  error: 'bg-red-700 text-red-100',
};

const sizeClasses: Record<ChipSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-1 text-xs',
};

/** Tag or filter chip with optional remove button. */
export const Chip: React.FC<ChipProps> = ({
  label,
  onRemove,
  variant = 'default',
  size = 'md',
  className,
}) => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium leading-none',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="inline-flex items-center justify-center rounded-full hover:opacity-80 transition-opacity"
          onClick={onRemove}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
};
