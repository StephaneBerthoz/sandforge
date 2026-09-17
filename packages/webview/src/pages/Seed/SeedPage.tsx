import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Upload, Copy, ArrowLeft, Users } from 'lucide-react';
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
import { Divider } from '../../components/ui/Divider';
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
import { GuidedFirstStepCard } from '../../components/ui/GuidedFirstStepCard';
import { CsvUploadWizard } from './CsvUpload/CsvUploadWizard';
import { CloneWizard } from './Clone/CloneWizard';
import { PersonaGallery } from './Persona/PersonaGallery';

/** Seed mode selection with AI sub-modes. */
type SeedMode = 'select' | 'ai' | 'ai-persona' | 'ai-scratch' | 'csv' | 'clone';

const SEED_STEPS: WizardStep[] = [
  { id: 'select', labelKey: 'seed.stepSelect' },
  { id: 'configure', labelKey: 'seed.stepConfigure' },
  { id: 'execute', labelKey: 'seed.stepExecute' },
  { id: 'results', labelKey: 'seed.stepResults' },
];

/** Threshold below which wizard auto-advances past Configure step. */
const AUTO_ADVANCE_THRESHOLD = 5;

/** Mode a Home recommendation opens on: clone wizard, quick-seed gallery, or the selector. */
function modeForIntent(intent: NavigationIntent | null): SeedMode {
  if (intent?.seedMode === 'clone') return 'clone';
  if (intent?.seedMode === 'quick-seed') return 'ai-scratch';
  return 'select';
}

