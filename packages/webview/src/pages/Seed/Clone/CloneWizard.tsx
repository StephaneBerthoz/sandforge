import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../../../stores/useOrgStore';
import { Wizard } from '../../../components/ui/Wizard';
import type { WizardStep } from '../../../components/ui/Wizard';
import { Skeleton } from '../../../components/ui/Skeleton';
import { Badge } from '../../../components/ui/Badge';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { CloneSourcePicker } from './CloneSourcePicker';
import { CloneObjectSelector } from './CloneObjectSelector';
import { ClonePreviewPanel } from './ClonePreviewPanel';
import { CloneResultsPanel } from './CloneResultsPanel';
import { useClone } from './useClone';
import type { CloneStep } from './useClone';

/** Clone wizard step definitions. */
const CLONE_STEPS: WizardStep[] = [
  { id: 'source', labelKey: 'seed.clone.wizard.stepSource' },
  { id: 'objects', labelKey: 'seed.clone.wizard.stepObjects' },
  { id: 'preview', labelKey: 'seed.clone.wizard.stepPreview' },
  { id: 'execute', labelKey: 'seed.clone.wizard.stepExecute' },
];

/** Map CloneStep to numeric step index. */
const STEP_INDEX: Record<CloneStep, number> = {
  source: 0,
  objects: 1,
  preview: 2,
  execute: 3,
};

/** Map numeric index to CloneStep. */
const INDEX_STEP: CloneStep[] = ['source', 'objects', 'preview', 'execute'];

/** Props for the CloneWizard component. */
export interface CloneWizardProps {
  /** Callback when the user exits the clone flow (back to mode selector). */
  onBack: () => void;
  /** Source org selected on open (Home's clone recommendation), if any. */
  initialSourceOrgId?: string;
}

/**
 * Four-step wizard for the clone operation:
 * 1. Source Org -- pick the source org
 * 2. Select Objects -- choose which objects to clone with optional WHERE filters
 * 3. Preview -- view record counts, insert order, sample data
 * 4. Execute & Results -- progress tracking and final results
 */
