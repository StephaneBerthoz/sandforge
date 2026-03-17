import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedExecutionResult } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Step8 props. */
export interface Step8ResultsProps {
  result?: SeedExecutionResult;
}

const statusVariant: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Step 8 — Seed execution results. */
export const Step8Results: React.FC<Step8ResultsProps> = ({ result }) => {
  const { t } = useTranslation();

  if (!result) {
    return (
      <div className="text-center py-8 text-xs text-[var(--vscode-descriptionForeground,#868686)]" data-testid="step-results">
        {t('common.noData')}
      </div>
    );
  }

  const statusLabel = result.status === 'success'
    ? t('seed.complete')
    : result.status === 'partial'
      ? t('seed.partial')
      : t('seed.failed');

  return (
    <div className="flex flex-col gap-3" data-testid="step-results">
      <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
        {t('seed.resultsDesc')}
      </p>

      {/* Summary */}
      <div className="flex items-center gap-3 text-xs" data-testid="result-summary">
        <Badge variant={statusVariant[result.status]}>{statusLabel}</Badge>
        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.recordsCreated')}: <strong>{result.totalRecordsCreated}</strong>
        </span>
        {result.totalRecordsFailed > 0 && (
          <span className="text-[var(--vscode-errorForeground,#f48771)]">
            {t('seed.recordsFailed')}: <strong>{result.totalRecordsFailed}</strong>
          </span>
        )}
        <span className="text-[var(--vscode-descriptionForeground,#868686)]">
          {t('seed.executionTime')}: {(result.duration / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Per-object results */}
      {result.objectResults.map((obj) => (
        <Card key={obj.objectApiName}>
          <CardHeader
            title={obj.objectApiName}
            action={
              <Badge variant={obj.recordsFailed > 0 ? 'warning' : 'success'}>
                {obj.recordsCreated}/{obj.recordsCreated + obj.recordsFailed}
              </Badge>
            }
          />
          {obj.errors.length > 0 && (
            <CardBody>
              <div className="flex flex-col gap-1">
                {obj.errors.map((err, i) => (
                  <p key={i} className="text-[10px] text-[var(--vscode-errorForeground,#f48771)]">
                    {err}
                  </p>
                ))}
              </div>
            </CardBody>
          )}
        </Card>
      ))}
    </div>
  );
};
