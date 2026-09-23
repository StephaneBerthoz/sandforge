import React, { useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { m } from 'framer-motion';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import type { PageTab } from '../../components/ui/PageTabs';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { Badge } from '../../components/ui/Badge';
import { ComingSoon } from '../../components/ui/ComingSoon';
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { PipelineCanvas } from './PipelineCanvas';
import { StepPalette } from './StepPalette';
import { StepConfigPanel } from './StepConfigPanel';
import { PipelineExecutionView } from './PipelineExecutionView';
import { TriggerConfigPanel } from './TriggerConfigPanel';
import { SchedulerCalendar } from './SchedulerCalendar';
import { PipelineHistoryView } from './PipelineHistoryView';
import { useAutomationPageData } from './useAutomationPageData';
import { blockedSteps, typeBlocker } from './stepRunnability';

/** Main Automation page — wired to extension via bridge hooks. */
export const AutomationPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const orgIds = useMemo(() => new Set(orgs.map((org) => org.id)), [orgs]);
  const blockedNoticeId = useId();

  /** A step type in the reader's language; a type this page does not know stays as it is. */
  const stepTypeLabel = (type: string): string =>
    i18n.exists(`automation.stepTypes.${type}`) ? t(`automation.stepTypes.${type}`) : type;

  const AUTOMATION_TABS: PageTab[] = [
    { id: 'canvas', label: t('automation.canvas'), icon: 'project' },
    { id: 'triggers', label: t('automation.triggers'), icon: 'zap' },
    { id: 'scheduler', label: t('automation.scheduler'), icon: 'calendar' },
    { id: 'history', label: t('automation.history'), icon: 'history' },
    { id: 'marketplace', label: t('automation.marketplace'), icon: 'package' },
  ];

  const {
    pipeline,
    error,
    clearError,
    isRunning,
    pipelinesLoading,
    savedPipelines,
    triggerStatuses,
    savedTriggers,
    sandboxes,
    pipelineSchedules,
    historyEntries,
    executionData,
    savingPipeline,
    marketplaceLoading,
    marketplaceError,
    marketplaceTemplates,
    pipelineGen,
    stepCount,
    triggerCount,
    historyCount,
    runBlockers,
    activeTab,
    setActiveTab,
    selectedStepId,
    setSelectedStepId,
    showGenPrompt,
    setShowGenPrompt,
    genDescription,
    setGenDescription,
    handleCreatePipeline,
    handleRunPipeline,
    handleCancelRun,
    handleSavePipeline,
    handleLoadPipeline,
    handleInstallTemplate,
    handleAddStep,
    handleRemoveStep,
    handleUpdateStep,
    handleAddTrigger,
    handleRemoveTrigger,
    handleToggleTrigger,
    handleUpdateTriggerConfig,
    handleGeneratePipeline,
    handleGenSubmit,
  } = useAutomationPageData();

  const navigate = useAppStore((s) => s.navigate);

  if (orgs.length === 0) {
    return (
      <EmptyState
        module="automation"
        title={t('automation.emptyState.title')}
        description={t('automation.emptyState.description')}
        actionLabel={t('automation.emptyState.cta')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  const subtitle = pipeline
    ? `${pipeline.name} v${pipeline.version} \u00b7 ${stepCount} ${t('automation.steps')}`
    : t('automation.subtitle');

  return (
    <m.div
      className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]"
      data-testid="automation-page"
      variants={fadeIn}
      initial="hidden"
      animate="visible"
    >
      <PageHeader
        title={t('automation.title')}
        subtitle={subtitle}
        icon="circuit-board"
        actions={
          <div className="flex items-center gap-[var(--sf-space-2)]">
            {!pipeline && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreatePipeline}
                data-testid="create-pipeline-btn"
              >
                {t('automation.createPipeline')}
              </Button>
            )}
            {pipeline && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSavePipeline}
                  loading={savingPipeline}
                  data-testid="save-pipeline-btn"
                >
                  {savingPipeline ? t('automation.saving') : t('automation.savePipeline')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleRunPipeline}
                  loading={isRunning}
                  disabled={runBlockers.length > 0}
                  aria-describedby={runBlockers.length > 0 ? blockedNoticeId : undefined}
                  data-testid="run-pipeline-btn"
                >
                  {isRunning ? t('automation.running') : t('automation.run')}
                </Button>
              </>
            )}
          </div>
        }
      />

      {error && (
        <ErrorBanner message={error} onDismiss={clearError} data-testid="automation-error" />
      )}

      {/* Outside the tabs, next to the Run button it disables: a pipeline
          installed from the Marketplace or drafted by the AI lands here with
          steps the extension refuses, and the reader has to learn which, and
          why, whichever tab is open. */}
      {pipeline && runBlockers.length > 0 && (
        <div
          id={blockedNoticeId}
          role="note"
          className="flex flex-col gap-1 rounded-lg border border-dashed border-subtle bg-surface-1 px-3 py-2"
          data-testid="pipeline-blocked"
        >
          <p className="text-xs font-semibold text-text-primary">
            {t('automation.runnability.pipelineBlocked')}
          </p>
          <ul className="flex flex-col gap-0.5">
            {runBlockers.map((blocked) => (
              <li
                key={blocked.stepId}
                className="text-xs text-text-secondary"
                data-testid={`pipeline-blocked-${blocked.stepId}`}
              >
                <span className="font-medium text-text-primary">{blocked.stepName}</span> (
                {stepTypeLabel(blocked.stepType)}) —{' '}
                {t(`automation.runnability.${blocked.blocker}`)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Loading skeleton while pipelines query loads */}
      {pipelinesLoading && (
        <div className="flex gap-3" data-testid="automation-loading">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex-1">
              <Skeleton variant="rect" height="88px" />
            </div>
          ))}
        </div>
      )}

      {/* Saved pipelines list — shown when no pipeline is active */}
      {!pipeline && !pipelinesLoading && savedPipelines.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="saved-pipelines">
          <h3 className="text-xs font-semibold text-text-primary">
            {t('automation.savedPipelines')}
          </h3>
          <div className="grid gap-2">
            {savedPipelines.map((p) => (
              <button
                key={p.id}
                onClick={() => handleLoadPipeline(p)}
                className="flex items-center justify-between px-3 py-2 rounded-lg border border-subtle bg-surface-2 hover:border-active transition-colors text-left cursor-pointer"
                data-testid={`saved-pipeline-${p.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{p.name}</span>
                  <Badge variant="default">v{p.version}</Badge>
                  <span className="text-xs text-text-secondary">
                    {p.steps.length} {t('automation.steps')}
                  </span>
                  {blockedSteps(p.steps, orgIds).length > 0 && (
                    <Badge variant="warning" data-testid={`saved-pipeline-blocked-${p.id}`}>
                      {t('automation.runnability.cannotRun')}
                    </Badge>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* KPI overview row */}
      <m.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        data-testid="automation-kpi-row"
      >
        <BentoGrid columns={3} gap="md">
          <m.div variants={slideUp}>
            <KPICard
              icon="project"
              label={t('automation.stepsCount')}
              value={stepCount}
              variant="default"
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="zap"
              label={t('automation.triggersCount')}
              value={triggerCount}
              variant="default"
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="history"
              label={t('automation.historyRuns')}
              value={historyCount}
              variant="default"
            />
          </m.div>
        </BentoGrid>
      </m.div>

      <PageTabs tabs={AUTOMATION_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <BentoTile className="p-0">
        <div className="p-4" data-testid="automation-content">
          {activeTab === 'canvas' && (
            <div className="flex flex-col gap-[var(--sf-space-4)]">
              {/* The steps that write to an org, and the control steps not
                  built yet, are refused before a pipeline's first step. Say so
                  before anyone builds one. */}
              <ComingSoon
                variant="banner"
                data-testid="automation-steps-soon"
                description={t('automation.soon.steps')}
              />
              <div className="flex items-center gap-[var(--sf-space-2)]">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleGeneratePipeline}
                  loading={pipelineGen.loading}
                  data-testid="generate-pipeline-btn"
                >
                  {t('automation.generatePipeline')}
                </Button>
              </div>
              <div className="flex gap-[var(--sf-space-4)]">
                <div className="flex-1">
                  {isRunning ? (
                    <PipelineExecutionView execution={executionData} onCancel={handleCancelRun} />
                  ) : (
                    <PipelineCanvas
                      steps={pipeline?.steps}
                      orgIds={orgIds}
                      selectedStepId={selectedStepId}
                      onSelectStep={(id) => {
                        setSelectedStepId(id);
                      }}
                      onRemoveStep={handleRemoveStep}
                    />
                  )}
                </div>
                <div className="w-48 flex flex-col gap-3">
                  <StepPalette onAddStep={handleAddStep} />
                  <StepConfigPanel
                    step={pipeline?.steps.find((s) => s.id === selectedStepId)}
                    onUpdate={handleUpdateStep}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'triggers' && (
            <TriggerConfigPanel
              triggers={pipeline?.triggers}
              statuses={triggerStatuses}
              savedTriggers={savedTriggers}
              sandboxes={sandboxes}
              pipelineBlocked={runBlockers.length > 0}
              onAddTrigger={handleAddTrigger}
              onRemoveTrigger={handleRemoveTrigger}
              onToggleTrigger={handleToggleTrigger}
              onUpdateTriggerConfig={handleUpdateTriggerConfig}
            />
          )}

          {activeTab === 'scheduler' && <SchedulerCalendar pipelineSchedules={pipelineSchedules} />}

          {activeTab === 'history' && <PipelineHistoryView entries={historyEntries} />}

          {activeTab === 'marketplace' && (
            <div
              data-testid="marketplace-content"
              className="flex flex-col gap-[var(--sf-space-3)]"
            >
              <h2 className="text-sm font-semibold text-text-primary">
                {t('automation.marketplace')}
              </h2>
              {/* A template card is read on its own, and its description
                  promises work its steps do not do: the steps only show up on
                  the canvas after Install. Say it here, before the button, and
                  on each card whose steps cannot run. */}
              <ComingSoon
                variant="banner"
                data-testid="automation-marketplace-steps-soon"
                description={t('automation.soon.steps')}
              />
              {marketplaceLoading && (
                <div className="flex gap-3" data-testid="marketplace-loading">
                  {Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="flex-1">
                      <Skeleton variant="rect" height="120px" />
                    </div>
                  ))}
                </div>
              )}
              {marketplaceError && (
                <ErrorBanner message={marketplaceError} data-testid="marketplace-error" />
              )}
              {marketplaceTemplates.length > 0 ? (
                <div className="grid gap-[var(--sf-space-2)]">
                  {marketplaceTemplates.map((tpl) => {
                    const blockedTypes = [
                      ...new Set(
                        (tpl.stepTypes ?? []).filter((type) => typeBlocker(type) !== undefined),
                      ),
                    ];
                    return (
                      <div
                        key={tpl.id}
                        className="p-[var(--sf-space-3)] rounded-xl border border-subtle bg-surface-2"
                        data-testid={`marketplace-template-${tpl.id}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-text-primary">{tpl.name}</span>
                          <Badge variant="default">{tpl.category}</Badge>
                        </div>
                        <p className="text-xs text-text-secondary mt-1">{tpl.description}</p>
                        {blockedTypes.length > 0 && (
                          <p
                            className="flex flex-wrap items-center gap-1 text-xs text-text-secondary mt-1"
                            data-testid={`marketplace-template-blocked-${tpl.id}`}
                          >
                            <Badge variant="warning">{t('automation.runnability.cannotRun')}</Badge>
                            <span>
                              {t('automation.runnability.templateBlocked', {
                                types: blockedTypes.map(stepTypeLabel).join(', '),
                              })}
                            </span>
                          </p>
                        )}
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-xs text-text-secondary">
                            {t('automation.marketplaceAuthor')}: {tpl.author}
                          </span>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleInstallTemplate(tpl)}
                            data-testid={`install-template-${tpl.id}`}
                          >
                            {t('automation.installTemplate')}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                !marketplaceLoading && (
                  <EmptyState
                    icon="package"
                    title={t('automation.noMarketplaceTemplates')}
                    description={t('automation.noMarketplaceTemplatesDesc')}
                  />
                )
              )}
            </div>
          )}
        </div>
      </BentoTile>

      {showGenPrompt && (
        <GeneratePipelineDialog
          description={genDescription}
          onDescriptionChange={setGenDescription}
          onSubmit={handleGenSubmit}
          onClose={() => setShowGenPrompt(false)}
        />
      )}
    </m.div>
  );
};

/** Props for GeneratePipelineDialog. */
interface GeneratePipelineDialogProps {
  description: string;
  onDescriptionChange: (description: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

/**
 * Prompt dialog for generating a pipeline from a description. Its own
 * component so the focus trap is set up when the dialog opens, not when the
 * page mounts.
 */
const GeneratePipelineDialog: React.FC<GeneratePipelineDialogProps> = ({
  description,
  onDescriptionChange,
  onSubmit,
  onClose,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, onClose);

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- useFocusTrap above closes this on Escape; the backdrop click is the mouse shortcut for the same thing.
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- not an action: it stops a click inside the dialog from reaching the backdrop and closing it. There is nothing for a keyboard to do here. */}
      <div
        className="w-[400px] rounded-xl border border-subtle bg-surface-1 p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-sm font-semibold text-text-primary mb-3">
          {t('automation.generatePipeline')}
        </h3>
        <input
          className="w-full rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-active"
          placeholder={t('automation.generatePipelinePrompt')}
          aria-label={t('automation.generatePipelinePrompt')}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens on an explicit action and this is its only field; focus starts where the work is.
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={onSubmit} disabled={!description.trim()}>
            {t('automation.generatePipeline')}
          </Button>
        </div>
      </div>
    </div>
  );
};
