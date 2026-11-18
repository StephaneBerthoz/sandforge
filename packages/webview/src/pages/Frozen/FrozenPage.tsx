import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Snowflake } from 'lucide-react';
import type { FrozenLastVerifyInfo, FrozenManifestInfo, FrozenStatusInfo } from '@sandforge/shared';
import { useAppStore } from '../../stores/useAppStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import { KPICard } from '../../components/ui/KPICard';
import { useFrozenPushChannels } from './useFrozenBridge';
import { FrozenExtractTab } from './FrozenExtractTab';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';
import { PartBoundary } from '../../components/ui/PartBoundary';
import { withEnglish } from '../../i18n/englishNamespaces';
import { orgDisplayName } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import type { NavigationIntent } from '../../stores/useAppStore';
import type { FrozenTab } from '../../stores/useFrozenStore';
import { formatDate, formatStoredDate } from '../../utils/formatters';

/*
 * The Load tab, a chunk of its own fetched the first time it is opened, with
 * the words of what the target runs as a load writes and of what a removal
 * deletes: the page opens on Extract. It parsed 997 kB before it painted while
 * it held them, 3 kB short of its budget.
 */
const LoadedFrozenLoadTab = lazy(() =>
  withEnglish(
    () => import('./FrozenLoadTab'),
    ['automationMute', 'checkpointNotes', 'runRemoval'],
  )().then((module) => ({
    default: module.FrozenLoadTab,
  })),
);

/**
 * Where a navigation asked the page to land: a tab, and on Load the org to
 * load into, taken only when this machine holds it. Back into service asks
 * for Load and the sandbox it brings back.
 */
function askedLanding(
  intent: NavigationIntent | null,
  orgs: readonly SalesforceOrg[],
): { tab?: FrozenTab; targetOrgId?: string } | null {
  if (intent?.route !== 'frozen') return null;
  const target = intent.frozenTargetOrgId;
  return {
    ...(intent.frozenTab ? { tab: intent.frozenTab } : {}),
    ...(target && orgs.some((org) => org.id === target) ? { targetOrgId: target } : {}),
  };
}

/**
 * Frozen Reference Dataset page — extract a pseudonymized reference dataset
 * once, replay it identically into refreshed dev sandboxes, verify it.
 */
