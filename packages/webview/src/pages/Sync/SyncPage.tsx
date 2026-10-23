import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncConflictStrategy, MappingType, FieldMapping } from '@sandforge/shared';
import { FILE_COPY_CEILING_MB, SYNC_FILES_MAX_RUN_MB } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { SkeletonTable } from '../../components/ui/SkeletonTable';
import { Select } from '../../components/ui/Select';
import { Badge } from '../../components/ui/Badge';
import { ProgressAnnouncer, ProgressBar } from '../../components/ui/ProgressBar';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { orgOptionLabel } from '../../utils/orgFormatters';
import { orgToFill } from '../../utils/orgToFill';
import { SyncWizard } from './SyncWizard';
import type { SyncWizardStep } from './SyncWizard';
import { FieldMappingCanvas } from './FieldMappingCanvas';
import { TransformBuilder } from './TransformBuilder';
import { ObjectSetEditor } from './ObjectSetEditor';
import { SyncTemplatePicker } from './SyncTemplatePicker';
import { SankeyFlow } from './SankeyFlow';
import type { SankeyNode, SankeyLink } from './SankeyFlow';
import { GrappeProgressPanel } from '../../components/GrappeProgressPanel';
import { useGrappeStore } from '../../stores/useGrappeStore';
import type { BadgeVariant } from '../../components/ui/Badge';
import { useSyncPageData, OFFERED_CONFLICT_STRATEGIES } from './useSyncPageData';
import type { ObjectSetEntry } from './ObjectSetEditor';
import { QuickSyncCard } from './QuickSync/QuickSyncCard';
import { QuickSyncFlow } from './QuickSync/QuickSyncFlow';
import { GuidedFirstStepCard } from '../../components/ui/GuidedFirstStepCard';
import { SyncHistoryPanel } from './SyncHistoryPanel';
import { useSyncHistoryMessages } from './useSyncHistoryMessages';
import { SyncSchedulePanel } from './syncPanels';
import { PartBoundary } from '../../components/ui/PartBoundary';
import { RealTimeSyncPanel } from './RealTimeSyncPanel';
import { ConflictListPanel } from './ConflictListPanel';
import { ConflictResolutionPanel } from './ConflictResolutionPanel';
import { useConflictStore } from '../../stores/useConflictStore';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import { SplitView } from '../../components/ui/SplitView';
import { Button } from '../../components/ui/Button';
import { SyncRunControls } from './SyncRunControls';
import { SyncSimulationResults } from './SyncSimulationResults';
import { SyncReviewObjects } from './SyncReviewObjects';
import { SyncAlreadyCopiedLine } from './SyncWriteCheck';
import { SyncDeltaLine } from './SyncDeltaLine';
import { SyncPricebookLine } from './SyncPricebookLine';
import { SyncFilesLine, SyncFilesSummary } from './SyncFilesLine';
import { SyncRunRemoval } from './syncRemovalParts';
import { RecordErrorGroups } from '../../components/ui/RecordErrorGroups';
import { handleTabListKeyDown } from '../../components/ui/tabListKeys';
import { ForgeCurrenciesResult } from '../Forge/ForgeCurrenciesResult';
import { PriceCurrenciesResult } from '../Forge/PriceCurrenciesResult';
import { ForgeContactPointsResult } from '../Forge/ForgeContactPointsResult';
import { SyncWrittenLines, hasWrittenLines } from './SyncWrittenLines';

/** Tab options for the Sync page. */
type SyncTab = 'sync' | 'history' | 'schedules' | 'realtime' | 'conflicts';

/**
 * The tabs the page offers. Real-Time streams the source org's change events
 * for the objects it publishes, and Conflicts lists the changes it held for a
 * decision: nothing else pushes to that list, since a Sync run resolves its
 * collisions by its strategy alone.
 */
const OFFERED_SYNC_TABS: readonly SyncTab[] = [
  'sync',
  'history',
  'schedules',
  'realtime',
  'conflicts',
];

/**
 * The rest of a toggle's hint, one click away: the sentence under the toggle
 * says what it does, and the screen reader reads that sentence alone on
 * focus. The hints ran to 770 characters at ten pixels, read in full on every
 * focus.
 */
const ToggleDetails: React.FC<{ testId: string; children: React.ReactNode }> = ({
  testId,
  children,
}) => {
  const { t } = useTranslation();
  return (
    <details className="text-xs text-text-secondary" data-testid={testId}>
      <summary className="cursor-pointer text-text-primary">{t('common.details')}</summary>
      <p className="mt-1">{children}</p>
    </details>
  );
};

const SYNC_STEPS: SyncWizardStep[] = [
  { id: 'select-and-configure', labelKey: 'sync.selectAndConfigure' },
  // Both pass with nothing set: two orgs of the same schema need neither.
  { id: 'field-mapping', labelKey: 'sync.fieldMapping', optional: true },
  { id: 'transforms', labelKey: 'sync.transforms', optional: true },
  { id: 'review', labelKey: 'sync.review' },
  { id: 'execute', labelKey: 'sync.execute' },
  { id: 'results', labelKey: 'sync.results' },
];

