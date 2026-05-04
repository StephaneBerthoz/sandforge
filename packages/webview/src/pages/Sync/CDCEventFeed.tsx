import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { VirtualList } from '../../components/ui/VirtualList';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import type { CDCFeedEvent } from '../../stores/useCDCLiveStore';

/** Map CDC change type to badge variant color. */
const changeTypeVariantMap: Record<string, BadgeVariant> = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'error',
  UNDELETE: 'warning',
};

/** Maximum record IDs to show before truncating. */
const MAX_VISIBLE_IDS = 2;

/** Ring buffer capacity. */
const RING_BUFFER_CAPACITY = 5000;

/**
 * Format a timestamp as a relative "Xs ago" string.
 * Falls back to showing seconds for simplicity.
 */
function formatRelativeTime(isoTimestamp: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/** Render a single event row in the feed. */
const EventRow: React.FC<{ event: CDCFeedEvent; index: number }> = ({ event, index }) => {
  const { t } = useTranslation();
  const visibleIds = event.recordIds.slice(0, MAX_VISIBLE_IDS);
  const hiddenCount = event.recordIds.length - MAX_VISIBLE_IDS;

  return (
    <div
      className="flex items-center gap-[var(--sf-space-2)] px-2 py-1 text-[11px] border-b border-[var(--vscode-panel-border)] hover:bg-[var(--vscode-list-hoverBackground)]"
      data-testid={`cdc-event-row-${index}`}
    >
      {/* Timestamp */}
      <span
        className="w-[60px] shrink-0 text-[var(--vscode-descriptionForeground,#868686)]"
        title={event.commitTimestamp}
      >
        {formatRelativeTime(event.commitTimestamp)}
      </span>

      {/* Object name */}
      <span className="w-[100px] shrink-0 font-medium text-[var(--vscode-editor-foreground,#d4d4d4)] truncate">
        {event.objectApiName}
      </span>

      {/* Change type badge */}
      <span className="w-[70px] shrink-0">
        <Badge variant={changeTypeVariantMap[event.changeType] ?? 'default'}>
          {t(`sync.realtime.changeTypes.${event.changeType}`, event.changeType)}
        </Badge>
      </span>

      {/* Record IDs */}
      <span
        className="flex-1 truncate text-[var(--vscode-descriptionForeground,#868686)]"
        title={event.recordIds.join(', ')}
      >
        {visibleIds.join(', ')}
        {hiddenCount > 0 && (
          <span className="ml-1 text-[var(--vscode-descriptionForeground)]">
            {t('sync.realtime.nMore', { count: hiddenCount })}
          </span>
        )}
      </span>

      {/* Applied status */}
      <span className="w-[20px] shrink-0 text-center">
        {event.error ? (
          <span
            className="codicon codicon-error text-[var(--vscode-errorForeground,#f48771)]"
            title={event.error}
          />
        ) : event.applied ? (
          <span className="codicon codicon-check text-[var(--vscode-testing-iconPassed,#73c991)]" />
        ) : (
          <span className="codicon codicon-loading codicon-modifier-spin text-[var(--vscode-descriptionForeground,#868686)]" />
        )}
      </span>
    </div>
  );
};

/**
 * CDC event feed component: renders a virtual-scrolled list of CDC events.
 * Shows header row with column labels and footer with total event count.
 */
export const CDCEventFeed: React.FC = () => {
  const { t } = useTranslation();
  const events = useCDCLiveStore((s) => s.events);
  const eventCount = useCDCLiveStore((s) => s.eventCount);

  return (
    <div className="flex flex-col flex-1 min-h-0" data-testid="cdc-event-feed">
      {/* Header */}
      <div className="flex items-center gap-[var(--sf-space-2)] px-2 py-1 text-[10px] font-semibold text-[var(--vscode-descriptionForeground,#868686)] border-b border-[var(--vscode-panel-border)] uppercase tracking-wider">
        <span className="w-[60px] shrink-0">{t('common.time', 'Time')}</span>
        <span className="w-[100px] shrink-0">{t('common.object', 'Object')}</span>
        <span className="w-[70px] shrink-0">{t('common.type', 'Type')}</span>
        <span className="flex-1">{t('common.recordIds', 'Record IDs')}</span>
        <span className="w-[20px] shrink-0 text-center">{t('common.statusAbbrev', 'St')}</span>
      </div>

      {/* Event list */}
      {events.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
          {t('sync.realtime.noEvents')}
        </div>
      ) : (
        <VirtualList
          items={events}
          renderItem={(event, index) => <EventRow event={event} index={index} />}
          keyExtractor={(event) => String(event.replayId)}
          estimatedItemHeight={28}
          maxHeight="100%"
          overscan={10}
          className="flex-1"
        />
      )}

      {/* Footer */}
      <div
        className="flex items-center justify-between px-2 py-1 text-[10px] text-[var(--vscode-descriptionForeground,#868686)] border-t border-[var(--vscode-panel-border)]"
        data-testid="cdc-event-count"
      >
        <span>
          {eventCount} {t('sync.realtime.events')}
        </span>
        {eventCount > RING_BUFFER_CAPACITY && <span>{t('sync.realtime.bufferFull')}</span>}
      </div>
    </div>
  );
};