/** Main Seed page -- mode selector + 4-step wizard with progressive disclosure. */
export const SeedPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  const state = useSeedWizardState(t);
  // Home's recommendation, read once on open: the page lands on the mode it
  // names instead of the selector, the clone wizard on its source org and the
  // template gallery on the org the confirmation named.
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

  const handleSelectTemplate = (
    template: SeedTemplate,
    customizedCounts: Record<string, number>,
  ) => {
    quickSeed.startQuickSeed(template, customizedCounts);
  };

  /** Handle persona selection from the PersonaGallery. Stores persona and switches to wizard. */
  const handlePersonaSelected = useCallback(
    (persona: PersonaMsg) => {
      setSelectedPersona(persona);
      setSeedMode('ai-scratch');
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
    if (seedMode === 'ai-persona') return t('seed.persona.title');
    if (quickSeed.phase !== 'idle') return t('seed.quickSeed.title');
    if (seedMode === 'ai-scratch') return t(SEED_STEPS[state.currentStep].labelKey);
    if (seedMode === 'ai') return t('seed.modeSelect.ai');
    return t('seed.modeSelect.title');
  };

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]"
      data-testid="seed-page"
    >
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

      {/* Back navigation button */}
      {seedMode !== 'select' && quickSeed.phase === 'idle' && (
        <button
          className="flex items-center gap-1 text-xs text-[var(--sf-text-link)] hover:underline self-start"
          onClick={() => {
            if (seedMode === 'ai-persona' || seedMode === 'ai-scratch') {
              setSeedMode('ai');
            } else {
              setSeedMode('select');
            }
          }}
          data-testid="back-to-modes"
        >
          <ArrowLeft className="w-3 h-3" />
          {seedMode === 'ai-persona' || seedMode === 'ai-scratch'
            ? t('seed.persona.backToFork')
            : t('seed.modeSelect.backToModes')}
        </button>
      )}

      {/* ----- MODE SELECTOR ----- */}
      {seedMode === 'select' && quickSeed.phase === 'idle' && (
        <div className="grid grid-cols-3 gap-3" data-testid="seed-mode-selector">
          <Card hoverable onClick={() => setSeedMode('ai')} data-testid="mode-card-ai">
            <CardBody>
              <div className="flex flex-col items-center gap-2 py-4">
                <Sparkles className="w-8 h-8 text-[var(--sf-text-link)]" />
                <span className="text-sm font-semibold text-text-primary">
                  {t('seed.modeSelect.ai')}
                </span>
                <span className="text-xs text-text-secondary text-center">
                  {t('seed.modeSelect.aiDesc')}
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
      )}

      {/* ----- CSV UPLOAD MODE ----- */}
      {seedMode === 'csv' && <CsvUploadWizard onBack={() => setSeedMode('select')} />}

      {/* ----- CLONE MODE ----- */}
      {seedMode === 'clone' && (
        <CloneWizard
          onBack={() => setSeedMode('select')}
          initialSourceOrgId={recommendedCloneSource}
        />
      )}

      {/* ----- AI GENERATE MODE: Fork selection ----- */}
      {seedMode === 'ai' && quickSeed.phase === 'idle' && (
        <div className="grid grid-cols-2 gap-4" data-testid="ai-fork-selector">
          <Card hoverable onClick={() => setSeedMode('ai-persona')} data-testid="fork-card-persona">
            <CardBody>
              <div className="flex flex-col items-center gap-2 py-6">
                <Users className="w-8 h-8 text-[var(--sf-text-link)]" />
                <span className="text-sm font-semibold text-text-primary">
                  {t('seed.persona.forkPersonaTitle')}
                </span>
                <span className="text-xs text-text-secondary text-center">
                  {t('seed.persona.forkPersonaDesc')}
                </span>
              </div>
            </CardBody>
          </Card>

          <Card hoverable onClick={() => setSeedMode('ai-scratch')} data-testid="fork-card-scratch">
            <CardBody>
              <div className="flex flex-col items-center gap-2 py-6">
                <Sparkles className="w-8 h-8 text-[var(--sf-text-link)]" />
                <span className="text-sm font-semibold text-text-primary">
                  {t('seed.persona.forkScratchTitle')}
                </span>
                <span className="text-xs text-text-secondary text-center">
                  {t('seed.persona.forkScratchDesc')}
                </span>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* ----- AI PERSONA MODE ----- */}
      {seedMode === 'ai-persona' && <PersonaGallery onPersonaSelected={handlePersonaSelected} />}

      {/* ----- AI SCRATCH MODE (existing wizard behavior) ----- */}
      {seedMode === 'ai-scratch' && (
        <>
          {/* QUICK SEED FLOW (replaces gallery + wizard when active) */}
          {quickSeed.phase !== 'idle' ? (
            <QuickSeedFlow quickSeed={quickSeed} orgs={orgs} />
          ) : (
            <>
              {/* GUIDED FIRST STEP (visible on step 0, idle) */}
              {state.currentStep === 0 && (
                <GuidedFirstStepCard
                  variant="seed"
                  icon="database"
                  titleKey="onboarding.seedFirstStepTitle"
                  descKey="onboarding.seedFirstStepDesc"
                  actionKey="onboarding.startQuickSeed"
                  onAction={() => {
                    /* Gallery is right below */
                  }}
                />
              )}

              {/* QUICK SEED GALLERY (visible on step 0) */}
              {state.currentStep === 0 && (
                <>
                  <TemplateGallery onSelectTemplate={handleSelectTemplate} />
                  <Divider label={t('seed.gallery.orCustomize')} />
                </>
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
                    hasPiiWarnings={state.hasPiiWarnings}
                    piiResults={state.piiResults}
                    nl2soqlQuery={state.nl2soqlQuery}
                    onNl2soqlQueryChange={state.setNl2soqlQuery}
                    onNl2soqlSubmit={state.handleNl2soql}
                    nl2soql={state.nl2soql}
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
                    piiLoading={state.piiLoading}
                    hasPiiWarnings={state.hasPiiWarnings}
                    piiResults={state.piiResults}
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
                  />
                )}

                {/* STEP 4: RESULTS */}
                {state.currentStep === 3 && (
                  <SeedResultsStep
                    executionResult={state.executionResult}
                    template={state.lastTemplate}
                    onSeedAgain={handleSeedAgain}
                  />
                )}
              </SeedWizard>
            </>
          )}
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
