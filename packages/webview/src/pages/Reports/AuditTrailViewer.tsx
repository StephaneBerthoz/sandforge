import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AuditFacets,
  AuditLogEntry,
  AuditAction,
  AuditObjectCounts,
  AuditOutcome,
  GuardDecision,
} from '@sandforge/shared';
import { Card, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';

/** The module and org a trail is narrowed to. */
export interface AuditFilter {
  module?: string;
  orgId?: string;
}

/** AuditTrailViewer component props. */
export interface AuditTrailViewerProps {
  entries?: AuditLogEntry[];
  /** Entries the host's filter matches — more than `entries` when a page holds fewer. */
  total?: number;
  /** Every module and org of the trail. Read off `entries` when absent. */
  facets?: AuditFacets;
  /** The host's filter. Without `onFilterChange`, module and org are filtered here. */
  filter?: AuditFilter;
  onFilterChange?: (filter: AuditFilter) => void;
  /** Ask the host for the next entries, when `total` says there are more. */
  onShowMore?: () => void;
  className?: string;
}

/** Color mapping for audit action categories. */
function getActionVariant(action: AuditAction): BadgeVariant {
  if (action.includes('execute') || action === 'pipeline_run') return 'info';
  if (action.includes('create')) return 'success';
  if (action.includes('delete') || action === 'org_disconnect') return 'error';
  if (action.includes('update') || action === 'settings_change') return 'warning';
  return 'default';
}

const OUTCOME_VARIANTS: Record<AuditOutcome, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
  stopped: 'warning',
};

/** A pass needs no attention; a person's answer, or a refusal, does. */
const GUARD_VARIANTS: Record<GuardDecision, BadgeVariant> = {
  allowed: 'default',
  confirmed: 'info',
  declined: 'warning',
  refused: 'error',
};

/** The columns of an object's counts, in the order a line reads them. */
const COUNT_COLUMNS = ['created', 'updated', 'upserted', 'deleted', 'failed'] as const;

/** Modules and orgs read off the entries themselves, for a caller that gives none. */
function facetsOf(entries: readonly AuditLogEntry[]): AuditFacets {
  const orgs = new Map<string, string | undefined>();
  for (const entry of entries) {
    if (entry.orgId !== undefined && !orgs.has(entry.orgId)) orgs.set(entry.orgId, entry.orgAlias);
  }
  return {
    modules: [...new Set(entries.map((e) => e.module))],
    orgs: [...orgs].map(([orgId, orgAlias]) => ({ orgId, orgAlias })),
  };
}

/**
 * The runs that wrote to an org, newest first: what each did per object, in
 * counts, the org it wrote, where the records came from, how it ended and what
 * Production Guard decided about it.
 *
 * Module and org are the host's filters when it takes them (`onFilterChange`),
 * so a filter reaches past the page on screen; the action filter narrows what
 * is on screen.
 */
