import React, { useId, useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { orgDisplayName } from '@sandforge/shared';
import type { CompareResult, MetadataComponentType, EnrichedDiff } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import type { NavigationIntent } from '../../stores/useAppStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { REQUEST_TIMED_OUT } from '../../hooks/useMessageResponse';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import type { PageTab } from '../../components/ui/PageTabs';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { OrgSelector } from './OrgSelector';
import { CategorySelector } from './CategorySelector';
import { RiskScoreCard } from './RiskScoreCard';
import { ContentCoverage } from './ContentCoverage';
import { DiffGroupAccordion } from './DiffGroupAccordion';
import { DiffDetailModal } from './DiffDetailModal';
import { OrgOverview } from './OrgOverview';
import { DeployPanel } from './DeployPanel';
import { CHANGE_LOOK, CHANGE_ORDER } from './changeLook';
import { enrichDiffs } from './enrichDiffs';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';

/** How long the page waits for a diff before it calls the comparison failed. */
const COMPARE_TIMEOUT_MS = 5 * 60_000;

/** A tab of the page, by the id a navigation names it with. */
type CompareTab = NonNullable<NavigationIntent['compareTab']>;

/** Where the page opens: the two orgs and the tab a navigation named, or none of them. */
interface CompareLanding {
  sourceOrgId: string;
  targetOrgId: string;
  tab: CompareTab;
}

/**
 * The landing a navigation asked for, read once as the page opens. One meant
 * for another page is none: the page opens empty, on Differences.
 */
function landingOf(intent: NavigationIntent | null): CompareLanding {
  if (intent?.route !== 'compare') return { sourceOrgId: '', targetOrgId: '', tab: 'diff' };
  return {
    sourceOrgId: intent.compareSourceOrgId ?? '',
    targetOrgId: intent.compareTargetOrgId ?? '',
    tab: intent.compareTab ?? 'diff',
  };
}

/** Main compare page -- wired to extension via bridge hooks. */
export const ComparePage: React.FC = () => {
  const { t } = useTranslation();
  const runNeedsId = useId();
  const configSummaryId = useId();

  const COMPARE_TABS: PageTab[] = [
    { id: 'diff', label: t('compare.diff'), icon: 'diff' },
    // The step that follows a diff, beside it: it came fifth, after three
    // tabs that needed no diff at all.
    { id: 'deploy', label: t('compare.deploy'), icon: 'cloud-upload' },
    // Objects, permission sets and profiles, and Organization settings ask
    // the two orgs alone: open without a comparison.
    { id: 'overview', label: t('compare.overview'), icon: 'database' },
  ];
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  const addNotification = useNotificationStore((s) => s.addNotification);

  // Where the navigation asked the page to open, read once: the two orgs and
  // a tab. The pickers opened empty whatever sent the user here.
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  const [landing] = useState(() => landingOf(navigationIntent));
  useEffect(() => {
    if (navigationIntent?.route === 'compare') clearNavigationIntent();
  }, [navigationIntent, clearNavigationIntent]);

  const [sourceOrgId, setSourceOrgId] = useState(landing.sourceOrgId);
  const [targetOrgId, setTargetOrgId] = useState(landing.targetOrgId);
  const [selectedTypes, setSelectedTypes] = useState<MetadataComponentType[]>([]);
  // What a managed package installed is compared with the rest unless the box
  // is unticked; the result then says how many components it left out.
  const [includeManaged, setIncludeManaged] = useState(true);
  const [activeTab, setActiveTab] = useState<string>(landing.tab);
  const [selectedDiff, setSelectedDiff] = useState<EnrichedDiff | undefined>();
  const [error, setError] = useState<string | null>(null);
  /**
   * The comparison whose configuration Edit unfolded. A comparison that comes
   * back folds it to one line: it stayed open above the result, and the tabs
   * began about 1,030 px down.
   */
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const configRef = useRef<HTMLDivElement>(null);
  const focusSourceOnUnfold = useRef(false);

  /**
   * Bridge mutation: execute the comparison.
   *
   * The extension lists every ticked category on both orgs, and that takes as
   * long as the orgs make it: every category against two real sandboxes took
   * from 24 s to 106 s over three runs, most of it the one listing of 24,000
   * custom fields. The 30 s default showed a timeout and dropped the diff
   * that came after it.
   */
  const compareMutation = useBridgeMutation<CompareResult>('compare:execute', {
    timeoutMs: COMPARE_TIMEOUT_MS,
  });

  /** Derive state from the bridge mutation. */
  const result = compareMutation.data;
  const isRunning = compareMutation.loading;

  /** Show error notifications from bridge hook. */
  useEffect(() => {
    if (compareMutation.error) {
      // Run out of time, a diff runs out of time again on the same
      // categories: the generic words said to try again.
      const message =
        compareMutation.errorCode === REQUEST_TIMED_OUT
          ? t('compare.timedOut', { minutes: COMPARE_TIMEOUT_MS / 60_000 })
          : compareMutation.error;
      setError(message);
      addNotification({
        level: 'error',
        title: t('compare.title'),
        message,
      });
    }
  }, [compareMutation.error, compareMutation.errorCode, addNotification, t]);

  /**
   * Two different orgs this machine holds: one disconnected while it was
   * picked keeps its id here, which the ribbon says, and a run sent it.
   */
  const held = (id: string): boolean => orgs.some((org) => org.id === id);
  const orgsPicked = held(sourceOrgId) && held(targetOrgId) && sourceOrgId !== targetOrgId;

  // What Run Comparison waits for, said under it: two different orgs first,
  // then a category.
  const runNeeds: 'orgs' | 'categories' | null = !orgsPicked
    ? 'orgs'
    : selectedTypes.length === 0
      ? 'categories'
      : null;
  const canRun = runNeeds === null;

  /**
   * Folded once a comparison is in, until Edit. A configuration Run would
   * refuse stays open, so the ribbon can say an org disconnected meanwhile.
   */
  const folded = !!result && editingFor !== result.configId && canRun;

  /**
   * Org overview reads the two orgs alone. Before a first run the categories
   * stayed open above it, and what it read began about a thousand pixels
   * down: they wait on the other tabs, as picked.
   */
  const onOverview = activeTab === 'overview';

  // Edit hands the focus to the source picker it unfolds: the button it was
  // on goes with the folded line.
  useEffect(() => {
    if (folded || !focusSourceOnUnfold.current) return;
    focusSourceOnUnfold.current = false;
    configRef.current?.querySelector('select')?.focus();
  }, [folded]);

  const handleRunCompare = () => {
    if (!canRun) return;
    setError(null);
    // The comparison is shown on Differences; Org overview would hide it.
    if (activeTab === 'overview') setActiveTab('diff');
    compareMutation.mutate({
      sourceOrgId,
      targetOrgId,
      types: selectedTypes as unknown as Record<string, unknown>[],
      includeManaged,
    });
  };

  /** Enriched compare report computed from raw diffs. */
  const compareReport = useMemo(() => (result ? enrichDiffs(result.diffs) : undefined), [result]);

  if (orgs.length < 2) {
    return (
      <EmptyState
        module="compare"
        title={t('compare.emptyState.title')}
        description={t('compare.emptyState.description')}
        steps={[
          orgs.length === 1
            ? t('emptyState.connectSecondViaSfdx')
            : t('emptyState.connectTwoViaSfdx'),
          t('compare.emptyState.step2'),
          t('compare.emptyState.step3'),
          t('compare.emptyState.step4'),
        ]}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  /** The folded configuration, said in one line: the two orgs and what is compared. */
  const configSummary = (): string => {
    const words = {
      source: orgDisplayName(
        orgs.find((org) => org.id === sourceOrgId),
        sourceOrgId,
      ),
      target: orgDisplayName(
        orgs.find((org) => org.id === targetOrgId),
        targetOrgId,
      ),
      categories: t('compare.categoryCount', { count: selectedTypes.length }),
    };
    return includeManaged
      ? t('compare.configSummary', words)
      : t('compare.configSummaryManagedOut', words);
  };

  return (
    <div className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)" data-testid="compare-page">
      {/* Header */}
      <PageHeader
        title={t('compare.title')}
        // It read "No comparison results yet" above the results of a run.
        subtitle={result ? undefined : t('compare.noResults')}
        icon="git-compare"
        actions={
          <div className="flex flex-col items-end gap-(--sf-space-1)">
            <Button
              variant="primary"
              onClick={handleRunCompare}
              disabled={!canRun || isRunning}
              loading={isRunning}
              aria-describedby={runNeeds ? runNeedsId : undefined}
              data-testid="run-compare-btn"
            >
              {isRunning ? t('compare.running') : t('compare.run')}
            </Button>
            {/* Categories start at none, so the button stayed off after two
                orgs were picked, with nothing near it to say why. */}
            {runNeeds && (
              <p
                id={runNeedsId}
                className="text-right text-xs text-(--sf-text-secondary)"
                data-testid="compare-run-needs"
              >
                {runNeeds === 'categories' && onOverview
                  ? t('compare.runNeeds.categoriesOnTab', { tab: t('compare.diff') })
                  : t(`compare.runNeeds.${runNeeds}`)}
              </p>
            )}
          </div>
        }
      />
      <ModuleHowTo module="compare" />

      {error && (
        <ErrorBanner
          message={error}
          code={null}
          onDismiss={() => setError(null)}
          data-testid="compare-error"
        />
      )}

      {folded ? (
        <div
          className="flex flex-wrap items-center gap-(--sf-space-3) rounded-md border border-(--sf-border) px-(--sf-space-3) py-(--sf-space-2)"
          data-testid="compare-config-summary"
        >
          <span
            id={configSummaryId}
            className="text-xs text-(--sf-text-primary)"
            data-testid="compare-config-summary-text"
          >
            {configSummary()}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              focusSourceOnUnfold.current = true;
              setEditingFor(result?.configId ?? null);
            }}
            aria-describedby={configSummaryId}
            data-testid="compare-config-edit"
          >
            {t('common.edit')}
          </Button>
        </div>
      ) : (
        <div ref={configRef} className="flex flex-col gap-(--sf-space-4)">
          {/* The two orgs, picked in the ribbon that names them */}
          <OrgSelector
            orgs={orgs}
            sourceOrgId={sourceOrgId}
            targetOrgId={targetOrgId}
            onSourceChange={setSourceOrgId}
            onTargetChange={setTargetOrgId}
          />

          {/* Category selection, which only a comparison reads */}
          {!onOverview && (
            <>
              <CategorySelector selected={selectedTypes} onChange={setSelectedTypes} />

              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={includeManaged}
                  onChange={(e) => setIncludeManaged(e.target.checked)}
                  data-testid="compare-include-managed"
                />
                {t('compare.includeManaged')}
              </label>
            </>
          )}
        </div>
      )}

      <PageTabs tabs={COMPARE_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'diff' && result && compareReport && (
        <>
          {/* Risk score card */}
          <RiskScoreCard report={compareReport} />

          {/* Summary bar, read as a deployment from the source would read it:
              it counted "added" in green over what only the target holds,
              which a deployment does not add. */}
          <div className="flex gap-(--sf-space-4) text-xs" data-testid="compare-summary">
            {CHANGE_ORDER.map((kind) => (
              <span
                key={kind}
                className={CHANGE_LOOK[kind].textClass}
                data-testid={`compare-summary-${kind}`}
              >
                {CHANGE_LOOK[kind].symbol}
                {t(`compare.count.${kind}`, { count: result.summary[kind] })}
              </span>
            ))}
            <span className="text-(--sf-text-secondary)">
              ={t('compare.count.unchanged', { count: result.summary.unchanged })}
            </span>
            {result.summary.notCompared > 0 && (
              <span
                className="text-(--sf-text-secondary)"
                data-testid="compare-summary-not-compared"
              >
                ?{t('compare.count.notCompared', { count: result.summary.notCompared })}
              </span>
            )}
          </div>
          <p className="text-xs text-(--sf-text-secondary)" data-testid="compare-change-legend">
            {t('compare.changeLegend')}
          </p>

          <ContentCoverage coverage={result.content} />

          <DiffGroupAccordion diffs={compareReport.diffs} onSelectDiff={setSelectedDiff} />
        </>
      )}

      {/* Mounted while the comparison is shown, hidden on the other tabs:
          a validation runs for minutes, and a panel a tab change
          unmounted would drop its answer. Keyed by the comparison: what
          was picked and validated answers for one comparison, and a new
          one starts the tab afresh. */}
      {result && compareReport && (
        <div hidden={activeTab !== 'deploy'} data-testid="compare-deploy-tab">
          <DeployPanel key={result.configId} result={result} report={compareReport} orgs={orgs} />
        </div>
      )}

      {/* Reached before a comparison, from its tab or from a way out that
          names it: what it deploys comes from one. */}
      {activeTab === 'deploy' && !result && !isRunning && (
        <p
          className="py-8 text-center text-xs text-(--sf-text-secondary)"
          data-testid="compare-deploy-needs-run"
        >
          {t('compare.deployNeedsRun')}
        </p>
      )}

      {activeTab === 'overview' && (
        <OrgOverview sourceOrgId={sourceOrgId} targetOrgId={targetOrgId} orgsPicked={orgsPicked} />
      )}

      {/* Diff detail modal */}
      {selectedDiff && (
        <DiffDetailModal diff={selectedDiff} onClose={() => setSelectedDiff(undefined)} />
      )}

      {/* Skeleton loading state while comparison runs */}
      {isRunning && !result && activeTab !== 'overview' && (
        <div className="flex flex-col gap-(--sf-space-4)" data-testid="compare-skeleton">
          <Skeleton variant="rect" height="80px" />
          <div className="flex gap-(--sf-space-4)">
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
      {activeTab === 'diff' && !result && !isRunning && (
        <p
          className="text-xs text-(--sf-text-secondary) text-center py-8"
          data-testid="compare-no-results"
        >
          {t('compare.noResults')}
        </p>
      )}
    </div>
  );
};
