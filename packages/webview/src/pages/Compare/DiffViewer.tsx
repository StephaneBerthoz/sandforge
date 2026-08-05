import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CompareItem, DiffStatus } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** DiffViewer component props. */
export interface DiffViewerProps {
  items: CompareItem[];
  selectedItem?: CompareItem;
  onSelectItem?: (item: CompareItem) => void;
  className?: string;
}

const statusVariant: Record<DiffStatus, BadgeVariant> = {
  added: 'success',
  removed: 'error',
  modified: 'warning',
  unchanged: 'default',
};

const statusSymbol: Record<DiffStatus, string> = {
  added: '+',
  removed: '-',
  modified: '~',
  unchanged: '=',
};

/** Viewer for compare diff results with Monaco-like inline diff. */
export const DiffViewer: React.FC<DiffViewerProps> = ({
  items,
  selectedItem,
  onSelectItem,
  className,
}) => {
  const { t } = useTranslation();
  const changedItems = items.filter((i) => i.status !== 'unchanged');

  return (
    <Card className={className}>
      <CardHeader
        title={t('compare.diff')}
        subtitle={t('common.changeCount', { count: changedItems.length })}
      />
      <CardBody className="flex flex-col gap-0 max-h-96 overflow-y-auto">
        {changedItems.length === 0 ? (
          <p className="text-xs text-text-secondary text-center py-4">{t('common.noData')}</p>
        ) : (
          <>
            {/* Diff item list */}
            <div className="flex flex-col" data-testid="diff-list">
              {changedItems.map((item) => (
                <button
                  key={`${item.componentType}-${item.fullName}`}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 text-left text-xs border-b border-[var(--sf-border)] hover:bg-[var(--sf-bg-hover)]',
                    selectedItem?.fullName === item.fullName && 'bg-[var(--sf-bg-active)]',
                  )}
                  onClick={() => onSelectItem?.(item)}
                  data-testid={`diff-item-${item.fullName}`}
                >
                  <span
                    className={cn(
                      'font-mono font-bold w-4 text-center',
                      item.status === 'added' && 'text-[var(--sf-success)]',
                      item.status === 'removed' && 'text-[var(--sf-error)]',
                      item.status === 'modified' && 'text-[var(--sf-warning)]',
                    )}
                  >
                    {statusSymbol[item.status]}
                  </span>
                  <span className="text-text-secondary w-28 truncate">{item.componentType}</span>
                  <span className="text-text-primary flex-1 truncate">{item.fullName}</span>
                  <Badge variant={statusVariant[item.status]}>{item.status}</Badge>
                </button>
              ))}
            </div>

            {/* Inline diff view for selected item */}
            {selectedItem && (selectedItem.sourceValue || selectedItem.targetValue) && (
              <div
                className="mt-2 border border-[var(--sf-border)] rounded"
                data-testid="diff-content"
              >
                <div className="grid grid-cols-2 gap-0 text-[10px] font-mono">
                  <div className="p-2 bg-[rgba(239,68,68,0.05)] border-r border-[var(--sf-border)]">
                    <div className="text-text-secondary mb-1 font-sans font-medium">Source</div>
                    <pre className="whitespace-pre-wrap text-text-primary">
                      {selectedItem.sourceValue ?? '(empty)'}
                    </pre>
                  </div>
                  <div className="p-2 bg-[rgba(16,185,129,0.05)]">
                    <div className="text-text-secondary mb-1 font-sans font-medium">Target</div>
                    <pre className="whitespace-pre-wrap text-text-primary">
                      {selectedItem.targetValue ?? '(empty)'}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
};
