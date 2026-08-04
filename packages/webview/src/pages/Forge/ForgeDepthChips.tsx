import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import type { ForgeDepth } from '../../stores/useForgeStore';
import { DEPTH_OPTIONS, DEPTH_KEYS, DEPTH_TOOLTIP_KEYS } from './useForgeForm';

/** Props for the ForgeDepthChips component. */
export interface ForgeDepthChipsProps {
  /** Currently selected depth. */
  depth: ForgeDepth;
  /** Custom depth value (only shown when depth === 'custom'). */
  customDepth: number;
  /** Update the selected depth. */
  onDepthChange: (depth: ForgeDepth) => void;
  /** Update the custom depth value. */
  onCustomDepthChange: (value: number) => void;
  /** Arrow-key navigation handler for the radio chips. */
  onDepthKeyDown: (e: React.KeyboardEvent, currentDepth: ForgeDepth) => void;
  /** Refs to the chip buttons so keyboard nav can move DOM focus. */
  depthRefs: React.MutableRefObject<Partial<Record<ForgeDepth, HTMLButtonElement | null>>>;
}

/** Depth radio-chip selector with arrow-key navigation and custom depth input. */
export const ForgeDepthChips: React.FC<ForgeDepthChipsProps> = ({
  depth,
  customDepth,
  onDepthChange,
  onCustomDepthChange,
  onDepthKeyDown,
  depthRefs,
}) => {
  const { t } = useTranslation();

  return (
    <div>
      <div className="text-[10px] text-text-muted uppercase tracking-widest mb-2">
        {t('forge.depth')}
      </div>
      <div
        className="flex items-center gap-2 flex-wrap"
        role="radiogroup"
        aria-label={t('forge.depth', 'Depth')}
      >
        {DEPTH_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={depth === d}
            tabIndex={depth === d ? 0 : -1}
            data-testid={`forge-depth-${d}`}
            ref={(el) => {
              depthRefs.current[d] = el;
            }}
            onClick={() => onDepthChange(d)}
            onKeyDown={(e) => onDepthKeyDown(e, d)}
            title={t(DEPTH_TOOLTIP_KEYS[d])}
            className={cn(
              'px-4 py-1.5 rounded-full text-xs font-medium transition-all border',
              depth === d
                ? 'bg-forge/15 border-forge text-forge'
                : 'bg-transparent border-subtle text-text-muted hover:border-forge/30 hover:text-text-secondary',
            )}
          >
            {t(DEPTH_KEYS[d])}
          </button>
        ))}
        {depth === 'custom' && (
          <input
            type="number"
            min={1}
            max={20}
            value={customDepth}
            onChange={(e) => onCustomDepthChange(Number(e.target.value))}
            data-testid="forge-depth-custom-input"
            className={cn(
              'w-16 px-2 py-1.5 rounded-full text-xs text-center',
              'bg-[var(--sf-bg-input)]',
              'text-[var(--sf-text-input)]',
              'border border-[var(--sf-border-input)]',
            )}
          />
        )}
      </div>
    </div>
  );
};
