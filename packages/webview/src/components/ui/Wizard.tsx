import React from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { Check } from 'lucide-react';
import { cn } from '../../theme';
import { pageTransition, SPRING } from '../../motion/presets';
import { Button } from './Button';

/** Wizard step definition. */
export interface WizardStep {
  id: string;
  labelKey: string;
  descriptionKey?: string;
}

/** Props for the Wizard component. */
export interface WizardProps {
  steps: WizardStep[];
  currentStep: number;
  onStepChange: (step: number) => void;
  children: React.ReactNode;
  canGoNext?: boolean;
  canGoBack?: boolean;
  onFinish?: () => void;
  isFinished?: boolean;
  testIdPrefix?: string;
  className?: string;
}

/** Build a prefixed test ID. */
function tid(prefix: string, id: string): string {
  return `${prefix}-${id}`;
}

/** Generic multi-step wizard with vertical sidebar navigator. */
export const Wizard: React.FC<WizardProps> = ({
  steps,
  currentStep,
  onStepChange,
  children,
  canGoNext = true,
  canGoBack = true,
  onFinish,
  isFinished = false,
  testIdPrefix = 'wizard',
  className,
}) => {
  const { t } = useTranslation();

  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;

  return (
    <div className={cn('flex gap-4', className)} data-testid={tid(testIdPrefix, 'wizard')}>
      {/* Vertical step sidebar */}
      <nav
        className="w-48 shrink-0 flex flex-col gap-1"
        role="group"
        aria-label="Step progress"
        data-testid={tid(testIdPrefix, 'step-indicator')}
      >
        {steps.map((step, i) => {
          const isCompleted = i < currentStep;
          const isCurrent = i === currentStep;
          const isFuture = i > currentStep;

          return (
            <button
              key={step.id}
              className={cn(
                'flex items-start gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors w-full',
                isCurrent && 'bg-[var(--vscode-list-activeSelectionBackground,#094771)]',
                isCompleted &&
                  'hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] cursor-pointer',
                isFuture && 'opacity-50 cursor-default',
              )}
              onClick={() => isCompleted && onStepChange(i)}
              disabled={isFuture}
              aria-current={isCurrent ? 'step' : undefined}
              data-testid={tid(testIdPrefix, `step-${step.id}`)}
            >
              <span
                className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5',
                  isCurrent
                    ? 'bg-[var(--vscode-focusBorder,#007fd4)] text-white'
                    : isCompleted
                      ? 'bg-[#4ec9b0] text-[var(--vscode-editor-background,#1e1e1e)]'
                      : 'bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-descriptionForeground,#868686)]',
                )}
              >
                {isCompleted ? (
                  <Check size={12} data-testid={tid(testIdPrefix, `check-${step.id}`)} />
                ) : (
                  i + 1
                )}
              </span>
              <span className="flex flex-col min-w-0">
                <span
                  className={cn(
                    'truncate',
                    isCurrent
                      ? 'font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]'
                      : isCompleted
                        ? 'text-[var(--vscode-descriptionForeground,#868686)]'
                        : 'text-[var(--vscode-disabledForeground,#6b6b6b)]',
                  )}
                >
                  {t(step.labelKey)}
                </span>
                {step.descriptionKey && (
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] truncate">
                    {t(step.descriptionKey)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 min-h-0" data-testid={tid(testIdPrefix, 'step-content')}>
          <AnimatePresence>
            <m.div
              key={currentStep}
              variants={pageTransition(1)}
              initial="enter"
              animate="center"
              exit="exit"
              transition={SPRING}
            >
              {children}
            </m.div>
          </AnimatePresence>
        </div>

        {/* Navigation */}
        {!isFinished && (
          <div className="flex justify-between items-center pt-2 border-t border-[var(--vscode-panel-border,#3c3c3c)]">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onStepChange(currentStep - 1)}
              disabled={isFirst || !canGoBack}
              data-testid={tid(testIdPrefix, 'wizard-back')}
            >
              {t('common.back')}
            </Button>
            {isLast ? (
              <Button
                variant="primary"
                size="sm"
                onClick={onFinish}
                disabled={!canGoNext}
                data-testid={tid(testIdPrefix, 'wizard-finish')}
              >
                {t('common.confirm')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onStepChange(currentStep + 1)}
                disabled={!canGoNext}
                data-testid={tid(testIdPrefix, 'wizard-next')}
              >
                {t('common.next')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
