import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineStep, PipelineStepType } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';

/** PipelineCanvas component props. */
export interface PipelineCanvasProps {
  steps?: PipelineStep[];
  selectedStepId?: string;
  onSelectStep?: (stepId: string) => void;
  onRemoveStep?: (stepId: string) => void;
  onConnectSteps?: (fromStepId: string, toStepId: string) => void;
}

const STEP_COLORS: Partial<Record<PipelineStepType, string>> = {
  seed: 'bg-emerald-800',
  sync: 'bg-blue-800',
  backup: 'bg-purple-800',
  restore: 'bg-purple-700',
  anonymize: 'bg-amber-800',
  delete: 'bg-red-800',
  compare: 'bg-cyan-800',
  precheck: 'bg-teal-800',
  script: 'bg-gray-700',
  notification: 'bg-yellow-800',
  approval: 'bg-orange-800',
  delay: 'bg-gray-600',
  condition: 'bg-indigo-800',
  loop: 'bg-violet-800',
  parallel: 'bg-pink-800',
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
        const colorClass = STEP_COLORS[step.type] ?? 'bg-gray-700';

        return (
          <div key={step.id} className="flex items-center gap-2">
            {/* Connection line */}
            {index > 0 && (
              <div className="w-0.5 h-4 bg-[var(--vscode-panel-border,#3c3c3c)] mx-auto -mt-2 -mb-2" />
            )}
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                isSelected
                  ? 'border-[var(--vscode-focusBorder,#007fd4)]'
                  : 'border-[var(--vscode-panel-border,#3c3c3c)]'
              }`}
              onClick={() => onSelectStep?.(step.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelectStep?.(step.id); }}
              data-testid={`canvas-step-${step.id}`}
            >
              <div className={`w-2 h-2 rounded-full ${colorClass}`} />
              <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {step.name}
              </span>
              <Badge variant="default">{step.type}</Badge>
              {step.continueOnError && (
                <Badge variant="warning">{t('automation.continueOnError')}</Badge>
              )}
              {onRemoveStep && (
                <button
                  className="text-xs text-[var(--vscode-descriptionForeground,#868686)] hover:text-red-400 ml-auto"
                  onClick={(e) => { e.stopPropagation(); onRemoveStep(step.id); }}
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
