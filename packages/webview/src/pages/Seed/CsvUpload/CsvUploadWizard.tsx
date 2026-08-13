import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../../../stores/useOrgStore';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Skeleton } from '../../../components/ui/Skeleton';
import { Badge } from '../../../components/ui/Badge';
import { FileDropZone } from '../../../components/ui/FileDropZone';
import { CsvPreview } from './CsvPreview';
import { CsvColumnMapper } from './CsvColumnMapper';
import { CsvValidationPanel } from './CsvValidationPanel';
import { useCsvImport } from './useCsvImport';
import type { CsvImportStep } from './useCsvImport';

/** Props for the CsvUploadWizard component. */
export interface CsvUploadWizardProps {
  /** Callback when the user wants to return to mode selection. */
  onBack: () => void;
}

/** Wizard step definition for the CSV import flow. */
interface StepDef {
  id: CsvImportStep;
  labelKey: string;
}

/** Step definitions for the 4-step wizard. */
const CSV_STEPS: StepDef[] = [
  { id: 'upload', labelKey: 'seed.csv.wizard.stepUpload' },
  { id: 'map', labelKey: 'seed.csv.wizard.stepMap' },
  { id: 'validate', labelKey: 'seed.csv.wizard.stepValidate' },
  { id: 'execute', labelKey: 'seed.csv.wizard.stepExecute' },
];

/** Map step ID to numeric index. */
const STEP_INDEX: Record<CsvImportStep, number> = {
  upload: 0,
  map: 1,
  validate: 2,
  execute: 3,
};

/**
 * Four-step CSV import wizard: Upload -> Map Columns -> Validate -> Execute.
 *
 * Integrates FileDropZone, CsvColumnMapper, CsvValidationPanel, and
 * execution progress into a linear wizard flow. Uses useCsvImport hook
 * for all state management.
 */
