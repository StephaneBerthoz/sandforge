import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedExecutionResult } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

const RESULTS_STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Props for the SeedResultsStep section. */
export interface SeedResultsStepProps {
  /** Execution result returned by the backend, if any. */
  executionResult: SeedExecutionResult | undefined;
  /** Restart the wizard at the select step. */
  onSeedAgain: () => void;
}

/** Step 4 (Results) of the Seed wizard: summary, per-object cards, actions. */
export const SeedResultsStep: React.FC<SeedResultsStepProps> = ({
  executionResult,
  onSeedAgain,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="seed-step-results-content">
      {!executionResult ? (
        <div className="text-center py-8 text-xs text-[var(--sf-text-secondary)]">
          {t('common.noData')}
        </div>
      ) : (
        <>
          {/* Summary table */}
          <div className="flex items-center gap-3 text-xs" data-testid="result-summary">
            <Badge variant={RESULTS_STATUS_VARIANT[executionResult.status]}>
              {executionResult.status === 'success'
                ? t('seed.complete')
                : executionResult.status === 'partial'
                  ? t('seed.partial')
                  : t('seed.failed')}
            </Badge>
            <span className="text-[var(--sf-text-primary)]">
              {t('seed.recordsCreated')}: <strong>{executionResult.totalRecordsCreated}</strong>
            </span>
            {executionResult.totalRecordsFailed > 0 && (
              <span className="text-[var(--sf-error)]">
                {t('seed.recordsFailed')}: <strong>{executionResult.totalRecordsFailed}</strong>
              </span>
            )}
            <span className="text-[var(--sf-text-secondary)]">
              {t('seed.executionTime')}: {(executionResult.duration / 1000).toFixed(1)}s
            </span>
          </div>

          {/* Per-object results */}
          {executionResult.objectResults.map((obj) => (
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
                      <p key={i} className="text-[10px] text-[var(--sf-error)]">
                        {err}
                      </p>
                    ))}
                  </div>
                </CardBody>
              )}
            </Card>
          ))}

          {/* Action buttons: Save, Export CSV, Seed Again */}
          <div className="flex gap-2 pt-2" data-testid="result-actions">
            <Button variant="secondary" size="sm" data-testid="btn-save-template">
              {t('seed.saveAsTemplate')}
            </Button>
            <Button variant="secondary" size="sm" data-testid="btn-export-csv">
              {t('seed.exportCsv')}
            </Button>
            <Button variant="primary" size="sm" onClick={onSeedAgain} data-testid="btn-seed-again">
              {t('seed.seedAgain')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
