import React, { useEffect, useRef } from 'react';
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
  /**
   * Whether a completed step in the sidebar can be clicked to go back to it.
   * Off while the wizard must stay where it is — a run in flight — so a step
   * it would not go to is not drawn as one it would. Defaults to true.
   */
  canRevisitSteps?: boolean;
  onFinish?: () => void;
  isFinished?: boolean;
  /**
   * Escape hatch for a step that started long-running work: Back and Next are
   * both dead while a run is in flight, so without this the footer traps the
   * user until the backend answers. Rendered only when supplied.
   */
  onCancel?: () => void;
  /** i18n key for the cancel control. Defaults to `common.cancel`. */
  cancelLabelKey?: string;
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
  canRevisitSteps = true,
  onFinish,
  isFinished = false,
  onCancel,
  cancelLabelKey = 'common.cancel',
  testIdPrefix = 'wizard',
  className,
}) => {
  const { t } = useTranslation();

  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;
  const current = steps[currentStep];

  const wizardRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  /** Next, or Confirm on the last step. */
  const nextButtonRef = useRef<HTMLButtonElement>(null);

  /*
   * On a new step the keyboard goes to the step, which says its name, and not
   * to a button whose action changed under it. Left on Next, a second Enter
   * pressed while Seed Clone's preview was prepared ran the clone as soon as
   * the preview came; on Autopilot, whose review step turns Next into
   * Confirm, it started the run once the plan was built. The focus is taken
   * from a control of the wizard, or from one the step took off the page (the
   * preview's Execute), never from a control outside it.
   */
  const stepShown = useRef(currentStep);
  useEffect(() => {
    if (stepShown.current === currentStep) return;
    stepShown.current = currentStep;
    const focused = document.activeElement;
    const inWizard =
      focused === null ||
      focused === document.body ||
      wizardRef.current?.contains(focused) === true;
    if (inWizard) stepRef.current?.focus();
  }, [currentStep]);

  // The same when what Next waited for comes on the step it is on, while the
  // keyboard waited on Next: the step now shows it, and Next may now do what
  // it could not before (run the clone of the preview that came).
  const couldGoNext = useRef(canGoNext);
  useEffect(() => {
    const could = couldGoNext.current;
    couldGoNext.current = canGoNext;
    if (!could && canGoNext && document.activeElement === nextButtonRef.current) {
      stepRef.current?.focus();
    }
  }, [canGoNext]);

  return (
    <div
      ref={wizardRef}
      className={cn('flex gap-4', className)}
      data-testid={tid(testIdPrefix, 'wizard')}
    >
      {/* Vertical step sidebar */}
      <nav
        className="w-48 shrink-0 flex flex-col gap-1"
        role="group"
        aria-label={t('a11y.stepProgress', 'Step progress')}
        data-testid={tid(testIdPrefix, 'step-indicator')}
      >
        {steps.map((step, i) => {
          // One status, so what a step paints for one state is never read with
          // what it paints for another.
          const status = i === currentStep ? 'current' : i < currentStep ? 'completed' : 'future';
          /** A completed step the wizard goes back to when it is clicked. */
          const revisitable = status === 'completed' && canRevisitSteps;

          return (
            <button
              key={step.id}
              className={cn(
                'flex items-start gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors w-full',
                status === 'current' && 'bg-[var(--vscode-list-activeSelectionBackground,#094771)]',
                status === 'completed' &&
                  (canRevisitSteps
                    ? 'hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] cursor-pointer'
                    : 'cursor-default'),
                status === 'future' && 'cursor-default',
              )}
              onClick={() => revisitable && onStepChange(i)}
              disabled={status !== 'current' && !revisitable}
              aria-current={status === 'current' ? 'step' : undefined}
              data-testid={tid(testIdPrefix, `step-${step.id}`)}
            >
              <span
                className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5',
                  status === 'current'
                    ? 'bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)]'
                    : status === 'completed'
                      ? 'bg-status-success text-[var(--sf-bg-primary)]'
                      : 'bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#d4d4d4)]',
                )}
              >
                {status === 'completed' ? (
                  <Check size={12} data-testid={tid(testIdPrefix, `check-${step.id}`)} />
                ) : (
                  i + 1
                )}
              </span>
              <span className="flex flex-col min-w-0">
                <span
                  className={cn(
                    'truncate',
                    // The current step sits on the list selection, so it takes the
                    // selection's own foreground; a completed step takes the list
                    // hover, on which description text falls under AA.
                    status === 'current' &&
                      'font-semibold text-[var(--vscode-list-activeSelectionForeground,#fff)]',
                    status === 'completed' && 'text-text-primary',
                    status === 'future' && 'text-[var(--vscode-descriptionForeground,#868686)]',
                  )}
                >
                  {t(step.labelKey)}
                </span>
                {step.descriptionKey && (
                  <span
                    className={cn(
                      'text-[10px] truncate',
                      status === 'current' &&
                        'text-[var(--vscode-list-activeSelectionForeground,#fff)]',
                      status === 'completed' && 'text-text-primary',
                      status === 'future' && 'text-[var(--vscode-descriptionForeground,#868686)]',
                    )}
                  >
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
        {/* Named after the step it shows: focused, it tells a screen reader
            which step the keyboard is on. */}
        <div
          ref={stepRef}
          className="flex-1 min-h-0"
          role="group"
          aria-label={current ? t(current.labelKey) : undefined}
          tabIndex={-1}
          data-testid={tid(testIdPrefix, 'step-content')}
        >
          {/* One step at a time: the next is drawn once the last has left. */}
          <AnimatePresence mode="wait">
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

        {/* Navigation. Back, Next and Confirm stay focusable while they cannot
            be used: Next turns unavailable under the Enter that asks for a
            scan or a plan, and a button that takes the `disabled` attribute
            hands the focus to the page, where the keyboard started again from
            the top. */}
        {!isFinished && (
          <div className="flex justify-between items-center pt-2 border-t border-[var(--vscode-panel-border,#3c3c3c)]">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onStepChange(currentStep - 1)}
                disabled={isFirst || !canGoBack}
                focusableWhenDisabled
                data-testid={tid(testIdPrefix, 'wizard-back')}
              >
                {t('common.back')}
              </Button>
              {onCancel && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={onCancel}
                  data-testid={tid(testIdPrefix, 'wizard-cancel')}
                >
                  {t(cancelLabelKey)}
                </Button>
              )}
            </div>
            {isLast ? (
              <Button
                ref={nextButtonRef}
                variant="primary"
                size="sm"
                onClick={onFinish}
                disabled={!canGoNext}
                focusableWhenDisabled
                data-testid={tid(testIdPrefix, 'wizard-finish')}
              >
                {t('common.confirm')}
              </Button>
            ) : (
              <Button
                ref={nextButtonRef}
                variant="primary"
                size="sm"
                onClick={() => onStepChange(currentStep + 1)}
                disabled={!canGoNext}
                focusableWhenDisabled
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
