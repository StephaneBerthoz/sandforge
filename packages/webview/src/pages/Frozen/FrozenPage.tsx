import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Snowflake } from 'lucide-react';
import type { FrozenManifestInfo, FrozenStatusInfo } from '@sandforge/shared';
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
import { FrozenLoadTab } from './FrozenLoadTab';

/**
 * Frozen Reference Dataset page — extract a pseudonymized reference dataset
 * once, replay it identically into refreshed dev sandboxes, verify it.
 */
export const FrozenPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);
  const tab = useFrozenStore((s) => s.tab);
  const setTab = useFrozenStore((s) => s.setTab);
  const status = useFrozenStore((s) => s.status);
  const setStatus = useFrozenStore((s) => s.setStatus);
  const setManifest = useFrozenStore((s) => s.setManifest);
  const manifest = useFrozenStore((s) => s.manifest);

  useFrozenPushChannels();

  const statusQuery = useBridgeQuery<{ status: FrozenStatusInfo }>('frozen:status');
  const manifestQuery = useBridgeQuery<{ manifest: FrozenManifestInfo | null }>(
    'frozen:manifest:get',
  );

  useEffect(() => {
    if (statusQuery.data?.status) setStatus(statusQuery.data.status);
  }, [statusQuery.data, setStatus]);

  useEffect(() => {
    if (manifestQuery.data) setManifest(manifestQuery.data.manifest);
  }, [manifestQuery.data, setManifest]);

  if (!selectedOrgId || orgs.length === 0) {
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

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="frozen-page">
      <PageHeader title={t('nav.frozen')} subtitle={t('frozen.subtitle')} icon="snowflake" />

      {/* Status strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="frozen-status-strip">
        <KPICard
          icon="key"
          label={t('frozen.status.salt')}
          value={
            status?.salt.present ? (status.salt.fingerprint ?? '') : t('frozen.status.saltMissing')
          }
          variant={status?.salt.present ? 'success' : 'warning'}
        />
        <KPICard
          icon="database"
          label={t('frozen.status.dataset')}
          value={status?.manifest ? `v${status.manifest.version}` : '—'}
          subtitle={
            status?.manifest
              ? t('frozen.status.records', { count: recordCount })
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
          value={status?.lastVerify ? t(`frozen.verify.status.${status.lastVerify.status}`) : '—'}
          variant={
            status?.lastVerify?.status === 'passed'
              ? 'success'
              : status?.lastVerify
                ? 'error'
                : 'default'
          }
        />
      </div>

      <PageTabs
        tabs={[
          { id: 'extract', label: t('frozen.tabs.extract'), icon: 'export' },
          { id: 'load', label: t('frozen.tabs.load'), icon: 'cloud-upload' },
        ]}
        activeTab={tab}
        onTabChange={(id) => setTab(id as 'extract' | 'load')}
      />

      {tab === 'extract' && (
        <FrozenExtractTab
          onRefetchStatus={() => {
            statusQuery.refetch();
            manifestQuery.refetch();
          }}
        />
      )}
      {tab === 'load' && <FrozenLoadTab onRefetchStatus={() => statusQuery.refetch()} />}
      {manifest && tab === 'extract' && (
        <p className="text-[10px] text-text-muted" data-testid="frozen-manifest-footnote">
          {t('frozen.manifest.version', { version: manifest.version })} — {manifest.frozenAt}
        </p>
      )}
    </div>
  );
};
