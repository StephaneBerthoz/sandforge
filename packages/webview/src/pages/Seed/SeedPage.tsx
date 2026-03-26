import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedTemplate } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { PageHeader } from '../../components/ui/PageHeader';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Select } from '../../components/ui/Select';
import { Accordion } from '../../components/ui/Accordion';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Divider } from '../../components/ui/Divider';
import { SeedWizard } from './SeedWizard';
import type { WizardStep } from './SeedWizard';
import { Step2SelectObjects } from './Step2_SelectObjects';
import { Step3ConfigureFields } from './Step3_ConfigureFields';
import { Step7Execute } from './Step7_Execute';
import { TemplateGallery } from './TemplateGallery';
import { QuickSeedFlow } from './QuickSeedFlow';
import { useSeedWizardState } from './useSeedWizardState';
import { useQuickSeed } from './useQuickSeed';
import type { PIIObjectResult } from './useSeedWizardState';
import type { BadgeVariant } from '../../components/ui/Badge';

const SEED_STEPS: WizardStep[] = [
  { id: 'select', labelKey: 'seed.stepSelect' },
  { id: 'configure', labelKey: 'seed.stepConfigure' },
  { id: 'execute', labelKey: 'seed.stepExecute' },
  { id: 'results', labelKey: 'seed.stepResults' },
];

