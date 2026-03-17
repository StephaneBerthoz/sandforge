import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncDirection, SyncMode, ConflictStrategy, MappingType, FieldMapping } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { Select } from '../../components/ui/Select';
import { Badge } from '../../components/ui/Badge';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { SyncWizard } from './SyncWizard';
import type { SyncWizardStep } from './SyncWizard';
import { FieldMappingCanvas } from './FieldMappingCanvas';
import { TransformBuilder } from './TransformBuilder';
import { ObjectSetEditor } from './ObjectSetEditor';
import { SankeyFlow } from './SankeyFlow';
import type { SankeyNode, SankeyLink } from './SankeyFlow';
import { FieldMapper } from '../../components/graph/FieldMapper';
import type { FieldMapping as FieldMapperMapping } from '../../components/graph/FieldMapper';
import { GrappeProgressPanel } from '../../components/GrappeProgressPanel';
import { useGrappeStore } from '../../stores/useGrappeStore';
import type { BadgeVariant } from '../../components/ui/Badge';
import { useSyncPageData } from './useSyncPageData';
import type { ObjectSetEntry } from './ObjectSetEditor';

const SYNC_STEPS: SyncWizardStep[] = [
  { id: 'select-orgs', labelKey: 'sync.selectOrgs' },
  { id: 'configure-objects', labelKey: 'sync.configureObjects' },
  { id: 'field-mapping', labelKey: 'sync.fieldMapping' },
  { id: 'transforms', labelKey: 'sync.transforms' },
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
function buildSankeyNodes(
  entries: ObjectSetEntry[],
  fieldMappings: FieldMapping[],
): SankeyNode[] {
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
function buildSankeyLinks(
  entries: ObjectSetEntry[],
  fieldMappings: FieldMapping[],
): SankeyLink[] {
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

/** Wrapper that only mounts GrappeProgressPanel when grappe is active. */
const SyncGrappePanel: React.FC = () => {
  const { active, operationId } = useGrappeStore();
  if (!active && !operationId) return null;
  return <GrappeProgressPanel />;
};

/** Main Sync page — wired to extension via bridge hooks. */
export const SyncPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);

  const {
    availableObjects,
    sourceFields,
    targetFields,
    result,
    isRunning,
    objectsLoading,
    fieldsLoading,
    error,
    clearError,
    piiWarnings,
    currentStep,
    setCurrentStep,
    sourceOrgId,
    targetOrgId,
    direction,
    setDirection,
    mode,
    setMode,
    conflictStrategy,
    setConflictStrategy,
    objectEntries,
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
    handleExecute,
    canGoNext,
    isFinished,
    overallPercent,
    elapsedMs,
  } = useSyncPageData();

  const sourceOrg = orgs.find((o) => o.id === sourceOrgId);
  const targetOrg = orgs.find((o) => o.id === targetOrgId);

  if (orgs.length < 2) {
    return (
      <EmptyState
        icon="sync"
        title={t('sync.title')}
        description={t('sync.selectOrgsDesc')}
      />
    );
  }

  const orgOptions = orgs.map((org) => ({ value: org.id, label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}` }));
  const directionOptions: { value: SyncDirection; label: string }[] = [
    { value: 'source_to_target', label: t('sync.directions.source_to_target') },
    { value: 'target_to_source', label: t('sync.directions.target_to_source') },
    { value: 'bidirectional', label: t('sync.directions.bidirectional') },
  ];
  const modeOptions: { value: SyncMode; label: string }[] = [
    { value: 'full', label: t('sync.modes.full') },
    { value: 'incremental', label: t('sync.modes.incremental') },
    { value: 'delta', label: t('sync.modes.delta') },
    { value: 'cdc', label: t('sync.modes.cdc') },
  ];
  const conflictOptions: { value: ConflictStrategy; label: string }[] = [
    { value: 'source_wins', label: t('sync.conflicts.source_wins') },
    { value: 'target_wins', label: t('sync.conflicts.target_wins') },
    { value: 'newest_wins', label: t('sync.conflicts.newest_wins') },
    { value: 'manual', label: t('sync.conflicts.manual') },
    { value: 'merge', label: t('sync.conflicts.merge') },
  ];

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]" data-testid="sync-page">
      <PageHeader
        title={t('sync.title')}
        subtitle={t('sync.selectOrgsDesc')}
        icon="sync"
        actions={
          <div className="flex items-center gap-[var(--sf-space-2)]">
            {sourceOrg && (
              <OrgBadge
                alias={sourceOrg.alias || sourceOrg.username}
                orgType={String(sourceOrg.orgType)}
                status={sourceOrg.status}
                instanceUrl={sourceOrg.instanceUrl}
              />
            )}
            {sourceOrg && targetOrg && (
              <span className="codicon codicon-arrow-right text-[var(--sf-text-secondary)]" aria-hidden="true" />
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
        <ErrorBanner message={error} onDismiss={clearError} data-testid="sync-error" />
      )}

      <SyncWizard
        steps={SYNC_STEPS}
        currentStep={currentStep}
        onStepChange={setCurrentStep}
        canGoNext={canGoNext()}
        isFinished={isFinished}
        onFinish={handleExecute}
      >
        {/* Step 0: Select orgs */}
        {currentStep === 0 && (
          <div className="flex flex-col gap-4" data-testid="sync-step-orgs">
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('sync.selectOrgsDesc')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select label={t('sync.source')} options={orgOptions} value={sourceOrgId} onChange={(e) => handleSourceOrgChange(e.target.value)} placeholder={t('sync.source')} />
              <Select label={t('sync.target')} options={orgOptions} value={targetOrgId} onChange={(e) => handleTargetOrgChange(e.target.value)} placeholder={t('sync.target')} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Select label={t('sync.direction')} options={directionOptions} value={direction} onChange={(e) => setDirection(e.target.value as SyncDirection)} />
              <Select label={t('sync.mode')} options={modeOptions} value={mode} onChange={(e) => setMode(e.target.value as SyncMode)} />
              <Select label={t('sync.conflictStrategy')} options={conflictOptions} value={conflictStrategy} onChange={(e) => setConflictStrategy(e.target.value as ConflictStrategy)} />
            </div>
          </div>
        )}

        {/* Step 1: Configure objects */}
        {currentStep === 1 && (
          objectsLoading ? (
            <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="sync-objects-skeleton">
              <Skeleton variant="text" width="30%" height="1em" />
              <Skeleton variant="rect" height="140px" />
              <Skeleton variant="text" width="50%" height="1em" />
            </div>
          ) : (
            <ObjectSetEditor
              entries={objectEntries}
              availableObjects={availableObjects}
              onAdd={handleAddObject}
              onRemove={handleRemoveObject}
              onChange={handleObjectChange}
            />
          )
        )}

        {/* Step 2: Field mapping */}
        {currentStep === 2 && fieldsLoading && (
          <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="sync-fields-skeleton">
            <Skeleton variant="text" width="25%" height="1em" />
            <div className="grid grid-cols-2 gap-[var(--sf-space-4)]">
              <Skeleton variant="rect" height="200px" />
              <Skeleton variant="rect" height="200px" />
            </div>
          </div>
        )}
        {currentStep === 2 && !fieldsLoading && (
          <div className="flex flex-col gap-4" data-testid="sync-step-field-mapping">
            <FieldMapper
              sourceFields={sourceFields.map((f) => f.apiName)}
              targetFields={targetFields.map((f) => f.apiName)}
              mappings={mappings.map((m): FieldMapperMapping => ({
                sourceField: m.sourceField,
                targetField: m.targetField,
              }))}
              onMappingChange={(fmMappings) => {
                setMappings(fmMappings.map((fm) => ({
                  sourceField: fm.sourceField,
                  targetField: fm.targetField,
                  type: 'direct' as MappingType,
                })));
              }}
              onAutoMatch={() => {
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
            <FieldMappingCanvas
              sourceFields={sourceFields}
              targetFields={targetFields}
              mappings={mappings}
              onAddMapping={handleAddMapping}
              onRemoveMapping={handleRemoveMapping}
              onChangeMappingType={handleMappingTypeChange}
            />
          </div>
        )}

        {/* Step 3: Transforms */}
        {currentStep === 3 && (
          <TransformBuilder
            rules={transforms}
            onAddRule={handleAddTransform}
            onRemoveRule={handleRemoveTransform}
            onChangeConfig={() => undefined}
          />
        )}

        {/* Step 4: Review */}
        {currentStep === 4 && (
          <div className="flex flex-col gap-3" data-testid="sync-step-review">
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('sync.reviewDesc')}
            </p>

            {/* PII scan warnings */}
            {piiWarnings.length > 0 && (
              <Card data-testid="pii-warnings">
                <CardHeader title={t('sync.piiWarningTitle', { defaultValue: 'PII Detected' })} />
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
              <Badge variant="default">{t(`sync.directions.${direction}`)}</Badge>
              <Badge variant="default">{t(`sync.modes.${mode}`)}</Badge>
              <Badge variant="default">{t(`sync.conflicts.${conflictStrategy}`)}</Badge>
              <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {objectEntries.length} {t('sync.objectSet').toLowerCase()}
              </span>
              <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {mappings.length} {t('sync.fieldMapping').toLowerCase()}
              </span>
              <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {transforms.length} {t('sync.transforms').toLowerCase()}
              </span>
            </div>
            <SankeyFlow
              nodes={buildSankeyNodes(objectEntries, mappings)}
              links={buildSankeyLinks(objectEntries, mappings)}
            />
          </div>
        )}

        {/* Step 5: Execute */}
        {currentStep === 5 && (
          <div className="flex flex-col gap-3" data-testid="sync-step-execute">
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('sync.executeDesc')}
            </p>
            <ProgressBar
              value={overallPercent}
              max={100}
              label={isRunning ? t('sync.running') : `${Math.round(overallPercent)}%`}
              showPercent
              variant={overallPercent >= 100 ? 'success' : 'default'}
            />
            <div className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]" data-testid="sync-elapsed">
              {(elapsedMs / 1000).toFixed(1)}s
            </div>
            <SyncGrappePanel />
          </div>
        )}

        {/* Step 6: Results */}
        {currentStep === 6 && (
          <div className="flex flex-col gap-3" data-testid="sync-step-results">
            {!result ? (
              <p className="text-xs text-center text-[var(--vscode-descriptionForeground,#868686)] py-4">
                {t('common.noData')}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3 text-xs" data-testid="sync-result-summary">
                  <Badge variant={statusVariant[result.status]}>
                    {result.status === 'success' ? t('sync.complete') : result.status === 'partial' ? t('sync.partial') : t('sync.failed')}
                  </Badge>
                  <span>{t('sync.totalProcessed')}: <strong>{result.totalProcessed}</strong></span>
                  <span>{t('sync.totalSuccess')}: <strong>{result.totalSuccess}</strong></span>
                  {result.totalFailed > 0 && (
                    <span className="text-[var(--vscode-errorForeground,#f48771)]">
                      {t('sync.totalFailed')}: <strong>{result.totalFailed}</strong>
                    </span>
                  )}
                </div>
                {result.objectResults.map((obj) => (
                  <Card key={obj.objectApiName}>
                    <CardHeader
                      title={obj.objectApiName}
                      subtitle={`${t(`sync.operations.${obj.operation}`)} — ${obj.success}/${obj.processed}`}
                    />
                    {obj.errors.length > 0 && (
                      <CardBody>
                        {obj.errors.map((err, i) => (
                          <p key={i} className="text-[10px] text-[var(--vscode-errorForeground,#f48771)]">{err}</p>
                        ))}
                      </CardBody>
                    )}
                  </Card>
                ))}
              </>
            )}
          </div>
        )}
      </SyncWizard>
    </div>
  );
};
