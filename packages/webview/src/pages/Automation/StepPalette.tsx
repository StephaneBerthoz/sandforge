import React, { useId } from 'react';
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
 * Palette of available step types grouped by category.
 *
 * A step type a pipeline cannot run is shown, but its button is disabled: a
 * pipeline holding one is refused before it starts, so adding it would only
 * build a pipeline that cannot run. The steps that write to an org are
 * refused on purpose, not for now — each runs from its own page, where
 * Production Guard asks before a write to a production org — so they are
 * marked apart from the ones still to come. The note above the list says why,
 * each disabled entry is described by it, and its title gives its own reason.
 */
export const StepPalette: React.FC<StepPaletteProps> = ({ onAddStep }) => {
  const { t } = useTranslation();
  const noteId = useId();

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    steps: STEP_ENTRIES.filter((s) => s.category === category),
  }));

  return (
    <div className="flex flex-col gap-3" data-testid="step-palette">
      <h3 className="text-xs font-semibold text-[var(--sf-text-primary)]">
        {t('automation.steps')}
      </h3>
      <p
        id={noteId}
        className="text-[10px] text-[var(--sf-text-secondary)]"
        data-testid="palette-runnable-note"
      >
        {t('automation.runnability.paletteNote')}
      </p>
      {grouped.map(({ category, steps }) => (
        <div key={category}>
          <span className="text-[10px] uppercase text-[var(--sf-text-secondary)]">
            {t(`automation.stepCategories.${category}`)}
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {steps.map((entry) => {
              const blocker = paletteBlocker(entry.type);
              return (
                <button
                  key={entry.type}
                  type="button"
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors bg-[var(--sf-bg-primary)] ${
                    blocker === undefined
                      ? 'border-[var(--sf-border)] hover:border-[var(--sf-accent)]'
                      : 'border-dashed border-[var(--sf-border)] cursor-not-allowed'
                  }`}
                  onClick={() => onAddStep?.(entry.type)}
                  disabled={blocker !== undefined}
                  title={blocker === undefined ? undefined : t(`automation.runnability.${blocker}`)}
                  aria-describedby={blocker === undefined ? undefined : noteId}
                  data-testid={`palette-${entry.type}`}
                >
                  <Badge variant={CATEGORY_VARIANT[entry.category]} className="text-[9px]">
                    {t(`automation.stepTypes.${entry.type}`)}
                  </Badge>
                  {blocker !== undefined && (
                    <span
                      className="text-[9px] text-[var(--sf-text-secondary)]"
                      data-testid={`palette-${entry.type}-soon`}
                    >
                      {blocker === 'writesToOrg'
                        ? t('automation.runnability.notInPipelines')
                        : t('common.comingSoon')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