const RESULTS_STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Main Seed page -- 4-step wizard with progressive disclosure. */
export const SeedPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const state = useSeedWizardState(t);
  const quickSeed = useQuickSeed();

  const handleSelectTemplate = (template: SeedTemplate, customizedCounts: Record<string, number>) => {
    quickSeed.startQuickSeed(template, customizedCounts);
  };

  if (orgs.length === 0) {
    return (
      <EmptyState
        icon="database"
        title={t('seed.title')}
        description={t('org.noOrgs')}
      />
    );
  }

  /* Determine page subtitle based on mode */
  const pageSubtitle = quickSeed.phase !== 'idle'
    ? t('seed.quickSeed.title')
    : t(SEED_STEPS[state.currentStep].labelKey);

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]" data-testid="seed-page">
      <PageHeader
        title={t('seed.title')}
        subtitle={pageSubtitle}
        icon="database"
        actions={
          state.selectedOrg ? (
            <OrgBadge
              alias={state.selectedOrg.alias || state.selectedOrg.username}
              orgType={String(state.selectedOrg.orgType)}
              status={state.selectedOrg.status}
              instanceUrl={state.selectedOrg.instanceUrl}
            />
          ) : undefined
        }
      />

      {state.error && (
        <ErrorBanner message={state.error} onDismiss={() => state.setError(null)} data-testid="seed-error" />
      )}

      {/* ----- QUICK SEED FLOW (replaces gallery + wizard when active) ----- */}
      {quickSeed.phase !== 'idle' ? (
        <QuickSeedFlow quickSeed={quickSeed} orgs={orgs} />
      ) : (
        <>
          {/* ----- QUICK SEED GALLERY (visible on step 0) ----- */}
          {state.currentStep === 0 && (
            <>
              <TemplateGallery onSelectTemplate={handleSelectTemplate} />
              <Divider label={t('seed.gallery.orCustomize')} />
            </>
          )}

          <SeedWizard
            steps={SEED_STEPS}
            currentStep={state.currentStep}
            onStepChange={state.setCurrentStep}
            canGoNext={state.canGoNext}
            isFinished={state.isFinished}
            onFinish={state.handleExecute}
          >
            {/* ----- STEP 1: SELECT ----- */}
            {state.currentStep === 0 && (
              <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="seed-step-select-content">
                {/* Org selector */}
                <Select
                  label={t('seed.selectOrg')}
                  options={orgs.map((org) => ({
                    value: org.id,
                    label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}`,
                  }))}
                  value={state.selectedOrgId}
                  onChange={(e) => state.handleOrgSelect(e.target.value)}
                  placeholder={t('seed.selectOrg')}
                  data-testid="org-selector"
                />

                {/* Object multi-select with inline volume */}
                {state.selectedOrgId && (
                  state.loadingObjects ? (
                    <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid="seed-objects-skeleton">
                      <Skeleton variant="text" width="30%" height="1em" />
                      <Skeleton variant="rect" height="120px" />
                      <Skeleton variant="text" width="50%" height="1em" />
                    </div>
                  ) : (
                    <>
                      <Step2SelectObjects
                        availableObjects={state.availableObjects}
                        selectedObjects={state.selectedObjects}
                        onToggle={state.handleToggleObject}
                      />

                      {/* Inline volume inputs for selected objects */}
                      {state.selectedObjects.length > 0 && (
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                            {t('seed.recordCount')}
                          </span>
                          {state.selectedObjects.map((obj) => (
                            <div key={obj} className="flex items-center gap-2 text-xs">
                              <span className="w-40 truncate text-[var(--vscode-editor-foreground,#d4d4d4)]">{obj}</span>
                              <Input
                                type="number"
                                min={1}
                                value={state.volumes[obj]?.count ?? 100}
                                onChange={(e) => state.handleChangeVolume(obj, parseInt(e.target.value, 10) || 0)}
                                className="w-24"
                                data-testid={`volume-${obj}`}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* PII badge warnings on selected objects */}
                      {state.hasPiiWarnings && (
                        <div
                          className="flex flex-col gap-[var(--sf-space-2)] p-[var(--sf-space-3)] rounded border border-amber-600 bg-amber-950/30"
                          role="alert"
                          data-testid="pii-scan-warning"
                        >
                          <span className="text-sm font-medium text-amber-400">
                            {t('seed.piiWarningTitle')}
                          </span>
                          {state.piiResults
                            .filter((r: PIIObjectResult) => r.piiFields.length > 0)
                            .map((r: PIIObjectResult) => (
                              <div key={r.objectName} className="flex flex-col gap-1">
                                <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                                  {r.objectName}
                                </span>
                                <div className="flex flex-wrap gap-1">
                                  {r.piiFields.map((f: PIIObjectResult['piiFields'][number]) => (
                                    <Badge key={`${r.objectName}-${f.fieldName}`} variant="warning">
                                      {f.fieldName} ({f.piiType} -- {Math.round(f.confidence * 100)}%)
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            ))}
                          <span className="text-xs text-amber-400/80">
                            {t('seed.piiWarningHint')}
                          </span>
                        </div>
                      )}

                      {/* NL2SOQL Helper */}
                      <div
                        className="flex flex-col gap-[var(--sf-space-2)] p-[var(--sf-space-3)] rounded border border-[var(--vscode-input-border,#3c3c3c)] bg-[var(--vscode-editor-background)]"
                        data-testid="nl2soql-helper"
                      >
                        <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                          {t('seed.nl2soqlTitle')}
                        </span>
                        <div className="flex gap-[var(--sf-space-2)] items-end">
                          <div className="flex-1">
                            <Input
                              placeholder={t('seed.nl2soqlPlaceholder')}
                              value={state.nl2soqlQuery}
                              onChange={(e) => state.setNl2soqlQuery(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && state.handleNl2soql()}
                              disabled={state.nl2soql.loading || !state.selectedOrgId}
                              data-testid="nl2soql-input"
                            />
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={state.nl2soql.loading}
                            disabled={!state.nl2soqlQuery.trim() || !state.selectedOrgId}
                            onClick={state.handleNl2soql}
                            data-testid="nl2soql-button"
                          >
                            {t('seed.nl2soqlGenerate')}
                          </Button>
                        </div>
                        {state.nl2soql.data?.soql && (
                          <div className="relative group" data-testid="nl2soql-result">
                            <pre className="text-xs p-2.5 rounded bg-[var(--vscode-input-background,#3c3c3c)] font-mono text-[var(--vscode-editor-foreground,#d4d4d4)] overflow-x-auto whitespace-pre-wrap">
                              {state.nl2soql.data.soql}
                            </pre>
                            <button
                              className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#fff)] opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => navigator.clipboard.writeText(state.nl2soql.data?.soql ?? '')}
                              data-testid="nl2soql-copy"
                            >
                              {t('common.copy')}
                            </button>
                          </div>
                        )}
                        {state.nl2soql.data?.explanation && (
                          <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                            {state.nl2soql.data.explanation}
                          </span>
                        )}
                        {(state.nl2soql.error ?? (state.nl2soql.data && !state.nl2soql.data.success ? state.nl2soql.data.error : null)) && (
                          <span className="text-xs text-[var(--vscode-errorForeground,#f48771)]" role="alert" data-testid="nl2soql-error">
                            {state.nl2soql.error ?? state.nl2soql.data?.error ?? t('seed.nl2soqlError')}
                          </span>
                        )}
                      </div>
                    </>
                  )
                )}
              </div>
            )}

            {/* ----- STEP 2: CONFIGURE ----- */}
            {state.currentStep === 1 && (
              <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="seed-step-configure-content">
                {/* Collapsible field tree per object */}
                {state.piiLoading && (
                  <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid="pii-scan-loading">
                    <Skeleton variant="text" width="40%" height="1em" />
                    <Skeleton variant="rect" height="80px" />
                  </div>
                )}

                <Step3ConfigureFields
                  objectConfigs={state.fieldConfigs.filter((c) => state.selectedObjects.includes(c.objectApiName))}
                  onChangeRule={state.handleChangeFieldRule}
                  onChangeConfig={state.handleChangeFieldConfig}
                />

                {/* Advanced section (Accordion) */}
                <Accordion
                  items={[
                    {
                      title: t('seed.advancedSettings'),
                      content: (
                        <div className="flex flex-col gap-3" data-testid="seed-advanced-settings">
                          {/* Batch size per object */}
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                              {t('seed.batchSize')}
                            </span>
                            {state.selectedObjects.map((obj) => (
                              <div key={obj} className="flex items-center gap-2 text-xs">
                                <span className="w-40 truncate text-[var(--vscode-editor-foreground,#d4d4d4)]">{obj}</span>
                                <Input
                                  type="number"
                                  min={1}
                                  max={10000}
                                  value={state.volumes[obj]?.batchSize ?? 200}
                                  onChange={(e) => state.handleChangeBatchSize(obj, parseInt(e.target.value, 10) || 200)}
                                  className="w-24"
                                  data-testid={`batch-${obj}`}
                                />
                              </div>
                            ))}
                          </div>

                          {/* Relations handling */}
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                              {t('seed.configureRelations')}
                            </span>
                            {state.relations.length === 0 && (
                              <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                                {t('seed.noDependencies')}
                              </p>
                            )}
                            {state.relations.map((rel, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs">
                                <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{rel.childObject}.{rel.childField}</span>
                                <Badge variant="default">{'\u2192'}</Badge>
                                <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">{rel.parentObject}.{rel.parentField}</span>
                                <button
                                  className="text-[var(--vscode-errorForeground,#f48771)] hover:opacity-70 px-1"
                                  onClick={() => state.handleRemoveRelation(i)}
                                  data-testid={`remove-relation-${i}`}
                                >
                                  x
                                </button>
                              </div>
                            ))}
                            <button
                              className="text-xs text-[var(--vscode-focusBorder,#007fd4)] hover:underline self-start"
                              onClick={state.handleAddRelation}
                              data-testid="add-relation-btn"
                            >
                              + {t('seed.addObject')}
                            </button>
                          </div>

                          {/* PII toggles */}
                          {state.hasPiiWarnings && (
                            <div className="flex flex-col gap-1">
                              <span className="text-xs font-medium text-amber-400">
                                {t('seed.piiWarningTitle')}
                              </span>
                              {state.piiResults
                                .filter((r: PIIObjectResult) => r.piiFields.length > 0)
                                .map((r: PIIObjectResult) => (
                                  <div key={r.objectName} className="flex flex-wrap gap-1">
                                    {r.piiFields.map((f: PIIObjectResult['piiFields'][number]) => (
                                      <Badge key={`${r.objectName}-${f.fieldName}`} variant="warning">
                                        {f.fieldName} ({f.piiType})
                                      </Badge>
                                    ))}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            )}

            {/* ----- STEP 3: EXECUTE ----- */}
            {state.currentStep === 2 && (
              <div data-testid="seed-step-execute-content">
                <Step7Execute
                  isRunning={state.isRunning}
                  objectProgress={state.objectProgress}
                  overallPercent={state.isRunning ? 50 : 0}
                  elapsedMs={0}
                />
              </div>
            )}

            {/* ----- STEP 4: RESULTS ----- */}
            {state.currentStep === 3 && (
              <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="seed-step-results-content">
                {!state.executionResult ? (
                  <div className="text-center py-8 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('common.noData')}
                  </div>
                ) : (
                  <>
                    {/* Summary table */}
                    <div className="flex items-center gap-3 text-xs" data-testid="result-summary">
                      <Badge variant={RESULTS_STATUS_VARIANT[state.executionResult.status]}>
                        {state.executionResult.status === 'success'
                          ? t('seed.complete')
                          : state.executionResult.status === 'partial'
                            ? t('seed.partial')
                            : t('seed.failed')}
                      </Badge>
                      <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                        {t('seed.recordsCreated')}: <strong>{state.executionResult.totalRecordsCreated}</strong>
                      </span>
                      {state.executionResult.totalRecordsFailed > 0 && (
                        <span className="text-[var(--vscode-errorForeground,#f48771)]">
                          {t('seed.recordsFailed')}: <strong>{state.executionResult.totalRecordsFailed}</strong>
                        </span>
                      )}
                      <span className="text-[var(--vscode-descriptionForeground,#868686)]">
                        {t('seed.executionTime')}: {(state.executionResult.duration / 1000).toFixed(1)}s
                      </span>
                    </div>

                    {/* Per-object results */}
                    {state.executionResult.objectResults.map((obj) => (
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

                    {/* Action buttons: Save, Export CSV, Seed Again */}
                    <div className="flex gap-2 pt-2" data-testid="result-actions">
                      <Button variant="secondary" size="sm" data-testid="btn-save-template">
                        {t('seed.saveAsTemplate')}
                      </Button>
                      <Button variant="secondary" size="sm" data-testid="btn-export-csv">
                        {t('seed.exportCsv')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => state.setCurrentStep(0)}
                        data-testid="btn-seed-again"
                      >
                        {t('seed.seedAgain')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </SeedWizard>
        </>
      )}
    </div>
  );
};
