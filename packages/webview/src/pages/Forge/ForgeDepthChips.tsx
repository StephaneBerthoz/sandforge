import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import type { ForgeDepth } from '../../stores/useForgeStore';
import { DEPTH_OPTIONS, DEPTH_KEYS, DEPTH_TOOLTIP_KEYS } from './useForgeForm';

/**
 * The deepest custom depth a discovery accepts: `forgeConfigSchema` caps
 * `customDepth` at 10, and discovery walks no further whatever it is sent.
 * The field let a user type up to 20, and anything past 10 had discovery
 * refused outright. Past ten levels a CRM org's graph runs into thousands of
 * describes, spending its API limits without producing a graph anyone can
 * use, which is why the cap is there; the hint under the field says so.
 */
export const MAX_CUSTOM_DEPTH = 10;

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
  const hintId = useId();

  return (
    <div>
      <div className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">
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
                ? 'bg-forge/15 border-forge text-hue-forge'
                : 'bg-transparent border-subtle text-text-secondary hover:border-forge/30 hover:text-text-primary',
            )}
          >
            {t(DEPTH_KEYS[d])}
          </button>
        ))}
        {depth === 'custom' && (
          <input
            type="number"
            min={1}
            max={MAX_CUSTOM_DEPTH}
            value={customDepth}
            // A number typed past the cap is brought down to it: `max` only
            // bounds the spinner arrows, not what is typed.
            onChange={(e) =>
              onCustomDepthChange(Math.min(MAX_CUSTOM_DEPTH, Number(e.target.value)))
            }
            aria-label={t('forge.depthCustom')}
            aria-describedby={hintId}
            data-testid="forge-depth-custom-input"
            className={cn(
              'w-16 px-2 py-1.5 rounded-full text-xs text-center',
              'bg-(--sf-bg-input)',
              'text-(--sf-text-input)',
              'border border-(--sf-border-input)',
            )}
          />
        )}
      </div>
      {depth === 'custom' && (
        <p
          id={hintId}
          className="mt-1.5 text-[10px] text-text-secondary"
          data-testid="forge-depth-custom-hint"
        >
          {t('forge.depthCustomHint', { max: MAX_CUSTOM_DEPTH })}
        </p>
      )}
    </div>
  );
};
