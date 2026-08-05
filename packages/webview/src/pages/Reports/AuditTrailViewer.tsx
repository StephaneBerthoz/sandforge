import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuditLogEntry, AuditAction } from '@sandforge/shared';
import { Card, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';

/** AuditTrailViewer component props. */
export interface AuditTrailViewerProps {
  entries?: AuditLogEntry[];
  className?: string;
}

/** Color mapping for audit action categories. */
function getActionVariant(
  action: AuditAction,
): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (action.includes('execute') || action === 'pipeline_run') return 'info';
  if (action.includes('create')) return 'success';
  if (action.includes('delete') || action === 'org_disconnect') return 'error';
  if (action.includes('update') || action === 'settings_change') return 'warning';
  return 'default';
}

/** Viewer for audit trail with filters. */
export const AuditTrailViewer: React.FC<AuditTrailViewerProps> = ({ entries, className }) => {
  const { t } = useTranslation();
  const [actionFilter, setActionFilter] = useState<string>('');
  const [moduleFilter, setModuleFilter] = useState<string>('');

  const modules = useMemo(() => {
    if (!entries) return [];
    return [...new Set(entries.map((e) => e.module))];
  }, [entries]);

  const actions = useMemo(() => {
    if (!entries) return [];
    return [...new Set(entries.map((e) => e.action))];
  }, [entries]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    return entries.filter((e) => {
      if (actionFilter && e.action !== actionFilter) return false;
      if (moduleFilter && e.module !== moduleFilter) return false;
      return true;
    });
  }, [entries, actionFilter, moduleFilter]);

  const actionOptions = [
    { value: '', label: t('reports.allActions') },
    ...actions.map((a) => ({ value: a, label: a })),
  ];

  const moduleOptions = [
    { value: '', label: t('reports.allModules') },
    ...modules.map((m) => ({ value: m, label: m })),
  ];

  return (
    <div data-testid="audit-trail-viewer" className={className}>
      <div className="flex flex-col gap-3">
        {/* Filters */}
        <div className="flex gap-2" data-testid="audit-filters">
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
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            placeholder={t('reports.filterByModule')}
          />
        </div>

        {/* Entries */}
        {filteredEntries.length === 0 ? (
          <EmptyState title={t('reports.noAuditEntries')} />
        ) : (
          <div className="flex flex-col gap-1">
            {filteredEntries.map((entry) => (
              <div key={entry.id} data-testid={`audit-${entry.id}`}>
                <Card>
                  <CardBody>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={getActionVariant(entry.action)}>{entry.action}</Badge>
                        <span className="text-xs text-[var(--sf-text-primary)]">
                          {entry.module}
                        </span>
                      </div>
                      <span className="text-[10px] text-[var(--sf-text-secondary)]">
                        {entry.timestamp.slice(0, 19).replace('T', ' ')}
                      </span>
                    </div>
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
