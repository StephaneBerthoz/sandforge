import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
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
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { PipelineCanvas } from './PipelineCanvas';
import { StepPalette } from './StepPalette';
import { StepConfigPanel } from './StepConfigPanel';
import { PipelineExecutionView } from './PipelineExecutionView';
import { TriggerConfigPanel } from './TriggerConfigPanel';
import { SchedulerCalendar } from './SchedulerCalendar';
import { PipelineHistoryView } from './PipelineHistoryView';
import { useAutomationPageData } from './useAutomationPageData';

/** Main Automation page — wired to extension via bridge hooks. */
export const AutomationPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);

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
    historyEntries,
    executionData,
    savingPipeline,
    marketplaceLoading,
    marketplaceError,
    marketplaceTemplates,
    scheduledPipelines,
    pipelineGen,
    stepCount,
    triggerCount,
    historyCount,
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
    handleSavePipeline,
    handleLoadPipeline,
    handleInstallTemplate,
    handleAddStep,
    handleRemoveStep,
    handleUpdateStep,
    handleAddTrigger,
    handleRemoveTrigger,
    handleToggleTrigger,
    handleUpdateCron,
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
    <motion.div
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
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* KPI overview row */}
      <motion.div variants={staggerContainer} initial="hidden" animate="visible" data-testid="automation-kpi-row">
        <BentoGrid columns={3} gap="md">
          <motion.div variants={slideUp}>
            <KPICard
              icon="project"
              label={t('automation.stepsCount')}
              value={stepCount}
              variant="default"
            />
          </motion.div>
          <motion.div variants={slideUp}>
            <KPICard
              icon="zap"
              label={t('automation.triggersCount')}
              value={triggerCount}
              variant="default"
            />
          </motion.div>
          <motion.div variants={slideUp}>
            <KPICard
              icon="history"
              label={t('automation.historyRuns')}
              value={historyCount}
              variant="default"
            />
          </motion.div>
        </BentoGrid>
      </motion.div>

      <PageTabs tabs={AUTOMATION_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <BentoTile className="p-0">
        <div className="p-4" data-testid="automation-content">
          {activeTab === 'canvas' && (
            <div className="flex flex-col gap-[var(--sf-space-4)]">
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
                    <PipelineExecutionView execution={executionData} />
                  ) : (
                    <PipelineCanvas
                      steps={pipeline?.steps}
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
              onAddTrigger={handleAddTrigger}
              onRemoveTrigger={handleRemoveTrigger}
              onToggleTrigger={handleToggleTrigger}
              onUpdateCron={handleUpdateCron}
            />
          )}

          {activeTab === 'scheduler' && (
            <SchedulerCalendar scheduled={scheduledPipelines} />
          )}

          {activeTab === 'history' && (
            <PipelineHistoryView entries={historyEntries} />
          )}

          {activeTab === 'marketplace' && (
            <div data-testid="marketplace-content" className="flex flex-col gap-[var(--sf-space-3)]">
              <h2 className="text-sm font-semibold text-text-primary">
                {t('automation.marketplace')}
              </h2>
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
                  {marketplaceTemplates.map((tpl) => (
                    <div
                      key={tpl.id}
                      className="p-[var(--sf-space-3)] rounded-xl border border-subtle bg-surface-2"
                      data-testid={`marketplace-template-${tpl.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-text-primary">
                          {tpl.name}
                        </span>
                        <Badge variant="default">{tpl.category}</Badge>
                      </div>
                      <p className="text-xs text-text-secondary mt-1">
                        {tpl.description}
                      </p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-xs text-text-muted">
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
                  ))}
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

      {/* Generate pipeline prompt dialog */}
      {showGenPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowGenPrompt(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-[400px] rounded-xl border border-subtle bg-surface-1 p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              {t('automation.generatePipeline')}
            </h3>
            <input
              className="w-full rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-active"
              placeholder={t('automation.generatePipelinePrompt')}
              value={genDescription}
              onChange={(e) => setGenDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleGenSubmit(); }}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="secondary" size="sm" onClick={() => setShowGenPrompt(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={handleGenSubmit} disabled={!genDescription.trim()}>
                {t('automation.generatePipeline')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};
