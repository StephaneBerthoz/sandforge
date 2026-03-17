import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineStepType } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';

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

const CATEGORY_VARIANT: Record<StepCategory, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  data: 'info',
  quality: 'success',
  control: 'warning',
  notification: 'default',
};

/** Palette of available step types grouped by category. */
export const StepPalette: React.FC<StepPaletteProps> = ({ onAddStep }) => {
  const { t } = useTranslation();

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    steps: STEP_ENTRIES.filter((s) => s.category === category),
  }));

  return (
    <div className="flex flex-col gap-3" data-testid="step-palette">
      <h3 className="text-xs font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('automation.steps')}
      </h3>
      {grouped.map(({ category, steps }) => (
        <div key={category}>
          <span className="text-[10px] uppercase text-[var(--vscode-descriptionForeground,#868686)]">
            {t(`automation.stepCategories.${category}`)}
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {steps.map((entry) => (
              <button
                key={entry.type}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[var(--vscode-panel-border,#3c3c3c)] hover:border-[var(--vscode-focusBorder,#007fd4)] transition-colors bg-[var(--vscode-editor-background,#1e1e1e)]"
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
