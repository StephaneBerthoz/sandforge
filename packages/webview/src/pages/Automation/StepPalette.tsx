import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineStepType } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { paletteBlocker } from './stepRunnability';

/** Step category definition. */
export type StepCategory = 'data' | 'control' | 'notification' | 'quality';

/** Step palette entry. */
export interface StepPaletteEntry {
  type: PipelineStepType;
  category: StepCategory;
}

/** StepPalette component props. */
export interface StepPaletteProps {
  onAddStep?: (type: PipelineStepType) => void;
}

/** The category every step type sits under, whether or not the palette offers it. */
const STEP_ENTRIES: StepPaletteEntry[] = [
  { type: 'seed', category: 'data' },
  { type: 'sync', category: 'data' },
  { type: 'backup', category: 'data' },
  { type: 'restore', category: 'data' },
  { type: 'anonymize', category: 'data' },
  { type: 'delete', category: 'data' },
  { type: 'compare', category: 'quality' },
  { type: 'precheck', category: 'quality' },
  { type: 'condition', category: 'control' },
  { type: 'loop', category: 'control' },
  { type: 'parallel', category: 'control' },
  { type: 'delay', category: 'control' },
  { type: 'approval', category: 'control' },
  { type: 'script', category: 'control' },
  { type: 'notification', category: 'notification' },
];

const CATEGORY_ORDER: StepCategory[] = ['data', 'quality', 'control', 'notification'];

const CATEGORY_VARIANT: Record<StepCategory, 'default' | 'success' | 'warning' | 'error' | 'info'> =
  {
    data: 'info',
    quality: 'success',
    control: 'warning',
    notification: 'default',
  };

/**
 * The step types the palette adds: the ones a pipeline built on this page can
 * run, as `paletteBlocker` reads them.
 *
 * It listed all fifteen, ten of them disabled: the five that write to an org
 * marked "Not in pipelines", and Script, Approval, Loop, Parallel and
 * Condition — which runs, but gets no condition from this page — marked
 * "Coming soon". None of the ten could be added, and all ten read as on
 * offer. The note above the list says where the steps that write to an org
 * run instead, since those are the ones a reader comes looking for.
 */
const OFFERED_ENTRIES = STEP_ENTRIES.filter((entry) => paletteBlocker(entry.type) === undefined);

/** Palette of the step types a pipeline runs, grouped by category. */
export const StepPalette: React.FC<StepPaletteProps> = ({ onAddStep }) => {
  const { t } = useTranslation();

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    steps: OFFERED_ENTRIES.filter((s) => s.category === category),
  })).filter(({ steps }) => steps.length > 0);

  return (
    <div className="flex flex-col gap-3" data-testid="step-palette">
      <h3 className="text-xs font-semibold text-(--sf-text-primary)">{t('automation.steps')}</h3>
      <p className="text-[10px] text-(--sf-text-secondary)" data-testid="palette-runnable-note">
        {t('automation.runnability.paletteNote')}
      </p>
      {grouped.map(({ category, steps }) => (
        <div key={category}>
          <span className="text-[10px] uppercase text-(--sf-text-secondary)">
            {t(`automation.stepCategories.${category}`)}
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {steps.map((entry) => (
              <button
                key={entry.type}
                type="button"
                className="flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors bg-(--sf-bg-primary) border-(--sf-border) hover:border-(--sf-accent)"
                onClick={() => onAddStep?.(entry.type)}
                data-testid={`palette-${entry.type}`}
              >
                <Badge variant={CATEGORY_VARIANT[entry.category]} className="text-[9px]">
                  {t(`automation.stepTypes.${entry.type}`)}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
