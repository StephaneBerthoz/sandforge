import React from 'react';
import { cn } from '../../theme';

/** Option for the Select component. */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Select component props. */
export interface SelectProps extends Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  'children'
> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

/** Styled select component matching VSCode theme. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, className, id, ...props }, ref) => {
    const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={selectId}
            className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]"
          >
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'w-full px-2 py-1.5 text-sm rounded appearance-none',
            'bg-[var(--vscode-input-background,#3c3c3c)]',
            'text-[var(--vscode-input-foreground,#d4d4d4)]',
            'border border-[var(--vscode-input-border,#3c3c3c)]',
            'focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]',
            error && 'border-[var(--vscode-errorForeground,#f48771)]',
            className,
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${selectId}-error` : undefined}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && (
          <span
            id={`${selectId}-error`}
            className="text-xs text-[var(--vscode-errorForeground,#f48771)]"
            role="alert"
          >
            {error}
          </span>
        )}
      </div>
    );
  },
);
Select.displayName = 'Select';
