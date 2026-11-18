import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight } from 'lucide-react';
import type { ForgePhase } from '../../stores/useForgeStore';
import { cn } from '../../theme';

/** Forge's phases, in the order a run goes through them. */
export const FORGE_PHASES: readonly ForgePhase[] = [
  'input',
  'discovery',
  'review',
  'execution',
  'results',
];

/** Where a phase stands against the one on screen. */
type PhaseStatus = 'done' | 'current' | 'next' | 'skipped';

/** Props for {@link ForgePhaseSteps}. */
export interface ForgePhaseStepsProps {
  /** The phase on screen. */
  phase: ForgePhase;
  /** Whether the run went past Review without stopping on it (Clone directly). */
  reviewSkipped: boolean;
}

/**
 * The five phases of a run, the one on screen marked, over the page. Nothing
 * said where the run stood: the discovery's button that only opened Review
 * read Review & Execute, and a run sent by Clone directly passed Review
 * without a word. A phase Clone directly went past is said skipped, not done.
 */
export const ForgePhaseSteps: React.FC<ForgePhaseStepsProps> = ({ phase, reviewSkipped }) => {
  const { t } = useTranslation();
  const at = FORGE_PHASES.indexOf(phase);
  return (
    <ol
      aria-label={t('a11y.stepProgress')}
      data-testid="forge-phase-steps"
      className="-mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
    >
      {FORGE_PHASES.map((step, index) => {
        const status: PhaseStatus =
          index === at
            ? 'current'
            : index > at
              ? 'next'
              : step === 'review' && reviewSkipped
                ? 'skipped'
                : 'done';
        return (
          <li
            key={step}
            data-testid={`forge-phase-step-${step}`}
            data-status={status}
            aria-current={status === 'current' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5',
              status === 'current' ? 'font-semibold text-text-primary' : 'text-text-secondary',
            )}
          >
            {index > 0 && <ChevronRight size={12} aria-hidden="true" className="shrink-0" />}
            <span
              aria-hidden="true"
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                status === 'current'
                  ? 'bg-hue-forge text-(--sf-bg-primary)'
                  : 'border border-subtle',
              )}
            >
              {status === 'done' ? <Check size={10} /> : index + 1}
            </span>
            <span>{t(`forge.phaseName.${step}`)}</span>
            {status === 'skipped' && (
              <span data-testid="forge-phase-step-skipped">({t('forge.phaseSkipped')})</span>
            )}
          </li>
        );
      })}
    </ol>
  );
};
