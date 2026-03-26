import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Step7Execute } from './Step7_Execute';
import type { QuickSeedState } from './useQuickSeed';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Props for the QuickSeedFlow component. */
export interface QuickSeedFlowProps {
  /** Quick Seed state and actions. */
  quickSeed: QuickSeedState;
  /** Available orgs to select from. */
  orgs: SalesforceOrg[];
}

/** Status badge variant mapping. */
const RESULTS_STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Renders the Quick Seed flow based on current phase. */
export const QuickSeedFlow: React.FC<QuickSeedFlowProps> = ({ quickSeed, orgs }) => {
  const { t } = useTranslation();

  const templateName = quickSeed.selectedTemplate
    ? (quickSeed.selectedTemplate.name.startsWith('seed.')
      ? t(quickSeed.selectedTemplate.name)
      : quickSeed.selectedTemplate.name)
    : '';

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="quick-seed-flow">
      {quickSeed.error && (
        <ErrorBanner
          message={quickSeed.error}
          onDismiss={() => quickSeed.setError(null)}
          data-testid="quick-seed-error"
        />
      )}

      {/* ----- SELECT ORG PHASE ----- */}
      {quickSeed.phase === 'selectOrg' && (
        <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="quick-seed-select-org">
          <Card>
            <CardHeader
              title={t('seed.quickSeed.templateSelected', { name: templateName })}
              action={
                <Badge variant="default">
                  {t('seed.gallery.objects', { count: quickSeed.selectedTemplate?.objects.length ?? 0 })}
                </Badge>
              }
            />
            <CardBody>
              <div className="flex flex-col gap-3">
                <Select
                  label={t('seed.quickSeed.selectOrg')}
                  options={orgs.map((org) => ({
                    value: org.id,
                    label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}`,
                  }))}
                  value={quickSeed.selectedOrgId}
                  onChange={(e) => quickSeed.selectOrg(e.target.value)}
                  placeholder={t('seed.quickSeed.selectOrg')}
                  data-testid="quick-seed-org-selector"
                />

                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={quickSeed.reset}
                    data-testid="btn-quick-seed-back"
                  >
                    {t('common.back')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!quickSeed.selectedOrgId}
                    onClick={quickSeed.execute}
                    data-testid="btn-quick-seed-start"
                  >
                    {t('seed.quickSeed.startSeeding')}
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* ----- EXECUTING PHASE ----- */}
      {quickSeed.phase === 'executing' && (
        <div data-testid="quick-seed-executing">
          <Step7Execute
            isRunning={quickSeed.isRunning}
            objectProgress={quickSeed.objectProgress}
            overallPercent={quickSeed.overallPercent}
            elapsedMs={quickSeed.elapsedMs}
          />
        </div>
      )}

      {/* ----- RESULTS PHASE ----- */}
      {quickSeed.phase === 'results' && (
        <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="quick-seed-results">
          {quickSeed.executionResult ? (
            <>
              <div className="flex items-center gap-3 text-xs" data-testid="quick-seed-result-summary">
                <Badge variant={RESULTS_STATUS_VARIANT[quickSeed.executionResult.status]}>
                  {quickSeed.executionResult.status === 'success'
                    ? t('seed.complete')
                    : quickSeed.executionResult.status === 'partial'
                      ? t('seed.partial')
                      : t('seed.failed')}
                </Badge>
                <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                  {t('seed.recordsCreated')}: <strong>{quickSeed.executionResult.totalRecordsCreated}</strong>
                </span>
                {quickSeed.executionResult.totalRecordsFailed > 0 && (
                  <span className="text-[var(--vscode-errorForeground,#f48771)]">
                    {t('seed.recordsFailed')}: <strong>{quickSeed.executionResult.totalRecordsFailed}</strong>
                  </span>
                )}
                <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                  {t('seed.executionTime')}: {(quickSeed.executionResult.duration / 1000).toFixed(1)}s
                </span>
              </div>

              {quickSeed.executionResult.objectResults.map((obj) => (
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

              <div className="flex gap-2 pt-2" data-testid="quick-seed-result-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={quickSeed.reset}
                  data-testid="btn-back-to-gallery"
                >
                  {t('seed.quickSeed.backToGallery')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={quickSeed.execute}
                  data-testid="btn-seed-again-quick"
                >
                  {t('seed.quickSeed.seedAgain')}
                </Button>
              </div>
            </>
          ) : (
            <div className="text-center py-8 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('common.noData')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
