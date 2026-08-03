import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedDataPlan } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/ui/DataTable';

/** Step6 props. */
export interface Step6ReviewPlanProps {
  plan?: SeedDataPlan;
  isLoading?: boolean;
}

/** Step 6 — Review the data plan with sample records. */
export const Step6ReviewPlan: React.FC<Step6ReviewPlanProps> = ({ plan, isLoading }) => {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="text-center py-8 text-xs text-text-secondary" data-testid="step-review-plan">
        {t('common.loading')}
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="text-center py-8 text-xs text-text-secondary" data-testid="step-review-plan">
        {t('common.noData')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="step-review-plan">
      <p className="text-xs text-text-secondary">{t('seed.reviewPlanDesc')}</p>

      {/* Summary */}
      <div className="flex gap-4 text-xs" data-testid="plan-summary">
        <span className="text-text-primary">
          {t('seed.totalRecords')}: <strong>{plan.totalRecords}</strong>
        </span>
        <span className="text-text-primary">
          {t('seed.estimatedApiCalls')}: <strong>{plan.estimatedApiCalls}</strong>
        </span>
        <span className="text-text-primary">
          {t('seed.estimatedDuration')}:{' '}
          <strong>{Math.round(plan.estimatedDuration / 1000)}s</strong>
        </span>
        {plan.grappeRecommended && <Badge variant="warning">{t('seed.grappeRecommended')}</Badge>}
      </div>

      {/* Per-object details */}
      {plan.objects.map((obj) => (
        <Card key={obj.objectApiName}>
          <CardHeader
            title={obj.objectApiName}
            subtitle={`${obj.recordCount} ${t('seed.recordCount').toLowerCase()}`}
          />
          <CardBody>
            {/* Dependencies */}
            {obj.dependsOn.length > 0 && (
              <div className="flex gap-1 mb-2 flex-wrap">
                <span className="text-[10px] text-text-secondary">{t('seed.dependencies')}:</span>
                {obj.dependsOn.map((dep) => (
                  <Badge key={dep} variant="default">
                    {dep}
                  </Badge>
                ))}
              </div>
            )}

            {/* Sample records */}
            {obj.sampleRecords.length > 0 && (
              <DataTable
                columns={Object.keys(obj.sampleRecords[0]).map((col) => ({
                  key: col,
                  header: col,
                  render: (rec: Record<string, unknown>) => (
                    <span className="block max-w-[150px] truncate">{String(rec[col] ?? '')}</span>
                  ),
                }))}
                data={obj.sampleRecords}
                keyExtractor={(_rec, i) => `${obj.objectApiName}-${i}`}
              />
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
};
