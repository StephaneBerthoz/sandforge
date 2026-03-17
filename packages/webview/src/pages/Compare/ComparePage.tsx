import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompareResult, MetadataComponentType, EnrichedDiff } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useSchemaAdvice } from '../../hooks/useAIFeatures';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import type { PageTab } from '../../components/ui/PageTabs';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { OrgSelector } from './OrgSelector';
import { CategorySelector } from './CategorySelector';
import { RiskScoreCard } from './RiskScoreCard';
import { DiffGroupAccordion } from './DiffGroupAccordion';
import { DiffDetailModal } from './DiffDetailModal';
import { PermissionMatrix } from './PermissionMatrix';
import type { PermissionMatrixRow } from './PermissionMatrix';
import { SnapshotTimeline } from './SnapshotTimeline';
import { DriftDashboard } from './DriftDashboard';
import type { DriftResult } from './DriftDashboard';
import { ImpactGraph } from './ImpactGraph';
import type { ImpactAnalysis } from './ImpactGraph';
import { DeployFromDiff } from './DeployFromDiff';
import { enrichDiffs } from './enrichDiffs';
import type { OrgSnapshot } from '@sandforge/shared';

/** Main compare page -- wired to extension via bridge hooks. */
export const ComparePage: React.FC = () => {
  const { t } = useTranslation();

  const COMPARE_TABS: PageTab[] = [
    { id: 'diff', label: t('compare.diff'), icon: 'diff' },
    { id: 'permissions', label: t('compare.permissions'), icon: 'shield' },
    { id: 'snapshots', label: t('compare.snapshots'), icon: 'history' },
    { id: 'drift', label: t('compare.drift'), icon: 'warning' },
    { id: 'impact', label: t('compare.impact'), icon: 'references' },
    { id: 'deploy', label: t('compare.deploy'), icon: 'cloud-upload' },
  ];
  const orgs = useOrgStore((s) => s.orgs);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [sourceOrgId, setSourceOrgId] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<MetadataComponentType[]>([]);
  const [activeTab, setActiveTab] = useState('diff');
  const [selectedDiff, setSelectedDiff] = useState<EnrichedDiff | undefined>();
  const [error, setError] = useState<string | null>(null);

  /** Bridge mutation: execute the comparison. */
  const compareMutation = useBridgeMutation<CompareResult>(
    'compare:execute',
    { responseType: 'compare:start:response' },
  );

  const schemaAdvice = useSchemaAdvice();

  /** Bridge queries for each tab -- lazy loaded via skip option. */
  const permissionsQuery = useBridgeQuery<PermissionMatrixRow[]>(
    'compare:permissions',
    { sourceOrgId, targetOrgId },
    { skip: activeTab !== 'permissions' || !sourceOrgId || !targetOrgId },
  );

  const snapshotsQuery = useBridgeQuery<OrgSnapshot[]>(
    'compare:snapshots',
    { sourceOrgId, targetOrgId },
    { skip: activeTab !== 'snapshots' || !sourceOrgId || !targetOrgId },
  );

  const driftQuery = useBridgeQuery<DriftResult>(
    'compare:drift',
    { sourceOrgId, targetOrgId },
    { skip: activeTab !== 'drift' || !sourceOrgId || !targetOrgId },
  );

  const impactQuery = useBridgeQuery<ImpactAnalysis>(
    'compare:impact',
    { sourceOrgId, targetOrgId },
    { skip: activeTab !== 'impact' || !sourceOrgId || !targetOrgId },
  );

  /** Derive state from the bridge mutation. */
  const result = compareMutation.data;
  const isRunning = compareMutation.loading;

  /** Show error notifications from bridge hook. */
  useEffect(() => {
    if (compareMutation.error) {
      setError(compareMutation.error);
      addNotification({ level: 'error', title: t('compare.title'), message: compareMutation.error, autoDismissMs: 5000 });
    }
  }, [compareMutation.error, addNotification, t]);

  const handleRunCompare = () => {
    if (!sourceOrgId || !targetOrgId || sourceOrgId === targetOrgId || selectedTypes.length === 0) return;
    setError(null);
    compareMutation.mutate({
      sourceOrgId,
      targetOrgId,
      types: selectedTypes as unknown as Record<string, unknown>[],
    });
  };

  const canRun = sourceOrgId && targetOrgId && sourceOrgId !== targetOrgId && selectedTypes.length > 0;

  /** Enriched compare report computed from raw diffs. */
  const compareReport = useMemo(
    () => (result ? enrichDiffs(result.diffs) : undefined),
    [result],
  );

  if (orgs.length < 2) {
    return (
      <EmptyState
        icon="git-compare"
        title={t('compare.selectOrgs')}
        description={t('compare.selectOrgs')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]" data-testid="compare-page">
      {/* Header */}
      <PageHeader
        title={t('compare.title')}
        subtitle={t('compare.noResults')}
        icon="git-compare"
        actions={
          <div className="flex items-center gap-[var(--sf-space-3)]">
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="lightbulb" />}
              onClick={() => schemaAdvice.mutate({ orgId: sourceOrgId })}
              disabled={!sourceOrgId || schemaAdvice.loading}
              loading={schemaAdvice.loading}
              data-testid="schema-advice-btn"
            >
              {t('compare.schemaAdvice', 'Schema Advice')}
            </Button>
            <Button
              variant="primary"
              onClick={handleRunCompare}
              disabled={!canRun || isRunning}
              loading={isRunning}
              data-testid="run-compare-btn"
            >
              {isRunning ? t('compare.running') : t('compare.run')}
            </Button>
          </div>
        }
      />

      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} data-testid="compare-error" />
      )}

      {schemaAdvice.error && (
        <ErrorBanner
          message={schemaAdvice.error}
          onDismiss={() => schemaAdvice.reset()}
          data-testid="schema-advice-error"
        />
      )}

      {schemaAdvice.data?.success && schemaAdvice.data.advice && (
        <Card data-testid="schema-advice-results">
          <CardHeader
            title={t('compare.schemaAdviceResults', 'Schema Advice')}
            subtitle={t('compare.schemaAdviceIssues', '{{count}} issues found').replace(
              '{{count}}',
              String(schemaAdvice.data.advice.issues.length),
            )}
          />
          <CardBody>
            {schemaAdvice.data.advice.issues.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-2)' }}>
                {schemaAdvice.data.advice.issues.map((issue, idx) => (
                  <li
                    key={`${issue.objectName}-${issue.field ?? ''}-${idx}`}
                    className="flex items-start"
                    style={{
                      gap: 'var(--sf-space-2)',
                      padding: 'var(--sf-space-2)',
                      borderRadius: 'var(--sf-radius-sm)',
                      backgroundColor: 'var(--sf-bg-secondary)',
                    }}
                  >
                    <Badge variant={issue.severity === 'high' ? 'error' : issue.severity === 'medium' ? 'warning' : 'info'}>
                      {issue.severity}
                    </Badge>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: 'var(--sf-font-size-sm)' }}>
                        {issue.objectName}
                        {issue.field && <span style={{ color: 'var(--sf-text-secondary)' }}>.{issue.field}</span>}
                      </span>
                      <p style={{ fontSize: 'var(--sf-font-size-sm)', color: 'var(--sf-text-secondary)', margin: 0 }}>
                        {issue.message}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {schemaAdvice.data.advice.recommendations.length > 0 && (
              <div style={{ marginTop: 'var(--sf-space-4)' }}>
                <h4 style={{ fontSize: 'var(--sf-font-size-sm)', fontWeight: 600, marginBottom: 'var(--sf-space-2)' }}>
                  {t('compare.recommendations', 'Recommendations')}
                </h4>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-2)' }}>
                  {schemaAdvice.data.advice.recommendations.map((rec, idx) => (
                    <li
                      key={idx}
                      style={{
                        padding: 'var(--sf-space-2)',
                        borderRadius: 'var(--sf-radius-sm)',
                        backgroundColor: 'var(--sf-bg-secondary)',
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 'var(--sf-font-size-sm)' }}>
                        {rec.title}
                      </span>
                      <p style={{ fontSize: 'var(--sf-font-size-sm)', color: 'var(--sf-text-secondary)', margin: 0 }}>
                        {rec.description}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Org selection */}
      <OrgSelector
        orgs={orgs}
        sourceOrgId={sourceOrgId}
        targetOrgId={targetOrgId}
        onSourceChange={setSourceOrgId}
        onTargetChange={setTargetOrgId}
      />

      {/* Category selection */}
      <CategorySelector selected={selectedTypes} onChange={setSelectedTypes} />

      {/* Results tabs */}
      {result && compareReport && (
        <>
          {/* Risk score card */}
          <RiskScoreCard report={compareReport} />

          {/* Summary bar */}
          <div className="flex gap-[var(--sf-space-4)] text-xs" data-testid="compare-summary">
            <span className="text-[var(--sf-success)]">+{result.summary.added} {t('compare.added')}</span>
            <span className="text-[var(--sf-error)]">-{result.summary.removed} {t('compare.removed')}</span>
            <span className="text-[var(--sf-warning)]">~{result.summary.modified} {t('compare.modified')}</span>
            <span className="text-[var(--vscode-descriptionForeground,#868686)]">
              ={result.summary.unchanged} {t('compare.unchanged')}
            </span>
          </div>

          <PageTabs
            tabs={COMPARE_TABS}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />

          {activeTab === 'diff' && (
            <DiffGroupAccordion
              diffs={compareReport.diffs}
              onSelectDiff={setSelectedDiff}
            />
          )}

          {activeTab === 'permissions' && (
            permissionsQuery.loading ? (
              <Skeleton variant="rect" height="200px" />
            ) : (
              <PermissionMatrix
                rows={permissionsQuery.data ?? []}
                sourceLabel={t('compare.source')}
                targetLabel={t('compare.target')}
              />
            )
          )}

          {activeTab === 'snapshots' && (
            snapshotsQuery.loading ? (
              <Skeleton variant="rect" height="200px" />
            ) : (
              <SnapshotTimeline
                snapshots={snapshotsQuery.data ?? []}
              />
            )
          )}

          {activeTab === 'drift' && (
            driftQuery.loading ? (
              <Skeleton variant="rect" height="200px" />
            ) : (
              <DriftDashboard
                drift={driftQuery.data ?? undefined}
              />
            )
          )}

          {activeTab === 'impact' && (
            impactQuery.loading ? (
              <Skeleton variant="rect" height="200px" />
            ) : (
              <ImpactGraph
                analysis={impactQuery.data ?? undefined}
              />
            )
          )}

          {activeTab === 'deploy' && (
            <DeployFromDiff />
          )}

          {/* Diff detail modal */}
          {selectedDiff && (
            <DiffDetailModal
              diff={selectedDiff}
              onClose={() => setSelectedDiff(undefined)}
            />
          )}
        </>
      )}

      {/* Skeleton loading state while comparison runs */}
      {isRunning && !result && (
        <div className="flex flex-col gap-[var(--sf-space-4)]" data-testid="compare-skeleton">
          <Skeleton variant="rect" height="80px" />
          <div className="flex gap-[var(--sf-space-4)]">
            <Skeleton variant="text" width="15%" height="1em" />
            <Skeleton variant="text" width="15%" height="1em" />
            <Skeleton variant="text" width="15%" height="1em" />
            <Skeleton variant="text" width="15%" height="1em" />
          </div>
          <Skeleton variant="rect" height="40px" />
          <Skeleton variant="rect" height="200px" />
        </div>
      )}

      {/* No results state */}
      {!result && !isRunning && (
        <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-8">
          {t('compare.noResults')}
        </p>
      )}
    </div>
  );
};
