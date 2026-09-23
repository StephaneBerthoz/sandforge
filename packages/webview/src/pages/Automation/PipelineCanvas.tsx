import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineStep, PipelineStepType } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { stepBlocker } from './stepRunnability';

/** PipelineCanvas component props. */
export interface PipelineCanvasProps {
  steps?: PipelineStep[];
  selectedStepId?: string;
  onSelectStep?: (stepId: string) => void;
  onRemoveStep?: (stepId: string) => void;
  onConnectSteps?: (fromStepId: string, toStepId: string) => void;
  /** The ids of the orgs connected here: a step naming another org is marked. */
  orgIds?: ReadonlySet<string>;
}

/**
 * The dot beside a step's name, in an identity hue per type. The type is also
 * written in the badge next to it, so types a shade apart before (backup and
 * restore, script and delay) may share a hue.
 */
const STEP_COLORS: Partial<Record<PipelineStepType, string>> = {
  seed: 'bg-hue-green',
  sync: 'bg-hue-blue',
  backup: 'bg-hue-purple',
  restore: 'bg-hue-purple',
  anonymize: 'bg-hue-amber',
  delete: 'bg-hue-rose',
  compare: 'bg-hue-cyan',
  precheck: 'bg-hue-teal',
  script: 'bg-text-secondary',
  notification: 'bg-hue-yellow',
  approval: 'bg-hue-orange',
  delay: 'bg-text-secondary',
  condition: 'bg-hue-indigo',
  loop: 'bg-hue-purple',
  parallel: 'bg-hue-fuchsia',
};

/** Visual pipeline canvas showing steps as connected nodes. */
export const PipelineCanvas: React.FC<PipelineCanvasProps> = ({
  steps = [],
  selectedStepId,
  onSelectStep,
  onRemoveStep,
  orgIds,
}) => {
  const { t } = useTranslation();

  if (steps.length === 0) {
    return (
      <div data-testid="pipeline-canvas">
        <EmptyState
          icon="link"
          title={t('automation.dragStep')}
          description={t('automation.connectSteps')}
        />
      </div>
    );
  }

  return (
    <ol
      className="flex flex-col p-2"
      aria-label={t('automation.canvas')}
      data-testid="pipeline-canvas"
    >
      {steps.map((step, index) => {
        const isSelected = step.id === selectedStepId;
        const colorClass = STEP_COLORS[step.type] ?? 'bg-text-secondary';
        // A saved pipeline, a Marketplace template or an AI draft can hold a
        // step the palette would not add: it is marked where it sits.
        const blocker = stepBlocker(step, orgIds);

        // The node holds two buttons side by side, one that selects the step
        // and one that removes it. It used to be a role="button" div with the
        // remove button inside it: a control inside a control, which a screen
        // reader announces as one (axe: nested-interactive), and whose inner
        // click had to be kept from selecting the step as well.
        return (
          <li key={step.id} className="flex flex-col items-start">
            {index > 0 && (
              <span aria-hidden="true" className="ml-4 h-3 w-0.5 bg-[var(--sf-border)]" />
            )}
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                isSelected ? 'border-[var(--sf-accent)]' : 'border-[var(--sf-border)]'
              }`}
            >
              <button
                type="button"
                className="flex items-center gap-2 text-left cursor-pointer"
                onClick={() => onSelectStep?.(step.id)}
                aria-current={isSelected ? 'true' : undefined}
                data-testid={`canvas-step-${step.id}`}
              >
                <span className={`w-2 h-2 rounded-full ${colorClass}`} />
                <span className="text-xs font-medium text-[var(--sf-text-primary)]">
                  {step.name}
                </span>
                <Badge variant="default">{step.type}</Badge>
                {step.continueOnError && (
                  <Badge variant="warning">{t('automation.continueOnError')}</Badge>
                )}
                {blocker !== undefined && (
                  <Badge
                    variant="warning"
                    title={t(`automation.runnability.${blocker}`)}
                    data-testid={`canvas-blocked-${step.id}`}
                  >
                    {t('automation.runnability.cannotRun')}
                  </Badge>
                )}
              </button>
              {onRemoveStep && (
                <button
                  type="button"
                  className="text-xs text-[var(--sf-text-secondary)] hover:text-status-error"
                  onClick={() => onRemoveStep(step.id)}
                  aria-label={t('common.delete')}
                  data-testid={`remove-step-${step.id}`}
                >
                  ✕
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
};