export const CsvUploadWizard: React.FC<CsvUploadWizardProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const csv = useCsvImport(t);

  const describeGlobal = useBridgeQuery<{ objects: Array<{ apiName: string; label: string }> }>(
    'seed:describe-global',
    csv.targetOrgId ? { orgId: csv.targetOrgId } : undefined,
    { skip: !csv.targetOrgId },
  );

  const currentIndex = STEP_INDEX[csv.step];

  /** Navigate to previous step. */
  const handleBack = () => {
    const steps: CsvImportStep[] = ['upload', 'map', 'validate', 'execute'];
    const idx = steps.indexOf(csv.step);
    if (idx > 0) {
      csv.setStep(steps[idx - 1]);
    }
  };

  /** Navigate to next step. */
  const handleNext = () => {
    const steps: CsvImportStep[] = ['upload', 'map', 'validate', 'execute'];
    const idx = steps.indexOf(csv.step);
    if (idx < steps.length - 1) {
      csv.setStep(steps[idx + 1]);
    }
  };

  /** Auto-trigger validation when entering validate step. */
  useEffect(() => {
    if (csv.step === 'validate' && !csv.validationResult && csv.executionStatus !== 'validating') {
      csv.handleValidate();
    }
  }, [csv.step]); // eslint-disable-line react-hooks/exhaustive-deps

  const canGoNext = (): boolean => {
    switch (csv.step) {
      case 'upload':
        return (
          !!csv.file && !!csv.targetOrgId && !!csv.targetObjectApiName && csv.headers.length > 0
        );
      case 'map':
        return csv.columnMappings.some((m) => m.sfFieldApiName !== '');
      case 'validate':
        return false; // Proceed via CsvValidationPanel
      case 'execute':
        return false;
      default:
        return false;
    }
  };

  const orgOptions = orgs.map((org) => ({
    value: org.id,
    label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}`,
  }));

  const objectOptions =
    describeGlobal.data?.objects.map((obj) => ({
      value: obj.apiName,
      label: `${obj.label} (${obj.apiName})`,
    })) ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="csv-upload-wizard">
      {/* Step indicator */}
      <nav
        className="flex gap-1"
        role="group"
        aria-label={t('a11y.csvImportSteps', 'CSV import steps')}
        data-testid="csv-step-indicator"
      >
        {CSV_STEPS.map((step, i) => {
          const isCompleted = i < currentIndex;
          const isCurrent = i === currentIndex;

          return (
            <div
              key={step.id}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
                isCurrent
                  ? 'bg-[var(--sf-bg-active)] font-semibold text-[var(--sf-text-primary)]'
                  : isCompleted
                    ? 'text-[var(--sf-text-secondary)]'
                    : 'text-[var(--sf-text-muted)] opacity-50'
              }`}
              data-testid={`csv-indicator-${step.id}`}
            >
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-[var(--sf-bg-input)]">
                {i + 1}
              </span>
              {t(step.labelKey)}
            </div>
          );
        })}
      </nav>

      {/* Step content */}
      <div className="flex-1" data-testid="csv-step-content">
        {/* STEP 1: Upload */}
        {csv.step === 'upload' && (
          <div className="flex flex-col gap-3" data-testid="csv-step-upload">
            <Select
              label={t('seed.csv.wizard.selectOrg')}
              options={orgOptions}
              value={csv.targetOrgId}
              onChange={(e) => {
                csv.setTargetOrgId(e.target.value);
              }}
              placeholder={t('seed.csv.wizard.selectOrg')}
              data-testid="csv-org-selector"
            />

            {csv.targetOrgId &&
              (describeGlobal.loading ? (
                <Skeleton variant="rect" height="40px" />
              ) : (
                <Select
                  label={t('seed.csv.wizard.selectObject')}
                  options={objectOptions}
                  value={csv.targetObjectApiName}
                  onChange={(e) => {
                    csv.handleObjectSelected(csv.targetOrgId, e.target.value);
                  }}
                  placeholder={t('seed.csv.wizard.selectObject')}
                  data-testid="csv-object-selector"
                />
              ))}

            <FileDropZone
              onFileSelected={csv.handleFileSelected}
              accept=".csv"
              disabled={!csv.targetOrgId}
            />

            {csv.previewRows.length > 0 && (
              <CsvPreview
                headers={csv.headers}
                rows={csv.previewRows}
                totalRowCount={csv.parsedRows.length}
              />
            )}
          </div>
        )}

        {/* STEP 2: Map Columns */}
        {csv.step === 'map' && (
          <div data-testid="csv-step-map">
            {csv.describeLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton variant="text" width="40%" height="1em" />
                <Skeleton variant="rect" height="200px" />
              </div>
            ) : (
              <CsvColumnMapper
                headers={csv.headers}
                columnMappings={csv.columnMappings}
                describeFields={csv.describeFields}
                onMappingChange={csv.handleMappingChange}
              />
            )}
          </div>
        )}

        {/* STEP 3: Validate */}
        {csv.step === 'validate' && (
          <div data-testid="csv-step-validate">
            {csv.validateLoading || csv.executionStatus === 'validating' ? (
              <div className="flex flex-col items-center gap-3 py-6">
                <Skeleton variant="rect" height="100px" />
                <span className="text-xs text-[var(--sf-text-secondary)]">
                  {t('seed.csv.validation.title')}...
                </span>
              </div>
            ) : csv.validationResult ? (
              <CsvValidationPanel
                validationResult={csv.validationResult}
                onBack={() => csv.setStep('map')}
                onProceed={() => csv.setStep('execute')}
              />
            ) : null}
          </div>
        )}

        {/* STEP 4: Execute */}
        {csv.step === 'execute' && (
          <div className="flex flex-col gap-4" data-testid="csv-step-execute">
            {csv.executionStatus === 'idle' && (
              <div className="flex flex-col items-center gap-3 py-6">
                <span className="text-sm text-[var(--sf-text-primary)]">
                  {t('seed.csv.wizard.execute')}
                </span>
                <Badge variant="default">
                  {csv.parsedRows.length} {t('seed.records')}
                </Badge>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={csv.handleExecute}
                  data-testid="execute-button"
                >
                  {t('seed.csv.wizard.execute')}
                </Button>
              </div>
            )}

            {csv.executionStatus === 'executing' && (
              <div className="flex flex-col items-center gap-3 py-6" data-testid="csv-executing">
                <Skeleton variant="rect" height="60px" />
                <span className="text-xs text-[var(--sf-text-secondary)]">
                  {t('seed.csv.wizard.executing')}
                </span>
              </div>
            )}

            {csv.executionStatus === 'complete' && csv.executionResult && (
              <div className="flex flex-col items-center gap-3 py-6" data-testid="csv-complete">
                <Badge variant="success">
                  {t('seed.csv.wizard.inserted', { count: csv.executionResult.insertedCount })}
                </Badge>
                {csv.executionResult.failedCount > 0 && (
                  <Badge variant="error">
                    {t('seed.csv.wizard.failed', { count: csv.executionResult.failedCount })}
                  </Badge>
                )}
                {csv.executionResult.errors.length > 0 && (
                  <div className="flex flex-col gap-1 max-w-md">
                    {csv.executionResult.errors.slice(0, 5).map((err, i) => (
                      <span key={i} className="text-[10px] text-[var(--sf-error)]">
                        {err}
                      </span>
                    ))}
                  </div>
                )}
                <Button variant="primary" size="sm" onClick={onBack} data-testid="done-button">
                  {t('seed.csv.wizard.done')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Navigation bar */}
      <div className="flex justify-between items-center pt-2 border-t border-[var(--sf-border)]">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onBack} data-testid="csv-cancel-button">
            {t('seed.csv.wizard.cancel')}
          </Button>
          {csv.step !== 'upload' && csv.step !== 'execute' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBack}
              data-testid="csv-back-button"
            >
              {t('seed.csv.wizard.back')}
            </Button>
          )}
        </div>
        {(csv.step === 'upload' || csv.step === 'map') && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleNext}
            disabled={!canGoNext()}
            data-testid="csv-next-button"
          >
            {t('seed.csv.wizard.next')}
          </Button>
        )}
      </div>
    </div>
  );
};
