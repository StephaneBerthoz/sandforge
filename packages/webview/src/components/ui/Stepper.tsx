import React from 'react';
import { cn } from '../../theme';

/** Single step definition. */
export interface StepperProps {
  /** Labels for each step. */
  steps: string[];
  /** Zero-based index of the current active step. */
  currentStep: number;
  /** Optional callback when a step is clicked. */
  onStepClick?: (index: number) => void;
  className?: string;
}

/** Multi-step progress indicator with numbered steps, labels, and connecting lines. */
export const Stepper: React.FC<StepperProps> = ({ steps, currentStep, onStepClick, className }) => {
  return (
    <div
      className={cn('flex items-center w-full', className)}
      role="navigation"
      aria-label="Progress steps"
    >
      {steps.map((label, index) => {
        const isCompleted = index < currentStep;
        const isActive = index === currentStep;
        const isLast = index === steps.length - 1;

        return (
          <React.Fragment key={index}>
            <div className="flex flex-col items-center">
              <button
                type="button"
                aria-label={`Step ${index + 1}: ${label}`}
                aria-current={isActive ? 'step' : undefined}
                disabled={!onStepClick}
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors border-2',
                  isCompleted && 'bg-emerald-600 border-emerald-600 text-white',
                  isActive &&
                    'border-[var(--vscode-focusBorder,#007fd4)] bg-[var(--vscode-focusBorder,#007fd4)] text-white',
                  !isCompleted &&
                    !isActive &&
                    'border-[var(--vscode-panel-border,#3c3c3c)] bg-transparent text-[var(--vscode-descriptionForeground,#868686)]',
                  onStepClick && 'cursor-pointer hover:opacity-80',
                  !onStepClick && 'cursor-default',
                )}
                onClick={() => onStepClick?.(index)}
              >
                {isCompleted ? (
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  index + 1
                )}
              </button>
              <span
                className={cn(
                  'mt-1.5 text-[11px] whitespace-nowrap',
                  isActive
                    ? 'text-[var(--vscode-editor-foreground,#d4d4d4)] font-medium'
                    : 'text-[var(--vscode-descriptionForeground,#868686)]',
                )}
              >
                {label}
              </span>
            </div>
            {!isLast && (
              <div
                className={cn(
                  'flex-1 h-0.5 mx-2 self-start mt-4 transition-colors',
                  index < currentStep
                    ? 'bg-emerald-600'
                    : 'bg-[var(--vscode-panel-border,#3c3c3c)]',
                )}
                aria-hidden="true"
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
