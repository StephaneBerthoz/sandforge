import React from 'react';
import { cn } from '../../theme';

/** Module identifier for contextual illustrations. */
export type EmptyStateModule =
  | 'seed'
  | 'sync'
  | 'monitor'
  | 'compare'
  | 'dataops'
  | 'automation'
  | 'forge'
  | 'autopilot';

/** EmptyState component props. */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Module identifier for inline SVG illustration. */
  module?: EmptyStateModule;
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

/** Inline SVG illustrations per module (simple geometric shapes). */
const MODULE_ILLUSTRATIONS: Record<EmptyStateModule, React.ReactNode> = {
  seed: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-seed"
    >
      <circle cx="32" cy="32" r="28" stroke="#10B981" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M32 16c0 16-12 20-12 28h24c0-8-12-12-12-28z" fill="#10B981" fillOpacity="0.2" />
      <path d="M32 16v28" stroke="#10B981" strokeWidth="2" />
      <circle cx="32" cy="48" r="4" fill="#10B981" />
    </svg>
  ),
  sync: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-sync"
    >
      <circle cx="32" cy="32" r="28" stroke="#3B82F6" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M20 28l12-8v6h12v4H32v6l-12-8z" fill="#3B82F6" fillOpacity="0.3" />
      <path d="M44 36l-12 8v-6H20v-4h12v-6l12 8z" fill="#3B82F6" fillOpacity="0.3" />
    </svg>
  ),
  monitor: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-monitor"
    >
      <circle cx="32" cy="32" r="28" stroke="#F59E0B" strokeWidth="2" strokeDasharray="4 4" />
      <rect x="18" y="22" width="28" height="20" rx="3" stroke="#F59E0B" strokeWidth="2" />
      <polyline points="22,38 28,30 34,34 42,26" stroke="#F59E0B" strokeWidth="2" fill="none" />
    </svg>
  ),
  compare: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-compare"
    >
      <circle cx="32" cy="32" r="28" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="4 4" />
      <rect x="14" y="20" width="16" height="24" rx="2" stroke="#8B5CF6" strokeWidth="2" />
      <rect x="34" y="20" width="16" height="24" rx="2" stroke="#8B5CF6" strokeWidth="2" />
      <path d="M30 32h4" stroke="#8B5CF6" strokeWidth="2" />
    </svg>
  ),
  dataops: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-dataops"
    >
      <circle cx="32" cy="32" r="28" stroke="#EF4444" strokeWidth="2" strokeDasharray="4 4" />
      <ellipse cx="32" cy="24" rx="14" ry="6" stroke="#EF4444" strokeWidth="2" />
      <path d="M18 24v16c0 3.3 6.3 6 14 6s14-2.7 14-6V24" stroke="#EF4444" strokeWidth="2" />
      <path d="M18 32c0 3.3 6.3 6 14 6s14-2.7 14-6" stroke="#EF4444" strokeWidth="2" />
    </svg>
  ),
  automation: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-automation"
    >
      <circle cx="32" cy="32" r="28" stroke="#F97316" strokeWidth="2" strokeDasharray="4 4" />
      <circle cx="20" cy="20" r="6" stroke="#F97316" strokeWidth="2" />
      <circle cx="44" cy="20" r="6" stroke="#F97316" strokeWidth="2" />
      <circle cx="32" cy="44" r="6" stroke="#F97316" strokeWidth="2" />
      <path d="M24 24l4 16M40 24l-4 16" stroke="#F97316" strokeWidth="2" />
    </svg>
  ),
  forge: (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      data-testid="illustration-forge"
    >
      <circle cx="32" cy="32" r="28" stroke="#E8A838" strokeWidth="2" strokeDasharray="4 4" />
      <rect
        x="20"
        y="36"
        width="24"
        height="6"
        rx="1"
        stroke="#E8A838"
        strokeWidth="2"
        fill="#E8A838"
        fillOpacity="0.15"
      />
      <path d="M28 36V22l4-4 4 4v14" stroke="#E8A838" strokeWidth="2" />
      <path d="M26 22h12" stroke="#E8A838" strokeWidth="2" />
      <circle
        cx="32"
        cy="48"
        r="3"
        fill="#E8A838"
        fillOpacity="0.3"
        stroke="#E8A838"
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
      data-testid="illustration-autopilot"
    >
      <circle cx="32" cy="32" r="28" stroke="#06B6D4" strokeWidth="2" strokeDasharray="4 4" />
      <circle cx="32" cy="32" r="12" stroke="#06B6D4" strokeWidth="2" />
      <path d="M32 20v6M32 38v6M20 32h6M38 32h6" stroke="#06B6D4" strokeWidth="2" />
      <path
        d="M32 28l3 4-3 4-3-4z"
        fill="#06B6D4"
        fillOpacity="0.3"
        stroke="#06B6D4"
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
        <div className="text-3xl text-[var(--vscode-descriptionForeground,#868686)] mb-3">
          {icon}
        </div>
      )}

      <h3 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {title}
      </h3>
      {description && (
        <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-1 max-w-xs">
          {description}
        </p>
      )}

      {/* Encouragement message */}
      {encouragement && (
        <p
          className="text-xs mt-2 max-w-xs"
          style={{ color: 'var(--sf-accent, #E8A838)' }}
          data-testid="empty-encouragement"
        >
          {encouragement}
        </p>
      )}

      {/* Primary action button */}
      {actionLabel && onAction && (
        <button
          className="mt-4 px-3 py-1.5 text-sm rounded font-medium"
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
