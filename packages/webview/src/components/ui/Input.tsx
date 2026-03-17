import React from 'react';
import { cn } from '../../theme';

/** Input component props. */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

/** Styled input component matching VSCode theme. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'w-full px-2 py-1.5 text-sm rounded',
            'bg-[var(--vscode-input-background,#3c3c3c)]',
            'text-[var(--vscode-input-foreground,#d4d4d4)]',
            'border border-[var(--vscode-input-border,#3c3c3c)]',
            'placeholder:text-[var(--vscode-input-placeholderForeground,#6b6b6b)]',
            'focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]',
            error && 'border-[var(--vscode-errorForeground,#f48771)]',
            className,
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {error && (
          <span id={`${inputId}-error`} className="text-xs text-[var(--vscode-errorForeground,#f48771)]" role="alert">{error}</span>
        )}
        {!error && hint && (
          <span id={`${inputId}-hint`} className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">{hint}</span>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
