import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ClonePreviewResult } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Accordion } from '../../../components/ui/Accordion';
import { DataTable } from '../../../components/ui/DataTable';
import type { DataTableColumn } from '../../../components/ui/DataTable';
import { Card, CardHeader, CardBody } from '../../../components/ui/Card';
import { ArrowDown } from 'lucide-react';

/** Large clone threshold for showing a performance warning. */
const LARGE_CLONE_THRESHOLD = 10_000;

/** Props for the ClonePreviewPanel component. */
export interface ClonePreviewPanelProps {
  /** Preview result from seed:clone:preview. */
  previewResult: ClonePreviewResult;
  /** Callback to start the clone execution. */
  onExecute: () => void;
  /** Callback to go back to object selection. */
  onBack: () => void;
}

/**
 * Displays a clone preview with three sections:
 * 1. Insert order (topological) with dependency arrows
 * 2. Record counts per object with totals
 * 3. Sample records per object in expandable accordions
 */
export const ClonePreviewPanel: React.FC<ClonePreviewPanelProps> = ({
  previewResult,
  onExecute,
  onBack,
}) => {
  const { t } = useTranslation();

  const totalRecords = previewResult.objects.reduce(
    (sum, obj) => sum + obj.recordCount,
    0,
  );
  const totalRelationships = previewResult.objects.reduce(
    (sum, obj) => sum + obj.relationships.length,
    0,
  );

  /** Build DataTable columns from sample record keys. */
  const buildSampleColumns = (
    sampleRecords: Record<string, unknown>[],
  ): DataTableColumn<Record<string, unknown>>[] => {
    if (sampleRecords.length === 0) return [];
    const keys = Object.keys(sampleRecords[0]);
    return keys.slice(0, 6).map((key) => ({
      key,
      header: key,
      render: (row: Record<string, unknown>) => String(row[key] ?? ''),
    }));
  };

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)]" data-testid="clone-preview-panel">
      <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('seed.clone.preview.title')}
      </span>

      {/* Section 1: Insert Order */}
      <Card>
        <CardHeader title={t('seed.clone.preview.insertOrder')} />
        <CardBody>
          <div
            className="flex flex-col gap-1"
            data-testid="clone-insert-order"
          >
            {previewResult.insertOrder.map((objectName, index) => (
              <div key={objectName} className="flex items-center gap-2">
                <span className="w-5 h-5 flex items-center justify-center rounded-full bg-[var(--vscode-focusBorder,#007fd4)] text-white text-[10px] font-bold shrink-0">
                  {index + 1}
                </span>
                <Badge variant="default">{objectName}</Badge>
                {index < previewResult.insertOrder.length - 1 && (
                  <ArrowDown
                    size={12}
                    className="text-[var(--vscode-descriptionForeground,#868686)] ml-1"
                  />
                )}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Section 2: Record Counts */}
      <Card>
        <CardHeader title={t('seed.clone.preview.recordCounts')} />
        <CardBody>
          <div className="flex flex-col gap-1" data-testid="clone-record-counts">
            {previewResult.objects.map((obj) => (
              <div
                key={obj.objectApiName}
                className="flex items-center justify-between text-xs px-2 py-1"
              >
                <span className="text-[var(--vscode-editor-foreground,#d4d4d4)] font-medium">
                  {obj.objectApiName}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {obj.recordCount} {t('seed.records')}
                  </span>
                  {obj.relationships.length > 0 && (
                    <Badge variant="info">
                      {obj.relationships.length} {t('seed.dependencies')}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs px-2 py-2 border-t border-[var(--vscode-panel-border,#3c3c3c)] font-semibold">
              <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {t('seed.totalRecords')}
              </span>
              <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]" data-testid="clone-total-records">
                {totalRecords} {t('seed.records')}, {totalRelationships} {t('seed.dependencies')}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Large clone warning */}
      {totalRecords > LARGE_CLONE_THRESHOLD && (
        <div
          className="p-3 rounded border border-amber-600 bg-amber-950/30 text-xs text-amber-400"
          role="alert"
          data-testid="clone-large-warning"
        >
          {t('seed.clone.preview.largeWarning')}
        </div>
      )}

      {/* Section 3: Sample Records */}
      <Card>
        <CardHeader title={t('seed.clone.preview.sampleRecords')} />
        <CardBody>
          <Accordion
            items={previewResult.objects.map((obj) => ({
              title: `${obj.objectApiName} (${obj.sampleRecords.length} ${t('seed.sampleRecords').toLowerCase()})`,
              content:
                obj.sampleRecords.length > 0 ? (
                  <DataTable
                    columns={buildSampleColumns(obj.sampleRecords)}
                    data={obj.sampleRecords}
                    keyExtractor={(_row, index) => `${obj.objectApiName}-${index}`}
                    enableVirtualization={false}
                  />
                ) : (
                  <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('common.noData')}
                  </span>
                ),
            }))}
          />
        </CardBody>
      </Card>

      {/* Actions */}
      <div className="flex justify-between items-center pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onBack}
          data-testid="clone-preview-back"
        >
          {t('common.back')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onExecute}
          data-testid="clone-preview-execute"
        >
          {t('seed.clone.preview.execute')}
        </Button>
      </div>
    </div>
  );
};
