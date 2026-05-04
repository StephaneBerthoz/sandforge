import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedDataPlan } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';

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
      <div
        className="text-center py-8 text-xs text-[var(--vscode-descriptionForeground,#868686)]"
        data-testid="step-review-plan"
      >
        {t('common.loading')}
      </div>
    );
  }

  if (!plan) {
    return (
      <div
        className="text-center py-8 text-xs text-[var(--vscode-descriptionForeground,#868686)]"
        data-testid="step-review-plan"
      >
        {t('common.noData')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="step-review-plan">
      <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
        {t('seed.reviewPlanDesc')}
      </p>

      {/* Summary */}
      <div className="flex gap-4 text-xs" data-testid="plan-summary">
        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.totalRecords')}: <strong>{plan.totalRecords}</strong>
        </span>
        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.estimatedApiCalls')}: <strong>{plan.estimatedApiCalls}</strong>
        </span>
        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
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
                <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                  {t('seed.dependencies')}:
                </span>
                {obj.dependsOn.map((dep) => (
                  <Badge key={dep} variant="default">
                    {dep}
                  </Badge>
                ))}
              </div>
            )}

            {/* Sample records */}
            {obj.sampleRecords.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-[var(--vscode-panel-border,#3c3c3c)]">
                      {Object.keys(obj.sampleRecords[0]).map((col) => (
                        <th
                          key={col}
                          className="text-left px-2 py-1 text-[var(--vscode-descriptionForeground,#868686)] font-medium"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {obj.sampleRecords.map((rec, i) => (
                      <tr key={i} className="border-b border-[var(--vscode-panel-border,#3c3c3c)]">
                        {Object.values(rec).map((val, j) => (
                          <td
                            key={j}
                            className="px-2 py-1 text-[var(--vscode-editor-foreground,#d4d4d4)] truncate max-w-[150px]"
                          >
                            {String(val ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
};
