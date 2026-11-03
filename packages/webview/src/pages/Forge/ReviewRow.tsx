import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronRight, Eye, Hourglass, X } from 'lucide-react';
import { cn } from '../../theme';
import type { ReviewRowState } from './reviewSummaries';

/** The word each state is said in, with its mark and its colour: never the colour alone. */
const STATES: Readonly<
  Record<ReviewRowState, { key: string; icon: typeof Check; className: string }>
> = {
  decide: {
    key: 'forgeRun.review.state.decide',
    icon: AlertTriangle,
    className: 'font-semibold text-status-warning',
  },
  ready: { key: 'forgeRun.review.state.ready', icon: Check, className: 'text-status-success' },
  working: {
    key: 'forgeRun.review.state.working',
    icon: Hourglass,
    className: 'text-text-secondary',
  },
  failed: { key: 'forgeRun.review.state.failed', icon: X, className: 'text-status-error' },
  toRead: { key: 'forgeRun.review.state.toRead', icon: Eye, className: 'text-text-primary' },
};

/** Props of {@link ReviewRow}. */
export interface ReviewRowProps {
  /** The row's name in the page: `tab-<id>` on its button, `tabpanel-<id>` on what it opens. */
  id: string;
  /** The name the docs and the How to give this part of Review. */
  name: string;
  /** What the part comes to, in a sentence. */
  summary: React.ReactNode;
  /** Where the part stands, said at the end of the row. */
  state?: ReviewRowState | undefined;
  open: boolean;
  onToggle: () => void;
  /** In the run's column, too narrow for the row's columns at any panel width. */
  compact?: boolean;
  children: React.ReactNode;
}

/**
 * One part of Review: a button naming it, what it comes to in a sentence and
 * where it stands, over what it opens. Several can be open at once.
 *
 * A part is drawn the first time it opens, as its tab was, and asks for nothing
 * sooner. It stays drawn once closed, hidden, so that what the user chose in it
 * — a framework, an object, a draft — is there when it opens again; closed, it
 * holds no Tab stop.
 */
export const ReviewRow: React.FC<ReviewRowProps> = ({
  id,
  name,
  summary,
  state,
  open,
  onToggle,
  compact = false,
  children,
}) => {
  const { t } = useTranslation();
  const [drawn, setDrawn] = useState(open);
  if (open && !drawn) setDrawn(true);
  const said = state ? STATES[state] : undefined;
  const Mark = said?.icon;
  return (
    <div className="border-t border-subtle" data-testid={`review-row-${id}`}>
      <h3>
        <button
          type="button"
          id={`tab-${id}`}
          data-testid={`tab-${id}`}
          aria-expanded={open}
          aria-controls={`tabpanel-${id}`}
          onClick={onToggle}
          className={cn(
            'grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5',
            // Underlined on hover rather than tinted: the list's hover colour
            // took the secondary text under the row to 3.7:1.
            'group scroll-mt-2 cursor-pointer py-2.5 text-left text-sm',
            !compact && 'min-[640px]:grid-cols-[1rem_8rem_minmax(0,1fr)_auto] min-[640px]:gap-x-3',
          )}
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={cn(
              'self-center text-text-secondary transition-transform',
              open && 'rotate-90',
            )}
          />
          <span className="font-semibold text-text-primary group-hover:underline">{name}</span>
          <span
            data-testid={`review-row-${id}-summary`}
            className={cn(
              'col-span-2 col-start-2 row-start-2 min-w-0 text-text-primary [overflow-wrap:anywhere]',
              !compact && 'min-[640px]:col-span-1 min-[640px]:col-start-3 min-[640px]:row-start-1',
            )}
          >
            {summary}
          </span>
          {said && Mark && (
            <span
              data-testid={`review-row-${id}-state`}
              data-state={state}
              className={cn(
                'col-start-3 row-start-1 flex items-center gap-1 justify-self-end',
                'whitespace-nowrap text-xs',
                !compact && 'min-[640px]:col-start-4',
                said.className,
              )}
            >
              <Mark size={12} aria-hidden="true" className="shrink-0" />
              {t(said.key)}
            </span>
          )}
        </button>
      </h3>
      <div
        id={`tabpanel-${id}`}
        role="region"
        aria-label={name}
        hidden={!open}
        className={open ? 'pb-4 pt-1' : undefined}
      >
        {drawn ? children : null}
      </div>
    </div>
  );
};
