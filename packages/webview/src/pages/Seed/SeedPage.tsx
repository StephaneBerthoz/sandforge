import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Upload, Copy, ArrowLeft } from 'lucide-react';
import type { SeedTemplate, PersonaMsg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import type { NavigationIntent } from '../../stores/useAppStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { PageHeader } from '../../components/ui/PageHeader';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { Card, CardBody } from '../../components/ui/Card';
import { SeedWizard } from './SeedWizard';
import type { WizardStep } from './SeedWizard';
import { SeedSelectStep } from './SeedSelectStep';
import { SeedConfigureStep } from './SeedConfigureStep';
import { SeedExecuteStep } from './SeedExecuteStep';
import { SeedResultsStep } from './SeedResultsStep';
import { TemplateGallery } from './TemplateGallery';
import { QuickSeedFlow } from './QuickSeedFlow';
import { useSeedWizardState } from './useSeedWizardState';
import { useQuickSeed } from './useQuickSeed';
import { CsvUploadWizard } from './CsvUpload/CsvUploadWizard';
import { CloneWizard } from './Clone/CloneWizard';
import { PersonaGallery } from './Persona/PersonaGallery';
import { SeedRunHistory } from './SeedRunHistory';

/**
 * What the Seed page shows: its start — the template gallery, the other ways
 * to seed under it, and the seeds kept — or one of those other ways.
 */
type SeedMode = 'start' | 'generate' | 'csv' | 'clone';

const SEED_STEPS: WizardStep[] = [
  { id: 'select', labelKey: 'seed.stepSelect' },
  { id: 'configure', labelKey: 'seed.stepConfigure' },
  { id: 'execute', labelKey: 'seed.stepExecute' },
  { id: 'results', labelKey: 'seed.stepResults' },
];

/** Threshold below which wizard auto-advances past Configure step. */
const AUTO_ADVANCE_THRESHOLD = 5;

/**
 * Mode a Home recommendation opens on: the clone wizard, or the start, whose
 * gallery a quick-seed recommendation names and which every other way in
 * opens on too.
 */
function modeForIntent(intent: NavigationIntent | null): SeedMode {
  return intent?.seedMode === 'clone' ? 'clone' : 'start';
}

/**
 * Main Seed page. It opens on the template gallery, the one-click way to fill
 * an empty org, with the other ways to seed listed under it.
 *
 * The gallery used to be reached through "AI Generate" then "Start from
 * Scratch", two labels that point away from a template that needs no AI and
 * no field rule, and its "Browse Templates" button did nothing.
 */
export const SeedPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  const state = useSeedWizardState(t);
  // Home's recommendation, read once on open: the page lands on the mode it
  // names, the clone wizard on its source org and the template gallery on the
  // org the confirmation named.
  const [intent] = useState<NavigationIntent | null>(() => {
    const pending = useAppStore.getState().navigationIntent;
    return pending?.route === 'seed' ? pending : null;
  });
  const quickSeed = useQuickSeed({
    initialOrgId: intent?.seedMode === 'quick-seed' ? intent.targetOrgId : undefined,
  });
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  useEffect(() => {
    if (intent) clearNavigationIntent();
  }, [intent, clearNavigationIntent]);
  const [seedMode, setSeedMode] = useState<SeedMode>(() => modeForIntent(intent));
  /** Recommended clone source; dropped once the user leaves clone mode. */
  const [recommendedCloneSource, setRecommendedCloneSource] = useState(
    intent?.seedMode === 'clone' ? intent.sourceOrgId : undefined,
  );
  useEffect(() => {
    if (seedMode !== 'clone') setRecommendedCloneSource(undefined);
  }, [seedMode]);
  /** Tracks whether the configure step was auto-skipped (for the "Customize" banner). */
  const [configSkipped, setConfigSkipped] = useState(false);
  const prevStepRef = useRef(state.currentStep);
  const setSelectedPersona = useSeedWizardStore((s) => s.setSelectedPersona);
  const setCurrentStep = state.setCurrentStep;
  const sendMessage = useSendMessage();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  /** Whether the persona choice of the wizard is unfolded. */
  const [personaOpen, setPersonaOpen] = useState(false);

  const startQuickSeed = quickSeed.startQuickSeed;
  const handleSelectTemplate = useCallback(
    (template: SeedTemplate) => {
      startQuickSeed(template);
    },
    [startQuickSeed],
  );

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

  if (orgs.length === 0) {
    return (
      <EmptyState
        module="seed"
        title={t('seed.emptyState.title')}
        description={t('seed.emptyState.description')}
        steps={[
          t('emptyState.connectViaSfdx'),
          t('seed.emptyState.step2'),
          t('seed.emptyState.step3'),
          t('seed.emptyState.step4'),
        ]}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  /* Determine page subtitle based on mode */
  const getPageSubtitle = (): string => {
    if (seedMode === 'csv') return t('seed.modeSelect.csv');
    if (seedMode === 'clone') return t('seed.modeSelect.clone');
    if (quickSeed.phase !== 'idle') return t('seed.quickSeed.title');
    if (seedMode === 'generate') return t(SEED_STEPS[state.currentStep].labelKey);
    return t('seed.start.subtitle');
  };

  const selectedPersona = state.selectedPersona;
  const wizardOrgName = state.selectedOrg
    ? state.selectedOrg.alias || state.selectedOrg.username
    : '';

  return (
    <div className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)" data-testid="seed-page">
      <PageHeader
        title={t('seed.title')}
        subtitle={getPageSubtitle()}
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
          onDismiss={() => state.setError(null)}
          data-testid="seed-error"
        />
      )}

      {/* Back to the start, from another way to seed */}
      {seedMode !== 'start' && (
        <button
          className="flex items-center gap-1 text-xs text-(--sf-text-link) hover:underline self-start"
          onClick={() => setSeedMode('start')}
          data-testid="back-to-modes"
        >
          <ArrowLeft className="w-3 h-3" />
          {t('seed.quickSeed.backToGallery')}
        </button>
      )}

      {/* ----- START: the gallery, a template's run, the other ways ----- */}
      {seedMode === 'start' &&
        (quickSeed.phase !== 'idle' ? (
          <QuickSeedFlow quickSeed={quickSeed} orgs={orgs} />
        ) : (
          <>
            <TemplateGallery onSelectTemplate={handleSelectTemplate} />

            <section className="flex flex-col gap-(--sf-space-2)" data-testid="seed-other-ways">
              <h2 className="text-sm font-semibold text-(--sf-text-primary)">
                {t('seed.start.otherWays')}
              </h2>
              <div className="grid grid-cols-3 gap-3" data-testid="seed-mode-selector">
                <Card
                  hoverable
                  onClick={() => setSeedMode('generate')}
                  data-testid="mode-card-generate"
                >
                  <CardBody>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Sparkles className="w-8 h-8 text-(--sf-text-link)" />
                      <span className="text-sm font-semibold text-text-primary">
                        {t('seed.modeSelect.generate')}
                      </span>
                      <span className="text-xs text-text-secondary text-center">
                        {t('seed.modeSelect.generateDesc')}
                      </span>
                    </div>
                  </CardBody>
                </Card>

                <Card hoverable onClick={() => setSeedMode('csv')} data-testid="mode-card-csv">
                  <CardBody>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Upload className="w-8 h-8 text-hue-green" />
                      <span className="text-sm font-semibold text-text-primary">
                        {t('seed.modeSelect.csv')}
                      </span>
                      <span className="text-xs text-text-secondary text-center">
                        {t('seed.modeSelect.csvDesc')}
                      </span>
                    </div>
                  </CardBody>
                </Card>

                <Card hoverable onClick={() => setSeedMode('clone')} data-testid="mode-card-clone">
                  <CardBody>
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Copy className="w-8 h-8 text-hue-amber" />
                      <span className="text-sm font-semibold text-text-primary">
                        {t('seed.modeSelect.clone')}
                      </span>
                      <span className="text-xs text-text-secondary text-center">
                        {t('seed.modeSelect.cloneDesc')}
                      </span>
                    </div>
                  </CardBody>
                </Card>
              </div>
            </section>

            {/* The seeds kept, which a reload left removable */}
            <SeedRunHistory />
          </>
        ))}

      {/* ----- CSV UPLOAD MODE ----- */}
      {seedMode === 'csv' && <CsvUploadWizard onBack={() => setSeedMode('start')} />}

      {/* ----- CLONE MODE ----- */}
      {seedMode === 'clone' && (
        <CloneWizard
          onBack={() => setSeedMode('start')}
          initialSourceOrgId={recommendedCloneSource}
        />
      )}

      {/* ----- GENERATE: the wizard, a persona optional ----- */}
      {seedMode === 'generate' && (
        <>
          {state.currentStep === 0 && (
            <details
              open={personaOpen}
              onToggle={(e) => setPersonaOpen(e.currentTarget.open)}
              className="rounded-sm border border-(--sf-border) px-(--sf-space-3) py-(--sf-space-2)"
              data-testid="seed-persona-choice"
            >
              <summary className="cursor-pointer text-xs font-medium text-(--sf-text-primary)">
                {selectedPersona
                  ? t('seed.persona.chosen', { name: selectedPersona.name })
                  : t('seed.persona.optional')}
              </summary>
              {personaOpen && (
                <div className="mt-(--sf-space-2)">
                  <PersonaGallery onPersonaSelected={handlePersonaSelected} />
                </div>
              )}
            </details>
          )}

          <SeedWizard
            steps={SEED_STEPS}
            currentStep={state.currentStep}
            onStepChange={handleStepChange}
            canGoNext={state.canGoNext}
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
        </>
      )}

      <DangerConfirm
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={handleConfirmCancelRun}
        title={t('common.cancelRun')}
        description={t('seed.cancelRunConfirm')}
        confirmText={t('common.cancel')}
      />
    </div>
  );
};
