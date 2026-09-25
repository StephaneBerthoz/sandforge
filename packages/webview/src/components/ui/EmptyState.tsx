import React from 'react';
import { cn } from '../../theme';

/** Module identifier for contextual illustrations. */
export type EmptyStateModule =
  'seed' | 'sync' | 'monitor' | 'compare' | 'dataops' | 'automation' | 'forge' | 'autopilot';

/** EmptyState component props. */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Module identifier for inline SVG illustration. */
  module?: EmptyStateModule;
  /** Ordered actionable steps displayed below the description. */
  steps?: string[];
  /** Contextual encouragement message displayed below the description. */
  encouragement?: string;
  /** Label for a primary action button. */
  actionLabel?: string;
  /** Callback when the primary action button is clicked. */
  onAction?: () => void;
  /** Label for a documentation link. */
  docLabel?: string;
  /** Callback when the documentation link is clicked. */
  onDocClick?: () => void;
  /** Label for a guided tour link. */
  tourLabel?: string;
  /** Callback when the guided tour link is clicked. */
  onTourClick?: () => void;
}

/**
 * Inline SVG illustrations per module (simple geometric shapes). Each draws in
 * currentColor under the module's identity hue token, so the line work follows
 * the theme: the fixed hexes it replaced were picked for a dark editor.
 */
const MODULE_ILLUSTRATIONS: Record<EmptyStateModule, React.ReactNode> = {
  seed: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-green"
      data-testid="illustration-seed"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M32 16c0 16-12 20-12 28h24c0-8-12-12-12-28z" fill="currentColor" fillOpacity="0.2" />
      <path d="M32 16v28" stroke="currentColor" strokeWidth="2" />
      <circle cx="32" cy="48" r="4" fill="currentColor" />
    </svg>
  ),
  sync: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-blue"
      data-testid="illustration-sync"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M20 28l12-8v6h12v4H32v6l-12-8z" fill="currentColor" fillOpacity="0.3" />
      <path d="M44 36l-12 8v-6H20v-4h12v-6l12 8z" fill="currentColor" fillOpacity="0.3" />
    </svg>
  ),
  monitor: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-amber"
      data-testid="illustration-monitor"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <rect x="18" y="22" width="28" height="20" rx="3" stroke="currentColor" strokeWidth="2" />
      <polyline
        points="22,38 28,30 34,34 42,26"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
    </svg>
  ),
  compare: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-purple"
      data-testid="illustration-compare"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <rect x="14" y="20" width="16" height="24" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="34" y="20" width="16" height="24" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M30 32h4" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  dataops: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-rose"
      data-testid="illustration-dataops"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <ellipse cx="32" cy="24" rx="14" ry="6" stroke="currentColor" strokeWidth="2" />
      <path d="M18 24v16c0 3.3 6.3 6 14 6s14-2.7 14-6V24" stroke="currentColor" strokeWidth="2" />
      <path d="M18 32c0 3.3 6.3 6 14 6s14-2.7 14-6" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  automation: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-orange"
      data-testid="illustration-automation"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <circle cx="20" cy="20" r="6" stroke="currentColor" strokeWidth="2" />
      <circle cx="44" cy="20" r="6" stroke="currentColor" strokeWidth="2" />
      <circle cx="32" cy="44" r="6" stroke="currentColor" strokeWidth="2" />
      <path d="M24 24l4 16M40 24l-4 16" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  forge: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-amber"
      data-testid="illustration-forge"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <rect
        x="20"
        y="36"
        width="24"
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="2"
        fill="currentColor"
        fillOpacity="0.15"
      />
      <path d="M28 36V22l4-4 4 4v14" stroke="currentColor" strokeWidth="2" />
      <path d="M26 22h12" stroke="currentColor" strokeWidth="2" />
      <circle
        cx="32"
        cy="48"
        r="3"
        fill="currentColor"
        fillOpacity="0.3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  ),
  autopilot: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="text-hue-cyan"
      data-testid="illustration-autopilot"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
      <circle cx="32" cy="32" r="12" stroke="currentColor" strokeWidth="2" />
      <path d="M32 20v6M32 38v6M20 32h6M38 32h6" stroke="currentColor" strokeWidth="2" />
      <path
        d="M32 28l3 4-3 4-3-4z"
        fill="currentColor"
        fillOpacity="0.3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  ),
};

/** Empty state placeholder for lists/pages with no data. */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className,
  module,
  steps,
  encouragement,
  actionLabel,
  onAction,
  docLabel,
  onDocClick,
  tourLabel,
  onTourClick,
}) => {
  return (
    <div
      className={cn('flex flex-col items-center justify-center py-12 px-4 text-center', className)}
      data-testid="empty-state"
    >
      {/* Module illustration */}
      {module && MODULE_ILLUSTRATIONS[module] && (
        <div className="mb-4" data-testid={`empty-illustration-${module}`}>
          {MODULE_ILLUSTRATIONS[module]}
        </div>
      )}

      {/* Custom icon fallback */}
      {!module && icon && (
        <div className="text-3xl text-(--vscode-descriptionForeground,#868686) mb-3">{icon}</div>
      )}

      <h3 className="text-sm font-semibold text-(--vscode-editor-foreground,#d4d4d4)">{title}</h3>
      {description && (
        <p className="text-xs text-(--vscode-descriptionForeground,#868686) mt-1 max-w-xs">
          {description}
        </p>
      )}

      {/* Ordered actionable steps */}
      {steps && steps.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1.5 text-left max-w-xs" data-testid="empty-steps">
          {steps.map((step, index) => (
            <li
              key={index}
              className="flex items-start gap-2 text-xs text-(--vscode-descriptionForeground,#868686)"
              data-testid={`empty-step-${String(index)}`}
            >
              <span
                className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold mt-px"
                style={{ background: 'var(--sf-button-bg)', color: 'var(--sf-button-fg)' }}
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}

      {/* Encouragement message */}
      {encouragement && (
        <p
          className="text-xs mt-2 max-w-xs"
          style={{ color: 'var(--sf-text-link)' }}
          data-testid="empty-encouragement"
        >
          {encouragement}
        </p>
      )}

      {/* Primary action button */}
      {actionLabel && onAction && (
        <button
          className="mt-4 px-3 py-1.5 text-sm rounded-sm font-medium"
          style={{
            background: 'var(--vscode-button-background, #0e639c)',
            color: 'var(--vscode-button-foreground, #fff)',
          }}
          onClick={onAction}
          data-testid="empty-action-button"
        >
          {actionLabel}
        </button>
      )}

      {/* Legacy action slot */}
      {action && <div className="mt-4">{action}</div>}

      {/* Links row */}
      {(docLabel || tourLabel) && (
        <div className="flex gap-4 mt-3">
          {docLabel && onDocClick && (
            <button
              className="text-xs underline"
              style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}
              onClick={onDocClick}
              data-testid="empty-doc-link"
            >
              {docLabel}
            </button>
          )}
          {tourLabel && onTourClick && (
            <button
              className="text-xs underline"
              style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}
              onClick={onTourClick}
              data-testid="empty-tour-link"
            >
              {tourLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
