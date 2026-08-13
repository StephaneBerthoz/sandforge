import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** Status types for timeline items. */
export type TimelineStatus = 'success' | 'error' | 'warning' | 'info';

/** A single timeline entry. */
export interface TimelineItem {
  title: string;
  description?: string;
  timestamp: string;
  status?: TimelineStatus;
}

/** Timeline component props. */
export interface TimelineProps {
  items: TimelineItem[];
  className?: string;
}

const statusDotClasses: Record<TimelineStatus, string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
};

/** Vertical timeline displaying events with status indicators. */
export const Timeline: React.FC<TimelineProps> = ({ items, className }) => {
  const { t } = useTranslation();

  return (
    <div
      className={cn('relative', className)}
      role="list"
      aria-label={t('a11y.timeline', 'Timeline')}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        const dotClass = item.status
          ? statusDotClasses[item.status]
          : 'bg-[var(--vscode-descriptionForeground,#868686)]';

        return (
          <div key={index} className="relative flex gap-3 pb-6 last:pb-0" role="listitem">
            {/* Dot and connector */}
            <div className="flex flex-col items-center">
              <div
                className={cn('w-3 h-3 rounded-full shrink-0 mt-1', dotClass)}
                aria-hidden="true"
              />
              {!isLast && (
                <div
                  className="w-px flex-1 bg-[var(--vscode-panel-border,#3c3c3c)]"
                  aria-hidden="true"
                />
              )}
            </div>
            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                  {item.title}
                </span>
                <time className="text-[11px] text-[var(--vscode-descriptionForeground,#868686)] whitespace-nowrap shrink-0">
                  {item.timestamp}
                </time>
              </div>
              {item.description && (
                <p className="mt-0.5 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                  {item.description}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
