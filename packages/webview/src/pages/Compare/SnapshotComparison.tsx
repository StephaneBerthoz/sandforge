import React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

/** Object counts `describeGlobal` yields for one org. */
export interface OrgObjectCounts {
  orgId: string;
  totalObjects: number;
  customObjects: number;
  standardObjects: number;
  queryableObjects: number;
}

/**
 * The object `CompareHandler.handleSnapshots` puts under `snapshot`.
 *
 * One capture of both orgs, taken now — not a history. The tab used to feed it
 * to a timeline expecting `OrgSnapshot[]`, which spread it with `[...]` and
 * threw. Nothing in the extension stores snapshots over time, so that timeline
 * never had a possible input; this comparison does.
 */
export interface OrgSnapshotComparison {
  source: OrgObjectCounts;
  target: OrgObjectCounts;
  diff: { sourceOnly: string[]; targetOnly: string[]; sharedCount: number };
  capturedAt: string;
}

/** Props for {@link SnapshotComparison}. */
export interface SnapshotComparisonProps {
  snapshot: OrgSnapshotComparison;
  sourceLabel: string;
  targetLabel: string;
  className?: string;
}

/** Object names listed by name before the tail is summarised as a count. */
const MAX_LISTED = 12;

/**
 * Validate a `compare:snapshots` payload before it reaches the view.
 *
 * A describe that returned no object on either side is a failed capture, not
 * an org with no schema: rejected here so the caller shows the channel's
 * diagnostic instead of a table of zeros.
 */
export function readSnapshotComparison(value: unknown): OrgSnapshotComparison | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const source = raw.source as OrgObjectCounts | undefined;
  const target = raw.target as OrgObjectCounts | undefined;
  const diff = raw.diff as OrgSnapshotComparison['diff'] | undefined;
  if (!source || typeof source !== 'object' || !target || typeof target !== 'object') {
    return undefined;
  }
  if (typeof source.totalObjects !== 'number' || typeof target.totalObjects !== 'number') {
    return undefined;
  }
  if (source.totalObjects === 0 && target.totalObjects === 0) return undefined;
  if (!diff || !Array.isArray(diff.sourceOnly) || !Array.isArray(diff.targetOnly)) {
    return undefined;
  }
  return { source, target, diff, capturedAt: String(raw.capturedAt ?? '') };
}

/** One side's headline: which org, and how many objects it describes. */
const OrgTotal: React.FC<{ side: 'source' | 'target'; label: string; counts: OrgObjectCounts }> = ({
  side,
  label,
  counts,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col gap-0.5" data-testid={`snapshot-${side}`}>
      <span className="text-[11px] font-medium text-[var(--sf-text-primary)]">{label}</span>
      <span
        className="font-mono text-xs text-[var(--sf-text-primary)]"
        data-testid={`snapshot-${side}-total`}
      >
        {t('common.objectCount', { count: counts.totalObjects })}
      </span>
    </div>
  );
};

/**
 * Schema snapshot of both orgs, side by side, as the extension captures it.
 *
 * Counts come from `describeGlobal` on each connection; the named objects are
 * the set difference between the two describes, in the same added/removed
 * vocabulary DiffEngine uses everywhere else on this page — target-only is
 * added, source-only is removed.
 */
export const SnapshotComparison: React.FC<SnapshotComparisonProps> = ({
  snapshot,
  sourceLabel,
  targetLabel,
  className,
}) => {
  const { t } = useTranslation();

  const onlyRows: Array<{ name: string; status: 'added' | 'removed' }> = [
    ...snapshot.diff.sourceOnly.map((name) => ({ name, status: 'removed' as const })),
    ...snapshot.diff.targetOnly.map((name) => ({ name, status: 'added' as const })),
  ];
  const listed = onlyRows.slice(0, MAX_LISTED);
  const remaining = onlyRows.length - listed.length;

  return (
    <Card className={className}>
      <CardHeader title={t('compare.snapshots')} />
      <CardBody className="max-h-80 overflow-y-auto">
        <div className="flex flex-col gap-3" data-testid="snapshot-comparison">
          <div className="flex gap-3 rounded bg-[var(--sf-bg-card)] p-2">
            <OrgTotal side="source" label={sourceLabel} counts={snapshot.source} />
            <OrgTotal side="target" label={targetLabel} counts={snapshot.target} />
          </div>

          {/* Objects one org has and the other does not, named. */}
          {listed.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="snapshot-objects">
              {listed.map((row) => (
                <div
                  key={row.name}
                  className={cn(
                    'flex items-center gap-2 rounded px-2 py-1 text-xs',
                    'bg-[var(--sf-bg-card)]',
                  )}
                  data-testid={`snapshot-object-${row.name}`}
                >
                  <span data-testid={`snapshot-object-status-${row.name}`}>
                    <Badge variant={row.status === 'added' ? 'success' : 'error'}>
                      {row.status === 'added' ? t('compare.added') : t('compare.removed')}
                    </Badge>
                  </span>
                  <span className="flex-1 truncate font-mono text-[var(--sf-text-primary)]">
                    {row.name}
                  </span>
                </div>
              ))}
              {remaining > 0 && (
                <span
                  className="text-[10px] text-[var(--sf-text-secondary)]"
                  data-testid="snapshot-objects-more"
                >
                  + {t('common.objectCount', { count: remaining })}
                </span>
              )}
            </div>
          )}

          {/* The shared count is the sample size behind the two lists above:
              without it, "nothing only in source" could pass for "nothing was
              compared". */}
          <div className="flex items-center gap-2" data-testid="snapshot-shared">
            <Badge variant="default">{t('compare.unchanged')}</Badge>
            <span
              className="text-[11px] text-[var(--sf-text-secondary)]"
              data-testid="snapshot-shared-count"
            >
              {t('common.objectCount', { count: snapshot.diff.sharedCount })}
            </span>
          </div>

          {snapshot.capturedAt && (
            <span
              className="font-mono text-[10px] text-[var(--sf-text-secondary)]"
              data-testid="snapshot-captured-at"
            >
              {snapshot.capturedAt}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
};
