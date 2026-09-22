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
    <div className="flex flex-col gap-2 p-2" data-testid="pipeline-canvas">
      {steps.map((step, index) => {
        const isSelected = step.id === selectedStepId;
        const colorClass = STEP_COLORS[step.type] ?? 'bg-text-secondary';
        // A saved pipeline, a Marketplace template or an AI draft can hold a
        // step the palette would not add: it is marked where it sits.
        const blocker = stepBlocker(step);

        return (
          <div key={step.id} className="flex items-center gap-2">
            {/* Connection line */}
            {index > 0 && <div className="w-0.5 h-4 bg-[var(--sf-border)] mx-auto -mt-2 -mb-2" />}
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                isSelected ? 'border-[var(--sf-accent)]' : 'border-[var(--sf-border)]'
              }`}
              onClick={() => onSelectStep?.(step.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelectStep?.(step.id);
              }}
              data-testid={`canvas-step-${step.id}`}
            >
              <div className={`w-2 h-2 rounded-full ${colorClass}`} />
              <span className="text-xs font-medium text-[var(--sf-text-primary)]">{step.name}</span>
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
              {onRemoveStep && (
                <button
                  className="text-xs text-[var(--sf-text-secondary)] hover:text-status-error ml-auto"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveStep(step.id);
                  }}
                  aria-label={t('common.delete')}
                  data-testid={`remove-step-${step.id}`}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
