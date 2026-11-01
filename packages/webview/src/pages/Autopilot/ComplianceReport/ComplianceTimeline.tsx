import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ComplianceReportEntry } from '@sandforge/shared';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import type { NodeFinishStatus } from '../../../stores/useAutopilotStore';
import { dateTimeFormat } from '../../../utils/formatters';

/** Props for the ComplianceTimeline component. */
export interface ComplianceTimelineProps {
  /** The report's entries: the fields anonymized, per object. */
  readonly entries: readonly ComplianceReportEntry[];
}

/** The key of each status a node ends on. */
const STATUS_KEY: Record<NodeFinishStatus, string> = {
  completed: 'autopilot.graph.completed',
  failed: 'autopilot.graph.failed',
  skipped: 'autopilot.graph.skipped',
};

/**
 * When each object of the run finished, and on what: the time the host
 * stamped on the message that settled it, kept by the store as it came.
 *
 * It stamped every object with the time it was drawn, the same for all and
 * moving on every redraw, called a node still writing "Completed", and
 * counted the rules of a list nothing filled. A report a consultant may hand
 * on carries no time nobody stamped: an object the store holds no time for is
 * left out, and with none at all the timeline is not drawn.
 */
export const ComplianceTimeline: React.FC<ComplianceTimelineProps> = ({ entries }) => {
  const { t } = useTranslation();
  const finishes = useAutopilotStore((s) => s.nodeFinishes);

  const rows = Object.entries(finishes)
    .map(([objectName, finish]) => ({
      objectName,
      ...finish,
      fieldsAnonymized: entries.filter((entry) => entry.objectApiName === objectName).length,
    }))
    .sort((a, b) => a.at - b.at || a.objectName.localeCompare(b.objectName));

  if (rows.length === 0) return null;

  const format = dateTimeFormat({ dateStyle: 'short', timeStyle: 'medium' });

  return (
    <section aria-labelledby="compliance-timeline-heading">
      <h4 id="compliance-timeline-heading" className="text-sm font-semibold text-text-primary mb-2">
        {t('autopilot.report.timeline')}
      </h4>
      <ol className="flex flex-col gap-2" data-testid="compliance-timeline">
        {rows.map((row) => (
          <li
            key={row.objectName}
            className="flex items-start gap-3 px-3 py-2 rounded-sm bg-(--sf-bg-primary)"
            data-testid={`compliance-timeline-${row.objectName}`}
          >
            <div className="w-2 h-2 mt-1.5 rounded-full bg-(--sf-progress-bg) shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-(--sf-text-primary)">
                  {row.objectName}
                </span>
                <time
                  dateTime={new Date(row.at).toISOString()}
                  className="text-[10px] text-(--sf-text-secondary)"
                >
                  {format.format(new Date(row.at))}
                </time>
              </div>
              <div className="text-[10px] text-(--sf-text-secondary)">
                {t(STATUS_KEY[row.status])}
                {row.fieldsAnonymized > 0 &&
                  ` — ${t('autopilot.control.piiFieldCount', { count: row.fieldsAnonymized })}`}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
};
