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
 * 1. Insert order (topological) with dependency arrows, the lookups a second
 *    pass fills in once the record they point at is written, and those only
 *    the source org has, whose values the clone does not write
 * 2. Record counts per object with totals
 * 3. Sample records per object in expandable accordions
 */
export const ClonePreviewPanel: React.FC<ClonePreviewPanelProps> = ({
  previewResult,
  onExecute,
  onBack,
}) => {
  const { t } = useTranslation();

  const totalRecords = previewResult.objects.reduce((sum, obj) => sum + obj.recordCount, 0);
  const totalRelationships = previewResult.objects.reduce(
    (sum, obj) => sum + obj.relationships.length,
    0,
  );
  const filledAfterInsert = previewResult.filledAfterInsert ?? [];
  const sourceOnlyLookups = previewResult.sourceOnlyLookups ?? [];

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
      <span className="text-sm font-semibold text-[var(--sf-text-primary)]">
        {t('seed.clone.preview.title')}
      </span>

      {/* Section 1: Insert Order */}
      <Card>
        <CardHeader title={t('seed.clone.preview.insertOrder')} />
        <CardBody>
          <div className="flex flex-col gap-1" data-testid="clone-insert-order">
            {previewResult.insertOrder.map((objectName, index) => (
              <div key={objectName} className="flex items-center gap-2">
                <span className="w-5 h-5 flex items-center justify-center rounded-full bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] text-[10px] font-bold shrink-0">
                  {index + 1}
                </span>
                <Badge variant="default">{objectName}</Badge>
                {index < previewResult.insertOrder.length - 1 && (
                  <ArrowDown size={12} className="text-[var(--sf-text-secondary)] ml-1" />
                )}
              </div>
            ))}
          </div>
          {/* The lookups that break a cycle, and those at a record of the same
              object, go in empty and are filled in afterwards: named here,
              before anything is written. */}
          {filledAfterInsert.length > 0 && (
            <div className="flex flex-col gap-1 mt-3" data-testid="clone-preview-filled-after">
              <span className="text-xs text-[var(--sf-text-secondary)]">
                {t('seed.clone.preview.filledAfterInsert')}
              </span>
              <ul className="flex flex-col gap-0.5">
                {filledAfterInsert.map((lookup) => (
                  <li
                    key={`${lookup.objectApiName}.${lookup.field}.${lookup.referenceTo}`}
                    className="text-xs font-mono text-[var(--sf-text-primary)]"
                  >
                    {`${lookup.objectApiName}.${lookup.field} → ${lookup.referenceTo}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* A lookup the source has and the target lacks: the order above
              is the target's, and the clone leaves it out of every record. */}
          {sourceOnlyLookups.length > 0 && (
            <div className="flex flex-col gap-1 mt-3" data-testid="clone-preview-source-only">
              <span className="text-xs text-[var(--sf-text-secondary)]">
                {t('seed.clone.preview.sourceOnlyLookups')}
              </span>
              <ul className="flex flex-col gap-0.5">
                {sourceOnlyLookups.map((lookup) => (
                  <li
                    key={`${lookup.objectApiName}.${lookup.field}.${lookup.referenceTo}`}
                    className="text-xs font-mono text-[var(--sf-text-primary)]"
                  >
                    {`${lookup.objectApiName}.${lookup.field} → ${lookup.referenceTo}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
                <span className="text-[var(--sf-text-primary)] font-medium">
                  {obj.objectApiName}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--sf-text-primary)]">
                    {t('common.recordCount', { count: obj.recordCount })}
                  </span>
                  {/* Found and never sent: counted apart, as the results count them. */}
                  {(obj.leftToThePlatform ?? 0) > 0 && (
                    <span
                      className="text-[var(--sf-text-secondary)]"
                      data-testid="clone-preview-left-to-the-platform"
                    >
                      {t('seed.clone.preview.leftToThePlatform')}: {obj.leftToThePlatform}
                    </span>
                  )}
                  {obj.relationships.length > 0 && (
                    <Badge variant="info">
                      {t('common.dependencyCount', { count: obj.relationships.length })}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs px-2 py-2 border-t border-[var(--sf-border)] font-semibold">
              <span className="text-[var(--sf-text-primary)]">{t('seed.totalRecords')}</span>
              <span className="text-[var(--sf-text-primary)]" data-testid="clone-total-records">
                {t('common.recordCount', { count: totalRecords })},{' '}
                {t('common.dependencyCount', { count: totalRelationships })}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Large clone warning */}
      {totalRecords > LARGE_CLONE_THRESHOLD && (
        <div
          className="p-3 rounded border border-status-warning bg-status-warning/10 text-xs text-status-warning"
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
              title: `${obj.objectApiName} (${t('seed.sampleRecordCount', { count: obj.sampleRecords.length })})`,
              content:
                obj.sampleRecords.length > 0 ? (
                  <DataTable
                    columns={buildSampleColumns(obj.sampleRecords)}
                    data={obj.sampleRecords}
                    keyExtractor={(_row, index) => `${obj.objectApiName}-${index}`}
                    enableVirtualization={false}
                  />
                ) : (
                  <span className="text-xs text-[var(--sf-text-secondary)]">
                    {t('common.noData')}
                  </span>
                ),
            }))}
          />
        </CardBody>
      </Card>

      {/* Actions */}
      <div className="flex justify-between items-center pt-2">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="clone-preview-back">
          {t('common.back')}
        </Button>
        <Button variant="primary" size="sm" onClick={onExecute} data-testid="clone-preview-execute">
          {t('seed.clone.preview.execute')}
        </Button>
      </div>
    </div>
  );
};
