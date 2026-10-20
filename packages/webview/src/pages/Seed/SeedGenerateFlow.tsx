import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import type { PersonaMsg } from '@sandforge/shared';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { PageHeader } from '../../components/ui/PageHeader';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { SeedWizard } from './SeedWizard';
import type { WizardStep } from './SeedWizard';
import { SeedSelectStep } from './SeedSelectStep';
import { SeedConfigureStep } from './SeedConfigureStep';
import { SeedExecuteStep } from './SeedExecuteStep';
import { SeedResultsStep } from './SeedResultsStep';
import { useSeedWizardState } from './useSeedWizardState';
import { PersonaGallery } from './Persona/PersonaGallery';
import { personaName } from './Persona/personaText';
import { refusedForEmails, useSeedAutomation } from './useSeedAutomation';

const SEED_STEPS: WizardStep[] = [
  { id: 'select', labelKey: 'seed.stepSelect' },
  { id: 'configure', labelKey: 'seed.stepConfigure' },
  { id: 'execute', labelKey: 'seed.stepExecute' },
  { id: 'results', labelKey: 'seed.stepResults' },
];

/** Threshold below which wizard auto-advances past Configure step. */
const AUTO_ADVANCE_THRESHOLD = 5;

/** Props for {@link SeedGenerateFlow}. */
export interface SeedGenerateFlowProps {
  /**
   * Whether the Seed page shows the wizard. Once opened it stays mounted,
   * hidden, while the page shows another way to seed: a run it started goes
   * on reporting to it, and the steps filled in are there on return.
   */
  active: boolean;
  /** Back to the Seed page's start. */
  onBack: () => void;
}

/**
 * The Seed wizard ("Generate data"): the org and objects, their fields, the
 * run and its results, a persona optional. A chunk of its own, loaded when it
 * is first opened: the Seed page parsed it, the CSV import and the clone
 * flow before it could show its gallery.
 */
