import React from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '../../theme';
import { SPRING } from '../../motion/presets';

/** Props for SplitView master/detail layout. */
export interface SplitViewProps {
  /** Content rendered in the left (main) panel. */
  left: React.ReactNode;
  /** Content rendered in the right (detail) panel. */
  right: React.ReactNode;
  /** Width ratio between left and right panels. */
  ratio?: '50/50' | '60/40' | '70/30';
  /** Whether the right panel is collapsed. */
  rightCollapsed?: boolean;
  /** Callback fired when the toggle button is clicked. */
  onToggleRight?: () => void;
  /** Additional CSS classes for the root container. */
  className?: string;
}

/** Tailwind basis classes for left panel per ratio. */
const leftBasisClass: Record<string, string> = {
  '50/50': 'basis-1/2',
  '60/40': 'basis-3/5',
  '70/30': 'basis-7/12',
};

/** Tailwind basis classes for right panel per ratio. */
const rightBasisClass: Record<string, string> = {
  '50/50': 'basis-1/2',
  '60/40': 'basis-2/5',
  '70/30': 'basis-5/12',
};

/**
 * Resizable master/detail split layout with animated collapsible right panel.
 * Uses framer-motion AnimatePresence for smooth width transitions.
 */
export const SplitView: React.FC<SplitViewProps> = ({
  left,
  right,
  ratio = '60/40',
  rightCollapsed = false,
  onToggleRight,
  className,
}) => {
  return (
    <div className={cn('flex h-full', className)} data-testid="splitview">
      {/* Left (main) panel */}
      <div
        className={cn('flex-1 min-w-0 overflow-auto', leftBasisClass[ratio])}
        data-testid="splitview-left"
      >
        {left}
      </div>

      {/* Toggle button */}
      <button
        type="button"
        className="relative z-10 flex items-center justify-center w-6 shrink-0 hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors"
        onClick={onToggleRight}
        data-testid="splitview-toggle"
        aria-label={rightCollapsed ? 'Expand right panel' : 'Collapse right panel'}
      >
        {rightCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
      </button>

      {/* Right (detail) panel */}
      <AnimatePresence initial={false}>
        {!rightCollapsed && (
          <m.div
            key="splitview-right"
            className={cn('overflow-auto border-l border-subtle', rightBasisClass[ratio])}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={SPRING}
            data-testid="splitview-right"
          >
            {right}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
};