export const AuditTrailViewer: React.FC<AuditTrailViewerProps> = ({
  entries,
  total,
  facets,
  filter,
  onFilterChange,
  onShowMore,
  className,
}) => {
  const { t } = useTranslation();
  const [actionFilter, setActionFilter] = useState<string>('');
  const [localFilter, setLocalFilter] = useState<AuditFilter>({});
  const activeFilter = useMemo<AuditFilter>(
    () => (onFilterChange ? (filter ?? {}) : localFilter),
    [onFilterChange, filter, localFilter],
  );
  const changeFilter = onFilterChange ?? setLocalFilter;

  const offered = useMemo(() => facets ?? facetsOf(entries ?? []), [facets, entries]);

  const actions = useMemo(() => {
    if (!entries) return [];
    return [...new Set(entries.map((e) => e.action))];
  }, [entries]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    return entries.filter((e) => {
      if (actionFilter && e.action !== actionFilter) return false;
      // The host already filtered module and org when it took the filter.
      if (!onFilterChange) {
        if (activeFilter.module && e.module !== activeFilter.module) return false;
        if (activeFilter.orgId && e.orgId !== activeFilter.orgId) return false;
      }
      return true;
    });
  }, [entries, actionFilter, activeFilter, onFilterChange]);

  const actionLabel = (action: AuditAction): string => t(`reports.auditActions.${action}`);

  const actionOptions = [
    { value: '', label: t('reports.allActions') },
    ...actions.map((a) => ({ value: a, label: actionLabel(a) })),
  ];

  const moduleOptions = [
    { value: '', label: t('reports.allModules') },
    ...offered.modules.map((m) => ({ value: m, label: m })),
  ];

  const orgOptions = [
    { value: '', label: t('reports.allOrgs') },
    ...offered.orgs.map((o) => ({ value: o.orgId, label: o.orgAlias ?? o.orgId })),
  ];

  /** "3 created · 1 failed", naming only the columns the run filled. */
  const countsLine = (counts: AuditObjectCounts): string =>
    COUNT_COLUMNS.filter((column) => (counts[column] ?? 0) > 0)
      .map((column) => t(`reports.counts.${column}`, { count: counts[column] ?? 0 }))
      .join(' · ');

  const shown = entries?.length ?? 0;
  const hasMore = total !== undefined && total > shown && onShowMore !== undefined;

  return (
    <div data-testid="audit-trail-viewer" className={className}>
      <div className="flex flex-col gap-3">
        {/* Filters */}
        <div className="flex flex-wrap gap-2" data-testid="audit-filters">
          <Select
            data-testid="action-filter"
            options={actionOptions}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder={t('reports.filterByAction')}
          />
          <Select
            data-testid="module-filter"
            options={moduleOptions}
            value={activeFilter.module ?? ''}
            onChange={(e) => changeFilter({ ...activeFilter, module: e.target.value || undefined })}
            placeholder={t('reports.filterByModule')}
          />
          <Select
            data-testid="org-filter"
            options={orgOptions}
            value={activeFilter.orgId ?? ''}
            onChange={(e) => changeFilter({ ...activeFilter, orgId: e.target.value || undefined })}
            placeholder={t('reports.filterByOrg')}
          />
        </div>

        {/* Entries */}
        {filteredEntries.length === 0 ? (
          <EmptyState title={t('reports.noAuditEntries')} />
        ) : (
          <div className="flex flex-col gap-1">
            {filteredEntries.map((entry) => {
              const objects = (entry.objects ?? []).filter((o) => countsLine(o) !== '');
              const target = entry.orgAlias ?? entry.orgId;
              const source = entry.sourceOrgAlias ?? entry.sourceOrgId;
              return (
                <div key={entry.id} data-testid={`audit-${entry.id}`}>
                  <Card>
                    <CardBody>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={getActionVariant(entry.action)}>
                            {actionLabel(entry.action)}
                          </Badge>
                          <span className="text-xs text-[var(--sf-text-primary)]">
                            {entry.module}
                          </span>
                          {target && (
                            <span className="text-xs text-[var(--sf-text-primary)]">
                              {t('reports.intoOrg', { org: target })}
                            </span>
                          )}
                          {entry.outcome && (
                            <Badge variant={OUTCOME_VARIANTS[entry.outcome]}>
                              {t(`reports.outcome.${entry.outcome}`)}
                            </Badge>
                          )}
                          {entry.guard && (
                            <Badge variant={GUARD_VARIANTS[entry.guard]}>
                              {t(`reports.guard.${entry.guard}`)}
                            </Badge>
                          )}
                        </div>
                        <span className="text-[10px] text-[var(--sf-text-secondary)]">
                          {entry.timestamp.slice(0, 19).replace('T', ' ')}
                        </span>
                      </div>
                      {source && source !== target && (
                        <div className="mt-1 text-[10px] text-[var(--sf-text-secondary)]">
                          {t('reports.fromOrg', { org: source })}
                        </div>
                      )}
                      {objects.length > 0 && (
                        <ul className="mt-1 text-[10px] text-[var(--sf-text-secondary)]">
                          {objects.map((o) => (
                            <li key={o.objectApiName}>
                              <span className="text-[var(--sf-text-primary)]">
                                {o.objectApiName}
                              </span>{' '}
                              {countsLine(o)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {Object.keys(entry.details).length > 0 && (
                        <div className="mt-1 text-[10px] text-[var(--sf-text-secondary)]">
                          {Object.entries(entry.details).map(([k, v]) => (
                            <span key={k} className="mr-2">
                              {k}: {String(v)}
                            </span>
                          ))}
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </div>
              );
            })}
          </div>
        )}

        {total !== undefined && total > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-[var(--sf-text-secondary)]">
              {t('reports.auditShowing', { shown, total })}
            </span>
            {hasMore && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onShowMore}
                data-testid="audit-show-more"
              >
                {t('reports.showMore')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