export const SeedGenerateFlow: React.FC<SeedGenerateFlowProps> = ({ active, onBack }) => {
  const { t, i18n } = useTranslation();
  const state = useSeedWizardState(t);
  /** Tracks whether the configure step was auto-skipped (for the "Customize" banner). */
  const [configSkipped, setConfigSkipped] = useState(false);
  const prevStepRef = useRef(state.currentStep);
  const setSelectedPersona = useSeedWizardStore((s) => s.setSelectedPersona);
  const setCurrentStep = state.setCurrentStep;
  const sendMessage = useSendMessage();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  // What the org runs as the wizard's records are created, read on its
  // Execute step before the run; past the emails the org has left, the run waits.
  const onExecuteStep = active && state.currentStep === 2 && !state.executionResult;
  const wizardAutomation = useSeedAutomation(
    onExecuteStep ? state.selectedOrgId : '',
    onExecuteStep ? state.selectedObjects : [],
  );
  const wizardRecords = Object.fromEntries(
    state.objectProgress.map((object) => [object.objectApiName, object.total]),
  );
  const wizardRefused = onExecuteStep && refusedForEmails(wizardAutomation, wizardRecords);
  /** Whether the persona choice of the wizard is unfolded. */
  const [personaOpen, setPersonaOpen] = useState(false);

  /**
   * A persona picked in the wizard: its patterns fill the field rules of the
   * objects described, and of those described after. Optional, and chosen in
   * the wizard itself: it was a fork of its own before the wizard.
   */
  const handlePersonaSelected = useCallback(
    (persona: PersonaMsg) => {
      setSelectedPersona(persona);
      setPersonaOpen(false);
    },
    [setSelectedPersona],
  );

  /**
   * Custom step change handler that implements adaptive auto-advance.
   * When moving from Select (0) to Configure (1), if there are fewer than
   * AUTO_ADVANCE_THRESHOLD objects, skip Configure and go directly to Execute (2).
   * The selected-object count is read from the store at call time so this
   * callback stays memoised across wizard state changes.
   */
  const handleStepChange = useCallback(
    (nextStep: number) => {
      const movingForwardFromSelect = prevStepRef.current === 0 && nextStep === 1;
      const selectedCount = useSeedWizardStore.getState().selectedObjects.length;
      if (movingForwardFromSelect && selectedCount < AUTO_ADVANCE_THRESHOLD) {
        setConfigSkipped(true);
        setCurrentStep(2);
      } else {
        if (nextStep === 1) {
          setConfigSkipped(false);
        }
        setCurrentStep(nextStep);
      }
      prevStepRef.current = nextStep;
    },
    [setCurrentStep],
  );

  /** Customize link on the Execute step: back to Configure, clear the skipped flag. */
  const handleCustomize = useCallback(() => {
    setConfigSkipped(false);
    setCurrentStep(1);
  }, [setCurrentStep]);

  /** "Seed again" on the Results step: restart at the Select step. */
  const handleSeedAgain = useCallback(() => {
    setCurrentStep(0);
  }, [setCurrentStep]);

  /**
   * Stop a running seed. `execution:abort` is the channel that reaches the
   * AbortController SeedOpsHandler registers in the BackgroundOperationRegistry.
   *
   * The target is this wizard's own run: its operationId is the id of the
   * seed:execute request it sent. Aiming at the latest `operation:progress`
   * event stopped whichever run had reported last.
   */
  const runOperationId = state.operationId;
  const handleConfirmCancelRun = useCallback(() => {
    setShowCancelConfirm(false);
    if (!runOperationId) return;
    sendMessage(
      buildMessage<{ operationId: string }>('execution:abort', { operationId: runOperationId }),
    );
  }, [runOperationId, sendMessage]);

  /** Cancel is only offered once the run has reported progress, i.e. is registered. */
  const canCancelRun = state.isRunning && !!runOperationId;

  const selectedPersona = state.selectedPersona;
  const wizardOrgName = state.selectedOrg
    ? state.selectedOrg.alias || state.selectedOrg.username
    : '';

  return (
    <div hidden={!active}>
      <div className="flex flex-col gap-(--sf-space-4)" data-testid="seed-generate-flow">
        {active && (
          <>
            <PageHeader
              title={t('seed.title')}
              subtitle={t(SEED_STEPS[state.currentStep].labelKey)}
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
              <ErrorBanner
                message={state.error}
                code={null}
                module="seed"
                onDismiss={() => state.setError(null)}
                data-testid="seed-error"
              />
            )}

            {/* Back to the start */}
            <button
              className="flex items-center gap-1 text-xs text-(--sf-text-link) hover:underline self-start"
              onClick={onBack}
              data-testid="back-to-modes"
            >
              <ArrowLeft className="w-3 h-3" />
              {t('seed.quickSeed.backToGallery')}
            </button>

            {state.currentStep === 0 && (
              <details
                open={personaOpen}
                onToggle={(e) => setPersonaOpen(e.currentTarget.open)}
                className="rounded-sm border border-(--sf-border) px-(--sf-space-3) py-(--sf-space-2)"
                data-testid="seed-persona-choice"
              >
                <summary className="cursor-pointer text-xs font-medium text-(--sf-text-primary)">
                  {selectedPersona
                    ? t('seed.persona.chosen', { name: personaName(selectedPersona, t, i18n) })
                    : t('seed.persona.optional')}
                </summary>
                {personaOpen && (
                  <div className="mt-(--sf-space-2)">
                    <PersonaGallery onPersonaSelected={handlePersonaSelected} />
                  </div>
                )}
              </details>
            )}
          </>
        )}

        <SeedWizard
          steps={SEED_STEPS}
          currentStep={state.currentStep}
          onStepChange={handleStepChange}
          canGoNext={state.canGoNext && !wizardRefused}
          isFinished={state.isFinished}
          onFinish={state.handleExecute}
          onCancel={canCancelRun ? () => setShowCancelConfirm(true) : undefined}
          cancelLabelKey="common.cancelRun"
        >
          {/* STEP 1: SELECT */}
          {state.currentStep === 0 && (
            <SeedSelectStep
              availableObjects={state.availableObjects}
              loadingObjects={state.loadingObjects}
              volumes={state.volumes}
              onChangeVolume={state.handleChangeVolume}
            />
          )}

          {/* STEP 2: CONFIGURE */}
          {state.currentStep === 1 && (
            <SeedConfigureStep
              fieldConfigs={state.fieldConfigs}
              onChangeRule={state.handleChangeFieldRule}
              onChangeConfig={state.handleChangeFieldConfig}
              volumes={state.volumes}
              onChangeBatchSize={state.handleChangeBatchSize}
            />
          )}

          {/* STEP 3: EXECUTE */}
          {state.currentStep === 2 && (
            <SeedExecuteStep
              isRunning={state.isRunning}
              objectProgress={state.objectProgress}
              overallPercent={state.overallPercent}
              elapsedMs={state.elapsedMs}
              configSkipped={configSkipped}
              onCustomize={handleCustomize}
              fieldsReady={state.fieldsReady}
              fieldsError={state.fieldsError}
              onRetryFields={state.retryFieldDescribes}
              fieldConfigs={state.fieldConfigs}
              volumes={state.volumes}
              automation={state.selectedOrgId ? wizardAutomation : undefined}
              orgName={wizardOrgName}
              records={wizardRecords}
            />
          )}

          {/* STEP 4: RESULTS */}
          {state.currentStep === 3 && (
            <SeedResultsStep
              executionResult={state.executionResult}
              template={state.lastTemplate}
              orgName={wizardOrgName}
              onSeedAgain={handleSeedAgain}
            />
          )}
        </SeedWizard>

        <DangerConfirm
          open={showCancelConfirm}
          onClose={() => setShowCancelConfirm(false)}
          onConfirm={handleConfirmCancelRun}
          title={t('common.cancelRun')}
          description={t('seed.cancelRunConfirm')}
          confirmText={t('common.cancel')}
        />
      </div>
    </div>
  );
};