const statusVariant: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** Build Sankey nodes from configured objects and field mappings. */
function buildSankeyNodes(entries: ObjectSetEntry[], fieldMappings: FieldMapping[]): SankeyNode[] {
  if (entries.length === 0 && fieldMappings.length === 0) return [];

  const sourceNames = new Set<string>();
  const targetNames = new Set<string>();

  for (const entry of entries) {
    sourceNames.add(entry.objectApiName);
    targetNames.add(entry.objectApiName);
  }

  for (const m of fieldMappings) {
    sourceNames.add(m.sourceField);
    targetNames.add(m.targetField);
  }

  const nodes: SankeyNode[] = [];
  for (const name of sourceNames) {
    nodes.push({ id: `src-${name}`, label: name, group: 'source' });
  }
  for (const name of targetNames) {
    nodes.push({ id: `tgt-${name}`, label: name, group: 'target' });
  }
  return nodes;
}

/** Build Sankey links from configured objects and field mappings. */
function buildSankeyLinks(entries: ObjectSetEntry[], fieldMappings: FieldMapping[]): SankeyLink[] {
  if (entries.length === 0 && fieldMappings.length === 0) return [];

  const links: SankeyLink[] = [];

  // One link per object being synced
  for (const entry of entries) {
    links.push({
      sourceId: `src-${entry.objectApiName}`,
      targetId: `tgt-${entry.objectApiName}`,
      value: entry.batchSize || 200,
    });
  }

  // One link per field mapping (thinner)
  for (const m of fieldMappings) {
    links.push({
      sourceId: `src-${m.sourceField}`,
      targetId: `tgt-${m.targetField}`,
      value: 50,
    });
  }

  return links;
}

/** Badge showing unresolved conflict count, hidden when zero. */
const ConflictCountBadge: React.FC = () => {
  const count = useConflictStore((s) => s.conflicts.filter((c) => !c.resolved).length);
  if (count === 0) return null;
  return (
    <Badge variant="warning" data-testid="conflict-count-badge">
      {count}
    </Badge>
  );
};

/** Conflicts tab content — master/detail SplitView layout. */
const ConflictsTabContent: React.FC = () => {
  const { t } = useTranslation();
  const selectedConflictId = useConflictStore((s) => s.selectedConflictId);
  const conflicts = useConflictStore((s) => s.conflicts);
  const selectedConflict = conflicts.find((c) => c.id === selectedConflictId);

  return (
    <SplitView
      ratio="60/40"
      left={<ConflictListPanel />}
      right={
        selectedConflict ? (
          // Keyed on the conflict id so selecting another conflict remounts the
          // panel instead of swapping the prop underneath its local state: the
          // per-field choices of one record can never stay armed on the next.
          <ConflictResolutionPanel key={selectedConflict.id} conflict={selectedConflict} />
        ) : (
          <div
            className="flex items-center justify-center h-full text-xs text-text-secondary"
            data-testid="conflict-placeholder"
          >
            {t('sync.conflictResolution.selectConflict')}
          </div>
        )
      }
    />
  );
};

/** Wrapper that only mounts GrappeProgressPanel when grappe is active. */
const SyncGrappePanel: React.FC = () => {
  const { active, operationId } = useGrappeStore();
  if (!active && !operationId) return null;
  return <GrappeProgressPanel announce={false} />;
};

