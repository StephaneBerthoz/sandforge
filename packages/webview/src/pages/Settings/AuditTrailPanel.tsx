import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Search, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardBody } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Audit entry for display. */
export interface AuditEntryDisplay {
  id: string;
  operationType: string;
  description: string;
  orgId?: string;
  user?: string;
  timestamp: string;
  durationMs: number;
  status: string;
  recordCount?: number;
  error?: string;
}

/** Props for the AuditTrailPanel component. */
export interface AuditTrailPanelProps {
  /** Audit entries to display. */
  entries?: AuditEntryDisplay[];
  /** Total entry count (may differ from displayed if filtered server-side). */
  total?: number;
  /** Whether data is loading. */
  loading?: boolean;
  /** Callback when filters change. */
  onFilter?: (filters: AuditFilterValues) => void;
  /** Callback to export audit data. */
  onExport?: (format: 'csv' | 'json') => void;
}

/** Filter values for the audit panel. */
export interface AuditFilterValues {
  search: string;
  operationType: string;
  status: string;
  startDate: string;
  endDate: string;
}

/** Map status to badge variant. */
function statusBadge(status: string): BadgeVariant {
  switch (status) {
    case 'success': return 'success';
    case 'failure': return 'error';
    case 'partial': return 'warning';
    default: return 'default';
  }
}

/** Format duration in ms to human-readable. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Format ISO timestamp to locale string. */
function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Audit trail panel displaying a searchable, filterable table
 * of operation audit entries with export capabilities.
 */
export const AuditTrailPanel: React.FC<AuditTrailPanelProps> = ({
  entries = [],
  total,
  loading = false,
  onFilter,
  onExport,
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [operationType, setOperationType] = useState('');
  const [status, setStatus] = useState('');
  const [startDate] = useState('');
  const [endDate] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleFilterChange = useCallback(() => {
    onFilter?.({ search, operationType, status, startDate, endDate });
  }, [search, operationType, status, startDate, endDate, onFilter]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleFilterChange();
      }
    },
    [handleFilterChange],
  );

  const filteredEntries = useMemo(() => {
    let result = entries;
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((e) => e.description.toLowerCase().includes(lower));
    }
    if (operationType) {
      result = result.filter((e) => e.operationType === operationType);
    }
    if (status) {
      result = result.filter((e) => e.status === status);
    }
    return result;
  }, [entries, search, operationType, status]);

  const operationTypes = useMemo(() => {
    const types = new Set(entries.map((e) => e.operationType));
    return Array.from(types).sort();
  }, [entries]);

  return (
    <div data-testid="audit-trail-panel" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-[var(--vscode-editor-foreground,#d4d4d4)]" />
          <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('audit.title', 'Audit Trail')}
          </h2>
          {total !== undefined && (
            <Badge variant="default">{total} {t('audit.entries', 'entries')}</Badge>
          )}
        </div>
        {onExport && (
          <div className="flex gap-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExport('csv')}
              data-testid="export-csv-btn"
            >
              <Download className="w-3 h-3 mr-1" />
              CSV
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExport('json')}
              data-testid="export-json-btn"
            >
              <Download className="w-3 h-3 mr-1" />
              JSON
            </Button>
          </div>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap gap-2" data-testid="audit-filters">
            <div className="flex-1 min-w-[150px]">
              <Input
                data-testid="audit-search"
                placeholder={t('audit.searchPlaceholder', 'Search operations...')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
            <Select
              data-testid="audit-type-filter"
              options={[
                { value: '', label: t('audit.allTypes', 'All Types') },
                ...operationTypes.map((op) => ({ value: op, label: op })),
              ]}
              value={operationType}
              onChange={(e) => {
                setOperationType(e.target.value);
              }}
            />
            <Select
              data-testid="audit-status-filter"
              options={[
                { value: '', label: t('audit.allStatuses', 'All Statuses') },
                { value: 'success', label: t('audit.success', 'Success') },
                { value: 'failure', label: t('audit.failure', 'Failure') },
                { value: 'partial', label: t('audit.partial', 'Partial') },
              ]}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleFilterChange}
              data-testid="apply-filter-btn"
            >
              <Search className="w-3 h-3 mr-1" />
              {t('audit.filter', 'Filter')}
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Entries Table */}
      <Card>
        <CardBody>
          {loading ? (
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]" data-testid="audit-loading">
              {t('common.loading', 'Loading...')}
            </p>
          ) : filteredEntries.length === 0 ? (
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]" data-testid="audit-empty">
              {t('audit.noEntries', 'No audit entries found.')}
            </p>
          ) : (
            <div className="flex flex-col gap-1" data-testid="audit-entries">
              {filteredEntries.map((entry) => (
                <div key={entry.id} data-testid={`audit-entry-${entry.id}`}>
                  <div
                    className="flex items-center gap-2 p-2 rounded border border-[var(--vscode-panel-border,#2b2b2b)] bg-[var(--vscode-editor-background,#1e1e1e)] cursor-pointer hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]"
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  >
                    {expandedId === entry.id
                      ? <ChevronDown className="w-3 h-3 text-[var(--vscode-descriptionForeground,#868686)]" />
                      : <ChevronRight className="w-3 h-3 text-[var(--vscode-descriptionForeground,#868686)]" />
                    }
                    <Badge variant={statusBadge(entry.status)}>
                      {entry.status}
                    </Badge>
                    <span className="text-xs font-mono text-[var(--vscode-descriptionForeground,#868686)]">
                      {entry.operationType}
                    </span>
                    <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)] flex-1 truncate">
                      {entry.description}
                    </span>
                    <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] whitespace-nowrap">
                      {formatDuration(entry.durationMs)}
                    </span>
                    <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] whitespace-nowrap">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </div>
                  {/* Detail panel */}
                  {expandedId === entry.id && (
                    <div
                      className="ml-6 p-2 border-l-2 border-[var(--vscode-panel-border,#2b2b2b)] mt-1"
                      data-testid={`audit-detail-${entry.id}`}
                    >
                      <div className="grid grid-cols-2 gap-1 text-xs">
                        <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                          {t('audit.operationType', 'Operation')}:
                        </span>
                        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{entry.operationType}</span>

                        {entry.orgId && (
                          <>
                            <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                              {t('audit.org', 'Org')}:
                            </span>
                            <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{entry.orgId}</span>
                          </>
                        )}

                        {entry.user && (
                          <>
                            <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                              {t('audit.user', 'User')}:
                            </span>
                            <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{entry.user}</span>
                          </>
                        )}

                        {entry.recordCount !== undefined && (
                          <>
                            <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                              {t('audit.records', 'Records')}:
                            </span>
                            <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{entry.recordCount}</span>
                          </>
                        )}

                        <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                          {t('audit.duration', 'Duration')}:
                        </span>
                        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{formatDuration(entry.durationMs)}</span>

                        {entry.error && (
                          <>
                            <span className="text-[var(--vscode-errorForeground,#f48771)]">
                              {t('audit.error', 'Error')}:
                            </span>
                            <span className="text-[var(--vscode-errorForeground,#f48771)]">{entry.error}</span>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
