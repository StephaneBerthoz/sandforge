import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SeedExecutionResult,
  SeedTemplate,
  SeedTemplateSaveResponse,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
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
  /** The template the run was built from, saved by "Save as template". */
  template: SeedTemplate | null;
  /** Restart the wizard at the select step. */
  onSeedAgain: () => void;
}

/** Step 4 (Results) of the Seed wizard: summary, per-object cards, actions. */
export const SeedResultsStep: React.FC<SeedResultsStepProps> = ({
  executionResult,
  template,
  onSeedAgain,
}) => {
  const { t } = useTranslation();

  const saveTemplate = useBridgeMutation<SeedTemplateSaveResponse['payload']>(
    'seed:template:save',
    {
      responseType: 'seed:template:save:response',
    },
  );

  /**
   * Store the configuration this run used, so the next run can start from it.
   * The id is left out: the host creates a new template rather than writing
   * over one that happens to share the run's throwaway id. The name is the
   * objects and the day, which is what the gallery lists it by.
   */
  const handleSaveTemplate = useCallback(() => {
    if (!template) return;
    const objects = template.objects.map((o) => o.objectApiName).join(', ');
    const named = {
      ...template,
      id: undefined,
      name: `${objects} — ${new Date().toISOString().slice(0, 10)}`,
      description: template.description,
    };
    saveTemplate.mutate({ template: named as unknown as Record<string, unknown> });
  }, [template, saveTemplate]);

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="seed-step-results-content">
      {!executionResult ? (
        <div className="text-center py-8 text-xs text-(--sf-text-secondary)">
          {t('common.noData')}
        </div>
      ) : (
        <>
          {/* Summary table */}
          <div className="flex items-center gap-3 text-xs" data-testid="result-summary">
            {/* A seed the Cancel stopped reads as cancelled, not as partially
                complete: what it inserted stays in the org, and is listed below. */}
            {executionResult.cancelled ? (
              <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
            ) : (
              <Badge variant={RESULTS_STATUS_VARIANT[executionResult.status]}>
                {executionResult.status === 'success'
                  ? t('seed.complete')
                  : executionResult.status === 'partial'
                    ? t('seed.partial')
                    : t('seed.failed')}
              </Badge>
            )}
            <span className="text-(--sf-text-primary)">
              {t('seed.recordsCreated')}: <strong>{executionResult.totalRecordsCreated}</strong>
            </span>
            {executionResult.totalRecordsFailed > 0 && (
              <span className="text-status-error">
                {t('seed.recordsFailed')}: <strong>{executionResult.totalRecordsFailed}</strong>
              </span>
            )}
            <span className="text-(--sf-text-secondary)">
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
              {(obj.errors.length > 0 || obj.aiFallback) && (
                <CardBody>
                  <div className="flex flex-col gap-1">
                    {obj.aiFallback && (
                      <p
                        className="text-[10px] text-status-warning"
                        data-testid="seed-result-ai-fallback"
                      >
                        {obj.aiFallback.reason === 'no-answer'
                          ? t('seed.results.aiFallback', {
                              fields: obj.aiFallback.fields.join(', '),
                            })
                          : t('seed.results.aiFallbackShort', {
                              fields: obj.aiFallback.fields.join(', '),
                            })}
                      </p>
                    )}
                    {obj.errors.map((err, i) => (
                      <p key={i} className="text-[10px] text-status-error">
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
            <Button
              variant="secondary"
              size="sm"
              // Disabled while a save is in flight, so a double click does not
              // store the run twice.
              disabled={!template || saveTemplate.loading}
              onClick={handleSaveTemplate}
              data-testid="btn-save-template"
            >
              {t('seed.saveAsTemplate')}
            </Button>
            <Button variant="secondary" size="sm" data-testid="btn-export-csv">
              {t('seed.exportCsv')}
            </Button>
            <Button variant="primary" size="sm" onClick={onSeedAgain} data-testid="btn-seed-again">
              {t('seed.seedAgain')}
            </Button>
            {saveTemplate.data?.success === true && (
              <span
                className="self-center text-[10px] text-(--sf-text-secondary)"
                data-testid="seed-template-saved"
              >
                {t('seed.templateSaved')}
              </span>
            )}
            {saveTemplate.error && (
              <span
                className="self-center text-[10px] text-status-error"
                data-testid="seed-template-save-error"
              >
                {saveTemplate.error}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
};
