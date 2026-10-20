import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { orgOptionLabel } from '../../utils/orgFormatters';
import { Step7Execute } from './Step7_Execute';
import { SeedRunRemoval } from './SeedRunRemoval';
import { SeedResultErrors } from './SeedResultErrors';
import { SeedOpenRecord } from './SeedOpenRecord';
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

/**
 * Renders the Quick Seed flow based on current phase: one confirmation of the
 * template picked — its record counts and the org, preselected, and a single
 * Start — then the run, which can be stopped, and its results.
 *
 * The counts used to be set in a dialog whose "Start Seeding" started
 * nothing, before a second step that asked for the org and had its own
 * "Start Seeding": two buttons of one name, of which the first was not one.
 */
export const QuickSeedFlow: React.FC<QuickSeedFlowProps> = ({ quickSeed, orgs }) => {
  const { t } = useTranslation();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const template = quickSeed.selectedTemplate;
  const templateName = template
    ? template.name.startsWith('seed.')
      ? t(template.name)
      : template.name
    : '';
  const countOf = (objectApiName: string, recordCount: number): number =>
    quickSeed.customizedCounts[objectApiName] ?? recordCount;
  const totalRecords = template
    ? template.objects.reduce((sum, obj) => sum + countOf(obj.objectApiName, obj.recordCount), 0)
    : 0;
  const runOrg = orgs.find((org) => org.id === quickSeed.selectedOrgId);
  const runOrgName = runOrg ? runOrg.alias || runOrg.username : '';

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="quick-seed-flow">
      {quickSeed.error && (
        <ErrorBanner
          message={quickSeed.error}
          onDismiss={() => quickSeed.setError(null)}
          data-testid="quick-seed-error"
        />
      )}

      {/* ----- CONFIRM PHASE: counts, org, Start ----- */}
      {quickSeed.phase === 'confirm' && template && (
        <Card data-testid="quick-seed-confirm">
          <CardHeader
            title={t('seed.quickSeed.templateSelected', { name: templateName })}
            action={
              <Badge variant="default">{t('seed.gallery.records', { count: totalRecords })}</Badge>
            }
          />
          <CardBody>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1" data-testid="quick-seed-counts">
                <span className="text-xs font-medium text-(--sf-text-primary)">
                  {t('seed.recordCount')}
                </span>
                {template.objects.map((obj) => (
                  <div key={obj.objectApiName} className="flex items-center gap-3 text-xs">
                    <span className="w-40 truncate text-(--sf-text-primary)">
                      {obj.objectApiName}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      value={countOf(obj.objectApiName, obj.recordCount)}
                      onChange={(e) =>
                        quickSeed.setCount(obj.objectApiName, parseInt(e.target.value, 10) || 1)
                      }
                      className="w-24"
                      aria-label={t('a11y.recordCountFor', { object: obj.objectApiName })}
                      data-testid={`quick-seed-count-${obj.objectApiName}`}
                    />
                  </div>
                ))}
              </div>

              <Select
                label={t('seed.quickSeed.selectOrg')}
                options={orgs.map((org) => ({
                  value: org.id,
                  label: orgOptionLabel(org, t),
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
      )}

      {/* ----- EXECUTING PHASE ----- */}
      {quickSeed.phase === 'executing' && (
        <div className="flex flex-col gap-(--sf-space-3)" data-testid="quick-seed-executing">
          <Step7Execute
            isRunning={quickSeed.isRunning}
            objectProgress={quickSeed.objectProgress}
            overallPercent={quickSeed.overallPercent}
            elapsedMs={quickSeed.elapsedMs}
          />
          {/* Offered once the run has reported progress, i.e. is registered:
              the wizard's Cancel, which the one-click path did not have. */}
          {quickSeed.isRunning && quickSeed.operationId && (
            <div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowCancelConfirm(true)}
                data-testid="btn-quick-seed-cancel"
              >
                {t('common.cancelRun')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ----- RESULTS PHASE ----- */}
      {quickSeed.phase === 'results' && (
        <div className="flex flex-col gap-(--sf-space-3)" data-testid="quick-seed-results">
          {quickSeed.executionResult ? (
            <>
              <div
                className="flex items-center gap-3 text-xs"
                data-testid="quick-seed-result-summary"
              >
                {/* A seed a cancel stopped reads as cancelled, as on the wizard. */}
                {quickSeed.executionResult.cancelled ? (
                  <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
                ) : (
                  <Badge variant={RESULTS_STATUS_VARIANT[quickSeed.executionResult.status]}>
                    {quickSeed.executionResult.status === 'success'
                      ? t('seed.complete')
                      : quickSeed.executionResult.status === 'partial'
                        ? t('seed.partial')
                        : t('seed.failed')}
                  </Badge>
                )}
                <span className="text-(--sf-text-primary)">
                  {t('seed.recordsCreated')}:{' '}
                  <strong>{quickSeed.executionResult.totalRecordsCreated}</strong>
                </span>
                {quickSeed.executionResult.totalRecordsFailed > 0 && (
                  <span className="text-status-error">
                    {t('seed.recordsFailed')}:{' '}
                    <strong>{quickSeed.executionResult.totalRecordsFailed}</strong>
                  </span>
                )}
                <span className="text-(--sf-text-secondary)">
                  {t('seed.executionTime')}:{' '}
                  {(quickSeed.executionResult.duration / 1000).toFixed(1)}s
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
                      <SeedResultErrors
                        objectApiName={obj.objectApiName}
                        errors={obj.errors}
                        recordsFailed={obj.recordsFailed}
                      />
                    </CardBody>
                  )}
                </Card>
              ))}

              {quickSeed.executionResult.totalRecordsCreated > 0 && (
                <SeedRunRemoval runId={quickSeed.executionResult.operationId} />
              )}

              <div className="flex flex-wrap gap-2 pt-2" data-testid="quick-seed-result-actions">
                {/* The seeded data, in the org: the payoff, first. */}
                <SeedOpenRecord result={quickSeed.executionResult} orgName={runOrgName} />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={quickSeed.reset}
                  data-testid="btn-back-to-gallery"
                >
                  {t('seed.quickSeed.backToGallery')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={quickSeed.execute}
                  data-testid="btn-seed-again-quick"
                >
                  {t('seed.quickSeed.seedAgain')}
                </Button>
              </div>
            </>
          ) : (
            <div className="text-center py-8 text-xs text-(--sf-text-secondary)">
              {t('common.noData')}
            </div>
          )}
        </div>
      )}

      <DangerConfirm
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={() => {
          setShowCancelConfirm(false);
          quickSeed.cancel();
        }}
        title={t('common.cancelRun')}
        description={t('seed.cancelRunConfirm')}
        confirmText={t('common.cancel')}
      />
    </div>
  );
};