export const FrozenPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  // Read once, before the tab is: the page opens on the tab asked for, with
  // no other drawn first.
  const [asked] = useState(() => {
    const landing = askedLanding(navigationIntent, orgs);
    if (landing?.tab) useFrozenStore.getState().setTab(landing.tab);
    if (landing?.targetOrgId) useFrozenStore.getState().setTargetOrgId(landing.targetOrgId);
    return landing;
  });
  useEffect(() => {
    if (asked) clearNavigationIntent();
  }, [asked, clearNavigationIntent]);
  const tab = useFrozenStore((s) => s.tab);
  const setTab = useFrozenStore((s) => s.setTab);
  const status = useFrozenStore((s) => s.status);
  const setStatus = useFrozenStore((s) => s.setStatus);
  const setManifest = useFrozenStore((s) => s.setManifest);
  const targetOrgId = useFrozenStore((s) => s.targetOrgId);

  useFrozenPushChannels();

  const statusQuery = useBridgeQuery<{ status: FrozenStatusInfo }>('frozen:status');
  const manifestQuery = useBridgeQuery<{ manifest: FrozenManifestInfo | null }>(
    'frozen:manifest:get',
  );

  useEffect(() => {
    if (statusQuery.data?.status) setStatus(statusQuery.data.status);
  }, [statusQuery.data, setStatus]);

  /*
   * Landed once, on the first status read: Load when a dataset is frozen on
   * this machine, the work left after a refresh; Extract when none is, or
   * when the status cannot be read. A tab picked or asked for first stays.
   * Until then neither is drawn: drawn first, Extract went as the answer came.
   */
  const statusFailed = statusQuery.error !== null;
  useEffect(() => {
    if (tab !== null) return;
    if (status !== null) setTab(status.manifest ? 'load' : 'extract');
    else if (statusFailed) setTab('extract');
  }, [tab, status, statusFailed, setTab]);

  useEffect(() => {
    if (manifestQuery.data) setManifest(manifestQuery.data.manifest);
  }, [manifestQuery.data, setManifest]);

  // The tabs ask for these once per answer they get. Made anew on every
  // render, a callback changed with every status the page read, and the tab
  // asked again: one load's answer set the page asking for the status for as
  // long as it was open.
  const { refetch: refetchStatus } = statusQuery;
  const { refetch: refetchManifest } = manifestQuery;
  const refetchStatusAndManifest = useCallback(() => {
    refetchStatus();
    refetchManifest();
  }, [refetchStatus, refetchManifest]);

  /*
   * No org at all. With orgs but none selected the page opens: each tab
   * picks its own org, the source on Extract and the target on Load. It said
   * "No org connected" and "Select an Org" then, and that opened
   * Organizations, where nothing was missing.
   */
  if (orgs.length === 0) {
    return (
      <EmptyState
        icon={<Snowflake className="w-10 h-10" />}
        title={t('frozen.emptyState.title')}
        description={t('frozen.emptyState.description')}
        actionLabel={t('frozen.emptyState.cta')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  const recordCount =
    status?.manifest?.volumetry.measured != null
      ? Object.values(status.manifest.volumetry.measured).reduce((sum, n) => sum + n, 0)
      : 0;
  const frozenOn = formatStoredDate(status?.manifest?.frozenAt, (date) => formatDate(date));

  /*
   * The last verification of the org the Load tab loads into, as it picks
   * it: each org keeps its own. Kept as one, the strip showed the verdict of
   * whichever org was verified last beside another picked as the target.
   * Before a target is picked — the tab no longer takes the side panel's org,
   * the dataset's source as often as not — the latest of any org, named.
   */
  const lastVerify = targetOrgId
    ? status?.lastVerifies.find((verify) => verify.orgId === targetOrgId)
    : status?.lastVerifies.reduce<FrozenLastVerifyInfo | undefined>(
        (latest, verify) =>
          latest === undefined || verify.measuredAt > latest.measuredAt ? verify : latest,
        undefined,
      );
  const verifiedOrg = targetOrgId || lastVerify?.orgId;
  const targetAlias = orgDisplayName(orgs.find((org) => org.id === verifiedOrg)) || undefined;

  /*
   * The salt keys every pseudonym an extraction writes. A load replays the
   * dataset files as they are and never reads it, but an extraction run with a
   * different salt gives the same records other pseudonyms than this dataset
   * holds — silently, since nothing fails.
   */
  const saltMismatch =
    status?.salt.present === true &&
    status.salt.fingerprint != null &&
    status.manifest != null &&
    status.salt.fingerprint !== status.manifest.saltFingerprint;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="frozen-page">
      <PageHeader title={t('nav.frozen')} subtitle={t('frozen.subtitle')} icon="snowflake" />
      <ModuleHowTo module="frozen" />

      {saltMismatch && status?.manifest && (
        <div
          className="rounded-sm border border-(--sf-warning) px-4 py-2 text-xs text-status-warning"
          role="alert"
          data-testid="frozen-salt-mismatch"
        >
          {t('frozen.status.saltMismatch', {
            current: status.salt.fingerprint,
            manifest: status.manifest.saltFingerprint,
          })}
        </div>
      )}

      {/* Status strip: the dataset first, the salt, which a load never
          needs, last. The day it was frozen is said here, on both tabs: it
          was an ISO string under the Extract tab alone. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="frozen-status-strip">
        <KPICard
          icon="database"
          label={t('frozen.status.dataset')}
          value={status?.manifest ? `v${status.manifest.version}` : '—'}
          subtitle={
            status?.manifest
              ? frozenOn === null
                ? t('frozen.status.records', { count: recordCount })
                : t('frozen.status.recordsFrozenOn', { count: recordCount, date: frozenOn })
              : t('frozen.status.noDataset')
          }
          variant={status?.manifest ? 'default' : 'warning'}
        />
        <KPICard
          icon="list-selection"
          label={t('frozen.status.selection')}
          value={status?.selection ? String(status.selection.rootCount) : '—'}
          subtitle={
            status?.selection
              ? `${status.selection.total} / ${status.selection.budgetMax}`
              : t('frozen.status.noSelection')
          }
        />
        <KPICard
          icon="verified"
          label={t('frozen.status.lastVerify')}
          value={lastVerify ? t(`frozen.verify.status.${lastVerify.status}`) : '—'}
          subtitle={targetAlias}
          variant={lastVerify?.status === 'passed' ? 'success' : lastVerify ? 'error' : 'default'}
        />
        {/* The salt is made on the first extraction and kept in VS Code's
            secret storage: none yet is no fault, and a load never needs it.
            It used to read "Salt missing", in warning colours, until an
            environment variable was set before VS Code started. */}
        <KPICard
          icon="key"
          label={t('frozen.status.salt')}
          value={
            status?.salt.present ? (status.salt.fingerprint ?? '') : t('frozen.status.saltMissing')
          }
          subtitle={
            status?.salt.source === 'environment'
              ? t('frozen.status.saltFromEnvironment')
              : status?.salt.present
                ? t('frozen.status.saltKept')
                : t('frozen.status.saltMadeOnExtraction')
          }
          variant={status?.salt.present ? 'success' : 'default'}
        />
      </div>

      <PageTabs
        tabs={[
          { id: 'extract', label: t('frozen.tabs.extract'), icon: 'export' },
          { id: 'load', label: t('frozen.tabs.load'), icon: 'cloud-upload' },
        ]}
        activeTab={tab ?? ''}
        onTabChange={(id) => setTab(id as FrozenTab)}
      />

      {tab === 'extract' && <FrozenExtractTab onRefetchStatus={refetchStatusAndManifest} />}
      {tab === 'load' && (
        <PartBoundary>
          <Suspense fallback={null}>
            <LoadedFrozenLoadTab onRefetchStatus={refetchStatus} />
          </Suspense>
        </PartBoundary>
      )}
    </div>
  );
};
