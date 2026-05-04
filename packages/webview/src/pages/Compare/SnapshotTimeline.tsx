import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgSnapshot } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';

/** SnapshotTimeline component props. */
export interface SnapshotTimelineProps {
  snapshots: OrgSnapshot[];
  onCreateSnapshot?: () => void;
  onSelectSnapshot?: (snapshot: OrgSnapshot) => void;
  onDeleteSnapshot?: (snapshotId: string) => void;
  onCompareSnapshots?: (snapshotIds: [string, string]) => void;
  className?: string;
}

/** Formats a date for timeline display using locale-aware formatting. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
}

/** Maximum number of snapshots that can be selected for comparison. */
const MAX_SELECTED = 2;

/** Timeline view of org snapshots with multi-select for comparison. */
export const SnapshotTimeline: React.FC<SnapshotTimelineProps> = ({
  snapshots,
  onCreateSnapshot,
  onSelectSnapshot,
  onDeleteSnapshot,
  onCompareSnapshots,
  className,
}) => {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const sorted = [...snapshots].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  /** Toggle selection of a snapshot (max 2). */
  const handleToggleSelect = useCallback((snapshotId: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(snapshotId)) {
        return prev.filter((id) => id !== snapshotId);
      }
      if (prev.length >= MAX_SELECTED) {
        // Replace the oldest selection
        return [prev[1], snapshotId];
      }
      return [...prev, snapshotId];
    });
  }, []);

  /** Handle compare button click. */
  const handleCompare = useCallback(() => {
    if (selectedIds.length === MAX_SELECTED) {
      onCompareSnapshots?.(selectedIds as [string, string]);
    }
  }, [selectedIds, onCompareSnapshots]);

  const canCompare = selectedIds.length === MAX_SELECTED;

  return (
    <Card className={className}>
      <CardHeader
        title={t('compare.snapshots')}
        action={
          <div className="flex items-center gap-2">
            {canCompare && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleCompare}
                data-testid="compare-snapshots-btn"
              >
                {t('compare.compareSelected')}
              </Button>
            )}
            {onCreateSnapshot && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onCreateSnapshot}
                data-testid="create-snapshot-btn"
              >
                {t('compare.createSnapshot')}
              </Button>
            )}
          </div>
        }
      />
      <CardBody className="max-h-60 overflow-y-auto">
        {sorted.length === 0 ? (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('compare.noSnapshots')}
          </p>
        ) : (
          <div className="relative pl-4" data-testid="snapshot-timeline">
            {/* Vertical timeline line */}
            <div className="absolute left-1.5 top-0 bottom-0 w-px bg-[var(--vscode-panel-border,#3c3c3c)]" />
            {sorted.map((snapshot) => {
              const isSelected = selectedIds.includes(snapshot.id);
              return (
                <div
                  key={snapshot.id}
                  className="relative flex items-start gap-3 mb-3 last:mb-0"
                  data-testid={`snapshot-${snapshot.id}`}
                >
                  {/* Timeline dot */}
                  <div
                    className={cn(
                      'absolute -left-[10.5px] top-1.5 w-2 h-2 rounded-full',
                      isSelected
                        ? 'bg-[var(--sf-warning,#F59E0B)] ring-2 ring-[var(--sf-warning,#F59E0B)] ring-opacity-40'
                        : 'bg-[var(--vscode-textLink-foreground,#3794ff)]',
                    )}
                  />
                  <button
                    className={cn(
                      'flex-1 flex items-center justify-between p-2 rounded text-left',
                      'border',
                      isSelected
                        ? 'border-[var(--sf-warning,#F59E0B)] bg-[rgba(245,158,11,0.08)]'
                        : 'border-[var(--vscode-panel-border,#3c3c3c)]',
                      'hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]',
                    )}
                    onClick={() => {
                      handleToggleSelect(snapshot.id);
                      onSelectSnapshot?.(snapshot);
                    }}
                    data-testid={`snapshot-select-${snapshot.id}`}
                  >
                    <div>
                      <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                        {snapshot.name}
                      </span>
                      <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] ml-2">
                        {formatDate(snapshot.createdAt)}
                      </span>
                      <div className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                        {t('common.componentCount', { count: snapshot.componentCount })} &middot;{' '}
                        {t('common.typeCount', { count: snapshot.componentTypes.length })}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {isSelected && (
                        <span
                          className="text-[10px] font-medium text-[var(--sf-warning,#F59E0B)]"
                          data-testid={`snapshot-selected-badge-${snapshot.id}`}
                        >
                          {t('compare.selected')}
                        </span>
                      )}
                      {onDeleteSnapshot && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSnapshot(snapshot.id);
                          }}
                          data-testid={`delete-snapshot-${snapshot.id}`}
                        >
                          {t('common.delete')}
                        </Button>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
};
