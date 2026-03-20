import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download } from 'lucide-react';
import { cn } from '../../theme';

/** Single log entry. */
export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

/** Filter type for log entries. */
export type LogFilter = 'all' | 'error' | 'warn';

/** Props for LogStream component. */
export interface LogStreamProps {
  entries: LogEntry[];
  filter?: LogFilter;
  maxEntries?: number;
  autoScroll?: boolean;
  /** When true, hides the internal filter tab bar (parent provides its own). */
  hideFilterBar?: boolean;
  className?: string;
}

const FILTER_TABS: { key: LogFilter; label: string; testId: string }[] = [
  { key: 'all', label: 'All', testId: 'logstream-filter-all' },
  { key: 'error', label: 'Errors', testId: 'logstream-filter-error' },
  { key: 'warn', label: 'Warnings', testId: 'logstream-filter-warn' },
];

const levelColorClasses: Record<LogEntry['level'], string> = {
  info: 'text-text-secondary',
  warn: 'text-monitor',
  error: 'text-automation',
  debug: 'text-text-muted',
};

const levelBadgeBgClasses: Record<LogEntry['level'], string> = {
  info: 'bg-text-secondary/20',
  warn: 'bg-monitor/20',
  error: 'bg-automation/20',
  debug: 'bg-text-muted/20',
};

/** Format a Unix-ms timestamp as HH:mm:ss. */
function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toTimeString().slice(0, 8);
}

/** Filter entries based on the active filter. Returns original array for 'all' (no copy). */
function filterEntries(entries: readonly LogEntry[], filter: LogFilter): readonly LogEntry[] {
  switch (filter) {
    case 'error':
      return entries.filter((e) => e.level === 'error');
    case 'warn':
      return entries.filter((e) => e.level === 'warn' || e.level === 'error');
    default:
      return entries;
  }
}

/** Real-time scrollable log viewer with level-based filtering. */
export const LogStream: React.FC<LogStreamProps> = ({
  entries,
  filter: filterProp = 'all',
  maxEntries = 500,
  autoScroll = true,
  hideFilterBar = false,
  className,
}) => {
  const { t } = useTranslation();
  const [activeFilter, setActiveFilter] = useState<LogFilter>(filterProp);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  // Sync external filter prop changes to internal state
  useEffect(() => {
    setActiveFilter(filterProp);
  }, [filterProp]);

  const trimmedEntries = useMemo(
    () => entries.slice(-maxEntries),
    [entries, maxEntries],
  );

  const visibleEntries = useMemo(
    () => filterEntries(trimmedEntries, activeFilter),
    [trimmedEntries, activeFilter],
  );

  /** Detect when user scrolls away from bottom. */
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 20;
    userScrolledUpRef.current = !atBottom;
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current && !userScrolledUpRef.current) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        rafRef.current = null;
      });
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [visibleEntries, autoScroll]);

  return (
    <div
      data-testid="logstream"
      className={cn(
        'bg-surface-0 rounded-xl border border-subtle overflow-hidden flex flex-col',
        className,
      )}
    >
      {/* Filter tabs */}
      {!hideFilterBar && (
        <div className="flex gap-2 px-3 py-2 border-b border-subtle">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-testid={tab.testId}
              aria-pressed={activeFilter === tab.key}
              onClick={() => setActiveFilter(tab.key)}
              className={cn(
                'px-2 py-1 text-xs transition-colors',
                activeFilter === tab.key
                  ? 'text-text-primary font-semibold border-b-2 border-forge'
                  : 'text-text-muted hover:text-text-secondary',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar: Copy All / Export */}
      {entries.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1 border-b border-subtle">
          <button
            type="button"
            data-testid="logstream-copy-all"
            onClick={async () => {
              const text = visibleEntries
                .map((e) => `[${formatTimestamp(e.timestamp)}] [${e.level.toUpperCase()}] ${e.message}`)
                .join('\n');
              await navigator.clipboard.writeText(text);
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary transition-colors rounded hover:bg-surface-2"
            title={t('forge.copyAllLogs')}
          >
            <Copy size={10} />
            {t('forge.copyAllLogs')}
          </button>
          <button
            type="button"
            data-testid="logstream-export"
            onClick={() => {
              const text = visibleEntries
                .map((e) => `[${formatTimestamp(e.timestamp)}] [${e.level.toUpperCase()}] ${e.message}`)
                .join('\n');
              const blob = new Blob([text], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `forge-logs-${new Date().toISOString().slice(0, 10)}.log`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary transition-colors rounded hover:bg-surface-2"
            title={t('forge.exportLogs')}
          >
            <Download size={10} />
            {t('forge.exportLogs')}
          </button>
        </div>
      )}

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        className="overflow-y-auto flex-1 min-h-0 p-2 font-mono text-xs"
      >
        {visibleEntries.length === 0 ? (
          <p data-testid="logstream-empty" className="text-text-muted text-center py-4">
            No log entries
          </p>
        ) : (
          visibleEntries.map((entry) => (
            <div
              key={entry.id}
              data-testid="logstream-entry"
              className="flex items-baseline gap-2 py-0.5"
            >
              <span className="text-text-muted shrink-0">
                {formatTimestamp(entry.timestamp)}
              </span>
              <span
                className={cn(
                  'px-1 rounded text-[10px] uppercase font-medium shrink-0',
                  levelColorClasses[entry.level],
                  levelBadgeBgClasses[entry.level],
                )}
              >
                {entry.level}
              </span>
              <span className={levelColorClasses[entry.level]}>
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