/** Main Sync page — wired to extension via bridge hooks. */
export const SyncPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);
  const [quickSyncActive, setQuickSyncActive] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<SyncTab>('sync');
  const deltaHintId = React.useId();
  const deletesHintId = React.useId();
  const filesHintId = React.useId();
  const contactPointsHintId = React.useId();
  const heldRecordsHintId = React.useId();
  const filesNeedSaveId = React.useId();

  // Subscribed here rather than in SyncHistoryPanel: an export's save answer
  // arrives after the dialog closes, which the user may well do from another
  // tab, and the page outlives every tab of it.
  useSyncHistoryMessages();

  const {
    availableObjects,
    unwritableObjects,
    sourceFields,
    targetFields,
    result,
    simulation,
    isRunning,
    isSimulating,
    runOperationId,
    objectsLoading,
    fieldsLoading,
    error,
    clearError,
    piiWarnings,
    currentStep,
    setCurrentStep,
    sourceOrgId,
    targetOrgId,
    findsHeldRecords,
    mode,
    setMode,
    propagateDeletes,
    setPropagateDeletes,
    copyFiles,
    setCopyFiles,
    keepContactPoints,
    setKeepContactPoints,
    fileCaps,
    setFileCap,
    deltaBlockers,
    conflictStrategy,
    setConflictStrategy,
    strategyNotice,
    dismissStrategyNotice,
    objectEntries,
    mappedObject,
    setMappedObject,
    mappings,
    setMappings,
    transforms,
    handleSourceOrgChange,
    handleTargetOrgChange,
    handleAddObject,
    handleRemoveObject,
    handleObjectChange,
    handleAddMapping,
    handleRemoveMapping,
    handleMappingTypeChange,
    handleAddTransform,
    handleRemoveTransform,
    handleChangeTransformConfig,
    handleExecute,
    handleSimulate,
    handleSaveConfig,
    handleRunSavedConfig,
    savedRunLabel,
    savedRunStarting,
    configSaved,
    writeOrder,
    writeOrderLoading,
    writeOrderUnread,
    writeOrderEncrypted,
    filesNeedSave,
    handleApplyTemplate,
    canGoNext,
    isFinished,
    overallPercent,
    elapsedMs,
  } = useSyncPageData();

  const sourceOrg = orgs.find((o) => o.id === sourceOrgId);
  const targetOrg = orgs.find((o) => o.id === targetOrgId);

  if (orgs.length < 2) {
    // Sync copies between two orgs. With one, the empty state offered only to
    // connect another: Seed fills the one there is.
    const fill = orgs.length === 1 ? orgToFill(orgs, selectedOrgId) : undefined;
    return (
      <EmptyState
        module="sync"
        title={t('sync.emptyState.title')}
        description={t('sync.emptyState.description')}
        steps={[
          orgs.length === 1
            ? t('emptyState.connectSecondViaSfdx')
            : t('emptyState.connectTwoViaSfdx'),
          t('sync.emptyState.step2'),
          t('sync.emptyState.step3'),
          t('sync.emptyState.step4'),
        ]}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
        {...(fill
          ? {
              tourLabel: t('emptyState.onlyOneOrgSeed'),
              onTourClick: () => navigate('seed', { seedMode: 'quick-seed', targetOrgId: fill.id }),
            }
          : {})}
      />
    );
  }

  const orgOptions = orgs.map((org) => ({
    value: org.id,
    label: orgOptionLabel(org, t),
  }));
  // The saved configuration is named after the pair it runs between, which is
  // what the schedule picker shows; it is data, not a label to translate.
  const configName = `${sourceOrg?.alias || sourceOrg?.username || sourceOrgId} → ${
    targetOrg?.alias || targetOrg?.username || targetOrgId
  }`;
  const conflictOptions: { value: SyncConflictStrategy; label: string }[] =
    OFFERED_CONFLICT_STRATEGIES.map((value) => ({
      value,
      label: t(`sync.conflicts.${value}`),
    }));
  // Reading a saved configuration back starts its run: the wizard's buttons
  // are not offered meanwhile.
  const busy = isRunning || isSimulating || savedRunStarting;

  return (
    <div className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)" data-testid="sync-page">
      <PageHeader
        title={t('sync.title')}
        subtitle={t('sync.selectOrgsDesc')}
        icon="sync"
        actions={
          <div className="flex items-center gap-(--sf-space-2)">
            {sourceOrg && (
              <OrgBadge
                alias={sourceOrg.alias || sourceOrg.username}
                orgType={String(sourceOrg.orgType)}
                status={sourceOrg.status}
                instanceUrl={sourceOrg.instanceUrl}
              />
            )}
            {sourceOrg && targetOrg && (
              <span
                className="codicon codicon-arrow-right text-(--sf-text-secondary)"
                aria-hidden="true"
              />
            )}
            {targetOrg && (
              <OrgBadge
                alias={targetOrg.alias || targetOrg.username}
                orgType={String(targetOrg.orgType)}
                status={targetOrg.status}
                instanceUrl={targetOrg.instanceUrl}
              />
            )}
          </div>
        }
      />

      {error && (
        <ErrorBanner message={error} code={null} onDismiss={clearError} data-testid="sync-error" />
      )}

      {/* Tab navigation */}
      <div
        className="flex gap-0 border-b border-(--sf-border)"
        role="tablist"
        data-testid="sync-tabs"
      >
        {OFFERED_SYNC_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`sync-tab-${tab}`}
            aria-selected={activeTab === tab}
            // Only the selected tab's panel is drawn, so only it is named.
            aria-controls={activeTab === tab ? `sync-tabpanel-${tab}` : undefined}
            // One stop in the Tab order, the arrows between the tabs, as
            // every tab bar of the panel has them.
            tabIndex={activeTab === tab ? 0 : -1}
            onKeyDown={(event) =>
              handleTabListKeyDown(event, OFFERED_SYNC_TABS, activeTab, (id) =>
                setActiveTab(id as SyncTab),
              )
            }
            className={`text-xs px-4 py-2 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === tab
                ? 'border-(--sf-accent) text-text-primary font-semibold'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
            onClick={() => setActiveTab(tab)}
            data-testid={`tab-${tab}`}
          >
            {t(`sync.tabs.${tab}`)}
            {tab === 'conflicts' && <ConflictCountBadge />}
          </button>
        ))}
      </div>

      {/* The selected tab's content, named by its tab: the bar had the arrow
          keys of the tab pattern and no panel for its tabs to control. */}
      <div
        role="tabpanel"
        id={`sync-tabpanel-${activeTab}`}
        aria-labelledby={`sync-tab-${activeTab}`}
        className="flex flex-col gap-(--sf-space-4)"
        data-testid="sync-tabpanel"
      >
        {/* History tab */}
        {activeTab === 'history' && <SyncHistoryPanel />}

        {/* Schedules tab: the schedules, and the saved configurations, each of
          which runs from the execute step of the Sync tab, as the wizard's
          own run does. */}
        {activeTab === 'schedules' && (
          <PartBoundary data-testid="sync-schedules-failed">
            <Suspense fallback={<SkeletonTable rows={3} columns={5} />}>
              <SyncSchedulePanel
                onRunConfig={(configId, label) => {
                  setQuickSyncActive(false);
                  setActiveTab('sync');
                  handleRunSavedConfig(configId, label);
                }}
                runDisabled={busy}
              />
            </Suspense>
          </PartBoundary>
        )}

        {/* Conflicts tab */}
        {activeTab === 'conflicts' && <ConflictsTabContent />}

        {/* Real-time tab */}
        {activeTab === 'realtime' && (
          <RealTimeSyncPanel sourceOrgId={sourceOrgId} targetOrgId={targetOrgId} />
        )}

        {/* Sync tab (default) */}
        {activeTab === 'sync' && !quickSyncActive && currentStep === 0 && (
          <GuidedFirstStepCard
            variant="sync"
            icon="sync"
            titleKey="sync.firstStepTitle"
            descKey="sync.firstStepDesc"
            actionKey="sync.startQuickSync"
            onAction={() => setQuickSyncActive(true)}
          />
        )}

        {activeTab === 'sync' && !quickSyncActive && (
          <QuickSyncCard onStart={() => setQuickSyncActive(true)} />
        )}

        {activeTab === 'sync' && quickSyncActive && (
          <QuickSyncFlow
            onBack={() => setQuickSyncActive(false)}
            // The run's entry on the History tab: what it wrote, and its removal.
            onOpenHistory={(operationId) => {
              useSyncHistoryStore.getState().openRun(operationId);
              setActiveTab('history');
            }}
          />
        )}

        {activeTab === 'sync' && !quickSyncActive && (
          <SyncWizard
            steps={SYNC_STEPS}
            currentStep={currentStep}
            onStepChange={setCurrentStep}
            canGoNext={canGoNext()}
            isFinished={isFinished}
            canRevisitSteps={!busy}
          >
            {/* Step 0: Select orgs + Configure objects (merged) */}
            {currentStep === 0 && (
              <div className="flex flex-col gap-4" data-testid="sync-step-orgs">
                <p className="text-xs text-text-secondary">{t('sync.selectOrgsDesc')}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Select
                    label={t('sync.source')}
                    options={orgOptions}
                    value={sourceOrgId}
                    onChange={(e) => handleSourceOrgChange(e.target.value)}
                    placeholder={t('sync.source')}
                  />
                  <Select
                    label={t('sync.target')}
                    options={orgOptions}
                    value={targetOrgId}
                    onChange={(e) => handleTargetOrgChange(e.target.value)}
                    placeholder={t('sync.target')}
                  />
                </div>
                {/* Full or delta. The Mode dropdown offered "incremental",
                  "delta" and "cdc" while every run was a full sync; a delta
                  run now reads each object from its last good run, so it is
                  offered alone, with what it needs said beside it. */}
                <div
                  className="flex flex-col gap-(--sf-space-2) rounded-sm border border-(--sf-border) p-(--sf-space-2)"
                  data-testid="sync-delta-settings"
                >
                  <label className="flex items-start gap-2 text-xs text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mode === 'delta'}
                      onChange={(e) => setMode(e.target.checked ? 'delta' : 'full')}
                      aria-describedby={deltaHintId}
                      data-testid="sync-delta-toggle"
                    />
                    {t('sync.delta.toggle')}
                  </label>
                  <p id={deltaHintId} className="text-xs text-text-secondary">
                    {t('sync.delta.toggleHint')}
                  </p>
                  <ToggleDetails testId="sync-delta-details">
                    {t('sync.delta.toggleDetails')}
                  </ToggleDetails>
                  {/* Dimmed by colour, not opacity: a faded label falls below
                    AA on the light themes. */}
                  <label
                    className={`flex items-start gap-2 text-xs ${
                      mode === 'delta' ? 'text-text-primary cursor-pointer' : 'text-text-secondary'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={propagateDeletes}
                      disabled={mode !== 'delta'}
                      onChange={(e) => setPropagateDeletes(e.target.checked)}
                      aria-describedby={deletesHintId}
                      data-testid="sync-delta-deletes"
                    />
                    {t('sync.delta.deletes')}
                  </label>
                  <p id={deletesHintId} className="text-xs text-text-secondary">
                    {t('sync.delta.deletesHint')}
                  </p>
                  <ToggleDetails testId="sync-delta-deletes-details">
                    {t('sync.delta.deletesDetails')}
                  </ToggleDetails>
                  {deltaBlockers.length > 0 && (
                    <p
                      className="text-xs text-status-warning"
                      role="alert"
                      data-testid="sync-delta-blockers"
                    >
                      {t('sync.delta.needsKey', { objects: deltaBlockers.join(', ') })}
                    </p>
                  )}
                </div>

                {/* Emails and phone numbers: neutralized unless unticked, as a
                  Forge run's are. Copied as read into a sandbox whose flows
                  email and text the contacts they are written for, the copies
                  were real people. */}
                <div
                  className="flex flex-col gap-(--sf-space-2) rounded-sm border border-(--sf-border) p-(--sf-space-2)"
                  data-testid="sync-contact-points-settings"
                >
                  <label className="flex items-start gap-2 text-xs text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!keepContactPoints}
                      onChange={(e) => setKeepContactPoints(!e.target.checked)}
                      aria-describedby={contactPointsHintId}
                      data-testid="sync-contact-points-toggle"
                    />
                    {t('sync.contactPoints.toggle')}
                  </label>
                  <p id={contactPointsHintId} className="text-xs text-text-secondary">
                    {t('sync.contactPoints.toggleHint')}
                  </p>
                  <ToggleDetails testId="sync-contact-points-details">
                    {t('sync.contactPoints.toggleDetails')}
                  </ToggleDetails>
                </div>

                {/* The files of the records it writes: off unless ticked, with the
                  two caps a run keeps to. */}
                <div
                  className="flex flex-col gap-(--sf-space-2) rounded-sm border border-(--sf-border) p-(--sf-space-2)"
                  data-testid="sync-files-settings"
                >
                  <label className="flex items-start gap-2 text-xs text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={copyFiles}
                      onChange={(e) => setCopyFiles(e.target.checked)}
                      aria-describedby={filesHintId}
                      data-testid="sync-files-toggle"
                    />
                    {t('sync.files.toggle')}
                  </label>
                  <p id={filesHintId} className="text-xs text-text-secondary">
                    {t('sync.files.toggleHint')}
                  </p>
                  <ToggleDetails testId="sync-files-details">
                    {t('sync.files.toggleDetails')}
                  </ToggleDetails>
                  {copyFiles && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-(--sf-space-2)">
                      <label className="flex flex-col gap-1 text-xs text-text-primary">
                        {t('sync.files.maxFileSize')}
                        <input
                          type="number"
                          min={1}
                          max={FILE_COPY_CEILING_MB}
                          step={1}
                          value={fileCaps.maxFileSizeMB}
                          onChange={(e) => setFileCap('maxFileSizeMB', Number(e.target.value))}
                          className="px-2 py-1 rounded-sm text-xs bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input)"
                          data-testid="sync-files-max-file"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-text-primary">
                        {t('sync.files.maxRun')}
                        <input
                          type="number"
                          min={1}
                          max={SYNC_FILES_MAX_RUN_MB}
                          step={1}
                          value={fileCaps.maxRunMB}
                          onChange={(e) => setFileCap('maxRunMB', Number(e.target.value))}
                          className="px-2 py-1 rounded-sm text-xs bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input)"
                          data-testid="sync-files-max-run"
                        />
                      </label>
                    </div>
                  )}
                </div>

                {/* Template picker — only show when both orgs are selected */}
                {sourceOrgId && targetOrgId && (
                  <details className="mt-2" data-testid="sync-template-section">
                    <summary className="text-xs font-semibold text-text-primary cursor-pointer">
                      {t('sync.templates.title')}
                    </summary>
                    <div className="mt-2">
                      <SyncTemplatePicker onApply={handleApplyTemplate} />
                    </div>
                  </details>
                )}

                {/* Object set editor — inline in merged step */}
                {sourceOrgId &&
                  (objectsLoading ? (
                    <div
                      className="flex flex-col gap-(--sf-space-3)"
                      data-testid="sync-objects-skeleton"
                    >
                      <Skeleton variant="text" width="30%" height="1em" />
                      <Skeleton variant="rect" height="140px" />
                      <Skeleton variant="text" width="50%" height="1em" />
                    </div>
                  ) : (
                    <ObjectSetEditor
                      entries={objectEntries}
                      availableObjects={availableObjects}
                      unwritableObjects={unwritableObjects}
                      onAdd={handleAddObject}
                      onRemove={handleRemoveObject}
                      onChange={handleObjectChange}
                    />
                  ))}

                {/* What a run does with a record the target already holds,
                  asked once an object finds one: an upsert by its key, an
                  update by its id. The page asked for a Direction and a
                  Conflict Strategy side by side: Bidirectional wrote to the
                  target alone, as every run does, and on the default
                  direction the strategy was never read. */}
                {findsHeldRecords && (
                  <div
                    className="flex flex-col gap-(--sf-space-2) rounded-sm border border-(--sf-border) p-(--sf-space-2)"
                    data-testid="sync-held-records"
                  >
                    <Select
                      label={t('sync.conflictStrategy')}
                      options={conflictOptions}
                      value={conflictStrategy}
                      onChange={(e) => setConflictStrategy(e.target.value as SyncConflictStrategy)}
                      aria-describedby={heldRecordsHintId}
                      data-testid="sync-held-records-choice"
                    />
                    <p id={heldRecordsHintId} className="text-xs text-text-secondary">
                      {t('sync.conflictStrategyHint')}
                    </p>
                    {/* A draft saved when manual review was offered: it reopens
                      on keeping the target's values, and says so, rather than
                      going on writing the source values under a name that
                      promised a decision. */}
                    {strategyNotice && (
                      <div
                        className="flex items-start justify-between gap-(--sf-space-2) text-xs text-text-primary"
                        role="status"
                        data-testid="sync-strategy-notice"
                      >
                        <p>{t('sync.strategyNotice.manualReplaced')}</p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={dismissStrategyNotice}
                          data-testid="sync-strategy-notice-dismiss"
                        >
                          {t('common.dismiss')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Step 1: Field mapping */}
            {currentStep === 1 && fieldsLoading && (
              <div className="flex flex-col gap-(--sf-space-3)" data-testid="sync-fields-skeleton">
                <Skeleton variant="text" width="25%" height="1em" />
                <div className="grid grid-cols-2 gap-(--sf-space-4)">
                  <Skeleton variant="rect" height="200px" />
                  <Skeleton variant="rect" height="200px" />
                </div>
              </div>
            )}
            {currentStep === 1 && !fieldsLoading && (
              <div className="flex flex-col gap-4" data-testid="sync-step-field-mapping">
                {/*
                Which object is being mapped. The step describes one object at a
                time, and every object of the run used to be sent the mappings
                drawn for whichever one happened to be first — so only one
                object could be mapped at all, and the rest were written through
                its fields.
              */}
                {objectEntries.length > 1 && (
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="sync-mapped-object"
                      className="text-[10px] uppercase tracking-widest text-text-secondary"
                    >
                      {t('sync.mappingForObject')}
                    </label>
                    <select
                      id="sync-mapped-object"
                      data-testid="sync-mapped-object"
                      value={mappedObject}
                      onChange={(e) => setMappedObject(e.target.value)}
                      className="px-3 py-2 rounded-md text-sm bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input) focus:outline-hidden focus:border-sync/50"
                    >
                      {objectEntries.map((entry) => (
                        <option key={entry.objectApiName} value={entry.objectApiName}>
                          {entry.objectApiName}
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-text-secondary">
                      {t('sync.mappingForObjectHint')}
                    </p>
                  </div>
                )}
                {/* One editor for the mappings: two edited the same list, one
                  of them drawing lines and the other a table. */}
                <FieldMappingCanvas
                  sourceFields={sourceFields}
                  targetFields={targetFields}
                  mappings={mappings}
                  onAddMapping={handleAddMapping}
                  onRemoveMapping={handleRemoveMapping}
                  onChangeMappingType={handleMappingTypeChange}
                  onAutoMap={() => {
                    const auto = sourceFields
                      .filter((sf) => targetFields.some((tf) => tf.apiName === sf.apiName))
                      .map((sf) => ({
                        sourceField: sf.apiName,
                        targetField: sf.apiName,
                        type: 'direct' as MappingType,
                      }));
                    setMappings(auto);
                  }}
                />
              </div>
            )}

            {/* Step 2: Transforms */}
            {currentStep === 2 && (
              <TransformBuilder
                rules={transforms}
                onAddRule={handleAddTransform}
                onRemoveRule={handleRemoveTransform}
                onChangeConfig={handleChangeTransformConfig}
              />
            )}

            {/* Step 3: Review */}
            {currentStep === 3 && (
              <div className="flex flex-col gap-3" data-testid="sync-step-review">
                <p className="text-xs text-text-secondary">{t('sync.reviewDesc')}</p>

                {/* PII scan warnings */}
                {piiWarnings.length > 0 && (
                  <Card data-testid="pii-warnings">
                    <CardHeader
                      title={t('sync.piiWarningTitle', { defaultValue: 'PII Detected' })}
                    />
                    <CardBody>
                      {piiWarnings.map((w) => (
                        <div key={w.objectName} className="text-xs mb-1">
                          <span className="font-medium">{w.objectName}</span>
                          {': '}
                          {w.piiFields.map((f) => f.fieldName).join(', ')}
                        </div>
                      ))}
                    </CardBody>
                  </Card>
                )}
                <div className="flex gap-3 text-xs flex-wrap">
                  {mode === 'delta' && (
                    <Badge variant="info" data-testid="sync-review-delta">
                      {propagateDeletes
                        ? t('syncParts.delta.withDeletes')
                        : t('syncParts.delta.mode')}
                    </Badge>
                  )}
                  {copyFiles && (
                    <Badge variant="info" data-testid="sync-review-files">
                      {t('sync.files.badge')}
                    </Badge>
                  )}
                  <span className="text-text-primary">
                    {t('common.objectCount', { count: objectEntries.length })}
                  </span>
                  <span className="text-text-primary">
                    {t('sync.fieldMappingCount', { count: mappings.length })}
                  </span>
                  <span className="text-text-primary">
                    {t('sync.transformCount', { count: transforms.length })}
                  </span>
                </div>
                {findsHeldRecords && (
                  <p className="text-xs text-text-primary" data-testid="sync-review-held-records">
                    {t('sync.heldRecordsChosen', {
                      choice: t(`sync.conflicts.${conflictStrategy}`),
                    })}
                  </p>
                )}
                <SyncReviewObjects
                  entries={objectEntries}
                  order={writeOrder}
                  orderLoading={writeOrderLoading}
                  orderUnread={writeOrderUnread}
                  saved={configSaved}
                  encrypted={writeOrderEncrypted}
                />
                <SankeyFlow
                  nodes={buildSankeyNodes(objectEntries, mappings)}
                  links={buildSankeyLinks(objectEntries, mappings)}
                />

                {/* A schedule runs a saved configuration by id, so this is where
                  one is created: the review step holds the configuration the
                  user has just read through. */}
                <div className="flex items-center gap-(--sf-space-2)">
                  <button
                    type="button"
                    className="text-xs px-3 py-1.5 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover) disabled:opacity-50"
                    onClick={() => handleSaveConfig(configName)}
                    disabled={!sourceOrgId || !targetOrgId}
                    data-testid="sync-save-config"
                  >
                    {t('common.save')}
                  </button>
                  {configSaved && (
                    <span
                      className="text-[10px] text-text-secondary"
                      data-testid="sync-config-saved"
                    >
                      {t('sync.configSaved')}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Step 4: Execute — a simulation first, if wanted, then the run. */}
            {currentStep === 4 && (
              <div className="flex flex-col gap-3" data-testid="sync-step-execute">
                <p className="text-xs text-text-secondary">{t('sync.executeDesc')}</p>
                {/* While it runs: back on this step afterwards, Run is the wizard's. */}
                {busy && savedRunLabel !== null && (
                  <p className="text-xs text-text-primary" data-testid="sync-saved-run">
                    {t('syncParts.savedConfigs.ofSaved', { name: savedRunLabel })}
                  </p>
                )}
                {/* Files are copied by a saved configuration only: the
                  extension refuses a run and a simulation of one that is not
                  saved, so both wait for the save, and say why. The save is
                  offered right there: the reason sent the user back to the
                  Review step for it. */}
                {!busy && filesNeedSave && (
                  <div className="flex items-center gap-(--sf-space-2)">
                    <p
                      id={filesNeedSaveId}
                      className="text-xs text-status-warning"
                      role="status"
                      data-testid="sync-files-needs-save"
                    >
                      {t('sync.files.needsSave')}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleSaveConfig(configName)}
                      aria-describedby={filesNeedSaveId}
                      className="shrink-0"
                      data-testid="sync-files-save"
                    >
                      {t('common.save')}
                    </Button>
                  </div>
                )}
                {!busy && (
                  <>
                    <p className="text-xs text-text-secondary">{t('sync.simulation.hint')}</p>
                    <div className="flex items-center gap-(--sf-space-2)">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleSimulate}
                        disabled={filesNeedSave}
                        aria-describedby={filesNeedSave ? filesNeedSaveId : undefined}
                        data-testid="sync-simulate"
                      >
                        {t('sync.simulation.start')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleExecute}
                        disabled={filesNeedSave}
                        aria-describedby={filesNeedSave ? filesNeedSaveId : undefined}
                        data-testid="sync-run"
                      >
                        {t('sync.runNow')}
                      </Button>
                    </div>
                  </>
                )}
                <ProgressBar
                  value={overallPercent}
                  max={100}
                  label={
                    isSimulating
                      ? t('sync.simulation.running')
                      : isRunning
                        ? t('sync.running')
                        : `${Math.round(overallPercent)}%`
                  }
                  showPercent
                  variant={overallPercent >= 100 ? 'success' : 'default'}
                />
                <ProgressAnnouncer
                  message={t('a11y.progressAnnouncement', {
                    name: t('nav.sync'),
                    percent: Math.round(overallPercent),
                  })}
                  immediate={!busy || overallPercent >= 100}
                  testId="sync-progress-status"
                />
                <div className="text-[10px] text-text-secondary" data-testid="sync-elapsed">
                  {(elapsedMs / 1000).toFixed(1)}s
                </div>
                {busy && runOperationId !== null && (
                  <SyncRunControls
                    operationId={runOperationId}
                    kind={isSimulating ? 'simulation' : 'run'}
                  />
                )}
                <SyncGrappePanel />
              </div>
            )}

            {/* Step 5: Results */}
            {currentStep === 5 && (
              <div className="flex flex-col gap-3" data-testid="sync-step-results">
                {savedRunLabel !== null && result && (
                  <p className="text-xs text-text-primary" data-testid="sync-saved-run">
                    {t('syncParts.savedConfigs.ofSaved', { name: savedRunLabel })}
                  </p>
                )}
                {simulation ? (
                  <SyncSimulationResults simulation={simulation} onRun={handleExecute} />
                ) : !result ? (
                  <p className="text-xs text-center text-text-secondary py-4">
                    {t('common.noData')}
                  </p>
                ) : (
                  <>
                    <div
                      className="flex items-center gap-3 text-xs"
                      data-testid="sync-result-summary"
                    >
                      {/* A run a cancel stopped reads as cancelled, not as the
                        partial status its objects came to. */}
                      {result.cancelled ? (
                        <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
                      ) : (
                        <Badge variant={statusVariant[result.status]}>
                          {result.status === 'success'
                            ? t('syncParts.complete')
                            : result.status === 'partial'
                              ? t('syncParts.partial')
                              : t('syncParts.failed')}
                        </Badge>
                      )}
                      <span>
                        {t('syncParts.totalProcessed')}: <strong>{result.totalProcessed}</strong>
                      </span>
                      <span>
                        {t('syncParts.totalSuccess')}: <strong>{result.totalSuccess}</strong>
                      </span>
                      {result.totalFailed > 0 && (
                        <span className="text-status-error">
                          {t('syncParts.totalFailed')}: <strong>{result.totalFailed}</strong>
                        </span>
                      )}
                    </div>
                    {result.objectResults.some((obj) => obj.files) && (
                      <SyncFilesSummary
                        outcomes={result.objectResults.flatMap((obj) =>
                          obj.files ? [obj.files] : [],
                        )}
                        testId="sync-result-files"
                      />
                    )}
                    {/* What the run created, and its removal. */}
                    {result.created && (
                      <SyncRunRemoval runId={result.created.runId} testId="sync-result-removal" />
                    )}
                    {/* The emails and phone numbers it wrote, said once for the
                      run as a Forge run says them: no refusal of any object. */}
                    {result.contactPoints && (
                      <ForgeContactPointsResult report={result.contactPoints} />
                    )}
                    {result.objectResults.map((obj) => (
                      <Card key={obj.objectApiName}>
                        <CardHeader
                          title={obj.objectApiName}
                          subtitle={`${t(`syncParts.operations.${obj.operation}`)} — ${obj.success}/${obj.processed}`}
                        />
                        {(obj.errors.length > 0 ||
                          obj.delta ||
                          obj.files ||
                          (obj.alreadyCopied ?? 0) > 0 ||
                          obj.standardPricebookMatched ||
                          hasWrittenLines(obj) ||
                          (obj.currenciesReplaced?.length ?? 0) > 0 ||
                          (obj.pricesSettled?.length ?? 0) > 0) && (
                          <CardBody>
                            {/* No refusal: said beside the object's other lines. */}
                            {obj.standardPricebookMatched && (
                              <SyncPricebookLine
                                testId={`sync-result-pricebook-${obj.objectApiName}`}
                              />
                            )}
                            {obj.delta && (
                              <SyncDeltaLine
                                delta={obj.delta}
                                testId={`sync-result-delta-${obj.objectApiName}`}
                              />
                            )}
                            {/* Not inserted a second time: an earlier run copied them. */}
                            {obj.alreadyCopied !== undefined && obj.alreadyCopied > 0 && (
                              <SyncAlreadyCopiedLine
                                count={obj.alreadyCopied}
                                testId={`sync-result-copied-${obj.objectApiName}`}
                              />
                            )}
                            {obj.files && (
                              <SyncFilesLine
                                files={obj.files}
                                testId={`sync-result-files-${obj.objectApiName}`}
                              />
                            )}
                            {/* Linked rather than written, or written without a
                              lookup: no refusal either. */}
                            <SyncWrittenLines
                              result={obj}
                              testId={`sync-result-written-${obj.objectApiName}`}
                            />
                            <RecordErrorGroups
                              objectApiName={obj.objectApiName}
                              errors={obj.errors}
                              {...(obj.refusalsDropped
                                ? {
                                    recordsFailed: obj.failed,
                                    recordsListed: obj.failed - obj.refusalsDropped,
                                  }
                                : {})}
                              testIdPrefix="sync-result"
                            />
                            {/* No refusal either: said as the run's history says them. */}
                            {obj.currenciesReplaced && obj.currenciesReplaced.length > 0 && (
                              <ForgeCurrenciesResult entries={obj.currenciesReplaced} />
                            )}
                            {obj.pricesSettled && obj.pricesSettled.length > 0 && (
                              <PriceCurrenciesResult entries={obj.pricesSettled} />
                            )}
                          </CardBody>
                        )}
                      </Card>
                    ))}
                  </>
                )}
              </div>
            )}
          </SyncWizard>
        )}
        {/* End of sync tab content */}
      </div>
    </div>
  );
};
