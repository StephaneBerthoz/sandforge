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
  (
    {
      label,
      error,
      options,
      placeholder,
      className,
      id,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      ...props
    },
    ref,
  ) => {
    // Derived from the label text this id collided as soon as two selects on the
    // same screen shared a label: both got the same id, so both <label for> tags
    // resolved to the first select and the others lost their accessible name.
    const generatedId = React.useId();
    const selectId = id ?? generatedId;
    // A <select> takes no accessible name from a placeholder <option> — that
    // option is only its initial value. Without a visible label the control is
    // anonymous to a screen reader, so the placeholder becomes its aria-label.
    const resolvedAriaLabel = ariaLabel ?? (!label && !ariaLabelledBy ? placeholder : undefined);
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
          aria-label={resolvedAriaLabel}
          aria-labelledby={ariaLabelledBy}
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
