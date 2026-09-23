import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RealTimeEventOutcome } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { VirtualList } from '../../components/ui/VirtualList';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';
import type { CDCFeedEvent } from '../../stores/useCDCLiveStore';
import { formatRelativeTime } from '../../utils/formatters';

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

/** The icon of each outcome; its words come from `sync.realtime.outcome.*`. */
const OUTCOME_ICONS: Record<RealTimeEventOutcome, string> = {
  applied: 'codicon-check text-status-success',
  failed: 'codicon-error text-status-error',
  watched: 'codicon-eye text-[var(--sf-text-secondary)]',
  'kept-target': 'codicon-shield text-status-warning',
  held: 'codicon-question text-status-warning',
  'deletes-off': 'codicon-circle-slash text-[var(--sf-text-secondary)]',
  'own-write': 'codicon-reply text-[var(--sf-text-secondary)]',
};

/**
 * What became of a change. The singular `realtime:event` channel carries no
 * outcome, only `applied` and `error`: those two say it.
 */
function outcomeOf(event: CDCFeedEvent): RealTimeEventOutcome {
  if (event.outcome) return event.outcome;
  if (event.error) return 'failed';
  return event.applied ? 'applied' : 'watched';
}

/** Render a single event row in the feed. */
const EventRow: React.FC<{ event: CDCFeedEvent; index: number }> = ({ event, index }) => {
  const { t } = useTranslation();
  const visibleIds = event.recordIds.slice(0, MAX_VISIBLE_IDS);
  const hiddenCount = event.recordIds.length - MAX_VISIBLE_IDS;
  const outcome = outcomeOf(event);
  const outcomeLabel = t(`sync.realtime.outcome.${outcome}`);

  return (
    <div
      className="flex items-center gap-[var(--sf-space-2)] px-2 py-1 text-[11px] border-b border-[var(--sf-border)] hover:bg-[var(--sf-bg-hover)]"
      data-testid={`cdc-event-row-${index}`}
      data-outcome={outcome}
    >
      {/* Timestamp */}
      <span
        className="w-[60px] shrink-0 text-[var(--sf-text-primary)]"
        title={event.commitTimestamp}
      >
        {formatRelativeTime(new Date(event.commitTimestamp))}
      </span>

      {/* Object name */}
      <span className="w-[100px] shrink-0 font-medium text-[var(--sf-text-primary)] truncate">
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
        className="flex-1 truncate text-[var(--sf-text-primary)]"
        title={event.recordIds.join(', ')}
      >
        {visibleIds.join(', ')}
        {hiddenCount > 0 && (
          <span className="ml-1 text-[var(--sf-text-primary)]">
            {t('sync.realtime.nMore', { count: hiddenCount })}
          </span>
        )}
      </span>

      {/* What became of it: an icon, its words for a screen reader, the reason on hover */}
      <span className="w-[20px] shrink-0 text-center">
        <span
          className={`codicon ${OUTCOME_ICONS[outcome]}`}
          title={event.error ?? outcomeLabel}
          aria-hidden="true"
        />
        <span className="sr-only">
          {event.error ? `${outcomeLabel}: ${event.error}` : outcomeLabel}
        </span>
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
      <div className="flex items-center gap-[var(--sf-space-2)] px-2 py-1 text-[10px] font-semibold text-[var(--sf-text-secondary)] border-b border-[var(--sf-border)] uppercase tracking-wider">
        <span className="w-[60px] shrink-0">{t('common.time', 'Time')}</span>
        <span className="w-[100px] shrink-0">{t('common.object', 'Object')}</span>
        <span className="w-[70px] shrink-0">{t('common.type', 'Type')}</span>
        <span className="flex-1">{t('common.recordIds', 'Record IDs')}</span>
        <span className="w-[20px] shrink-0 text-center">{t('common.statusAbbrev', 'St')}</span>
      </div>

      {/* Event list */}
      {events.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-xs text-[var(--sf-text-secondary)]">
          {t('sync.realtime.noEvents')}
        </div>
      ) : (
        <VirtualList
          items={events}
          renderItem={(event, index) => <EventRow event={event} index={index} />}
          // A replay id counts within its channel, one channel per object: two
          // objects can each have an event 42.
          keyExtractor={(event) => `${event.objectApiName}:${event.replayId}`}
          estimatedItemHeight={28}
          maxHeight="100%"
          overscan={10}
          className="flex-1"
        />
      )}

      {/* Footer */}
      <div
        className="flex items-center justify-between px-2 py-1 text-[10px] text-[var(--sf-text-secondary)] border-t border-[var(--sf-border)]"
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