export const CloneWizard: React.FC<CloneWizardProps> = ({ onBack, initialSourceOrgId }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const targetOrgId = selectedOrgId ?? '';

  const clone = useClone(targetOrgId, initialSourceOrgId);

  const currentStepIndex = STEP_INDEX[clone.step];

  /**
   * Whether both orgs are there. Next on the objects step sends the preview,
   * which goes from one to the other: sent with no org selected, it came back
   * as the bridge's refusal, "Invalid payload — targetOrgId: …".
   */
  const bothOrgs = !!clone.sourceOrgId && !!targetOrgId;

  /** Determine if the user can advance to the next step. */
  const canGoNext = (): boolean => {
    switch (clone.step) {
      case 'source':
        return !!clone.sourceOrgId && clone.sourceObjects.length > 0;
      case 'objects':
        return clone.selectedObjects.length > 0 && bothOrgs;
      case 'preview':
        return clone.executionStatus !== 'previewing';
      case 'execute':
        return false;
      default:
        return false;
    }
  };

  /** Handle step changes from the Wizard navigation. */
  const handleStepChange = (stepIndex: number): void => {
    const targetStep = INDEX_STEP[stepIndex];
    if (!targetStep) return;

    // While the clone runs, the wizard stays on it: a step left for another
    // could preview again, or run a second clone, over the one in flight.
    if (clone.executionStatus === 'executing') return;

    // If advancing to preview, trigger preview first
    if (targetStep === 'preview' && clone.step === 'objects') {
      clone.handlePreview();
      return;
    }

    // Next on the preview runs the clone, as Execute does: it went on to an
    // empty execute step and ran nothing. Back on the preview of a run that
    // ended, it shows that run again rather than sending another.
    if (targetStep === 'execute' && clone.step === 'preview') {
      if (clone.executionResult) clone.setStep('execute');
      else clone.handleExecute();
      return;
    }

    clone.setStep(targetStep);
  };

  /** Handle the wizard "finish" action. */
  const handleFinish = (): void => {
    if (clone.step === 'execute' && clone.executionResult) {
      onBack();
    }
  };

  const isFinished = clone.step === 'execute' && clone.executionResult !== null;

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="clone-wizard-container">
      {/* Dismissed, the banner goes and nothing else: it reset the whole
          wizard, the objects picked and the preview with it. */}
      {clone.error && (
        <ErrorBanner
          message={clone.error}
          onDismiss={clone.dismissError}
          data-testid="clone-error"
        />
      )}

      <Wizard
        steps={CLONE_STEPS}
        currentStep={currentStepIndex}
        onStepChange={handleStepChange}
        canGoNext={canGoNext()}
        canGoBack={clone.executionStatus !== 'executing'}
        // The steps passed ignore a click while the clone runs: drawn as
        // steps to go back to, they kept the hover and the pointer of one.
        canRevisitSteps={clone.executionStatus !== 'executing'}
        isFinished={isFinished}
        onFinish={handleFinish}
        testIdPrefix="clone"
      >
        {/* Step 1: Source Org */}
        {clone.step === 'source' && (
          <CloneSourcePicker
            sourceOrgId={clone.sourceOrgId}
            targetOrgId={targetOrgId}
            orgs={orgs}
            onSourceSelected={clone.handleSourceOrgSelected}
            loading={clone.loadingSource}
          />
        )}

        {/* Step 2: Select Objects */}
        {clone.step === 'objects' && (
          <>
            <CloneObjectSelector
              sourceObjects={clone.sourceObjects}
              selectedObjects={clone.selectedObjects}
              onObjectToggle={clone.handleObjectToggle}
              onWhereClauseChange={clone.handleWhereClauseChange}
              loading={clone.loadingSource}
            />
            {/* Why Next stays off: the preview it sends needs both orgs. */}
            {!bothOrgs && (
              <p
                className="mt-(--sf-space-2) text-xs text-(--sf-text-secondary)"
                role="status"
                data-testid="clone-needs-both-orgs"
              >
                {t('seed.clone.wizard.needsBothOrgs')}
              </p>
            )}
          </>
        )}

        {/* Step 3: Preview */}
        {clone.step === 'preview' && (
          <>
            {clone.executionStatus === 'previewing' ? (
              <div className="flex flex-col gap-(--sf-space-3)" data-testid="clone-preview-loading">
                {/* Said as well as drawn: the placeholders are hidden from a
                    screen reader, and this is what it reads out. */}
                <p role="status" className="text-xs text-(--sf-text-secondary)">
                  {t('seed.clone.preview.loading')}
                </p>
                <Skeleton variant="text" width="40%" height="1em" />
                <Skeleton variant="rect" height="100px" />
                <Skeleton variant="rect" height="80px" />
                <Skeleton variant="text" width="60%" height="1em" />
              </div>
            ) : clone.previewResult ? (
              <ClonePreviewPanel
                previewResult={clone.previewResult}
                onExecute={clone.handleExecute}
                onBack={() => clone.setStep('objects')}
              />
            ) : null}
          </>
        )}

        {/* Step 4: Execute & Results */}
        {clone.step === 'execute' && (
          <>
            {clone.executionStatus === 'executing' ? (
              <div className="flex flex-col gap-(--sf-space-3)" data-testid="clone-executing">
                <span className="text-sm font-semibold text-(--sf-text-primary)">
                  {t('seed.running')}
                </span>
                {clone.selectedObjects.map((obj) => (
                  <div key={obj.objectApiName} className="flex items-center gap-2 text-xs">
                    <Badge variant="info">{obj.objectApiName}</Badge>
                    <div className="flex-1 h-2 rounded-full bg-(--sf-bg-input) overflow-hidden">
                      <div className="h-full bg-(--sf-accent) animate-pulse w-1/2 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : clone.executionResult ? (
              <CloneResultsPanel result={clone.executionResult} onDone={onBack} />
            ) : null}
          </>
        )}
      </Wizard>
    </div>
  );
};
