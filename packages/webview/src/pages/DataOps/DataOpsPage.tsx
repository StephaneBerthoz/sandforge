import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import type { BackupResult, AnonymizationTemplate } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import type { PageTab } from '../../components/ui/PageTabs';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Skeleton } from '../../components/ui/Skeleton';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { BackupPanel } from './BackupPanel';
import { RestorePanel } from './RestorePanel';
import { AnonymizePanel } from './AnonymizePanel';
import { CleanupPanel } from './CleanupPanel';
import { QualityDashboard } from './QualityDashboard';
import { GDPRPanel } from './GDPRPanel';

/** Main DataOps page — wired to extension via bridge hooks. */
export const DataOpsPage: React.FC = () => {
  const { t } = useTranslation();

  const DATAOPS_TABS: PageTab[] = [
    { id: 'backup', label: t('dataops.backup'), icon: 'archive' },
    { id: 'restore', label: t('dataops.restore'), icon: 'discard' },
    { id: 'anonymize', label: t('dataops.anonymize'), icon: 'eye-closed' },
    { id: 'gdpr', label: t('dataops.compliance'), icon: 'shield' },
    { id: 'cleanup', label: t('dataops.cleanup'), icon: 'trash' },
    { id: 'quality', label: t('dataops.quality'), icon: 'checklist' },
  ];
  const orgs = useOrgStore((s) => s.orgs);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [activeTab, setActiveTab] = useState('backup');
  const [selectedBackupId, setSelectedBackupId] = useState<string>('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  // Local UI state
  const [error, setError] = useState<string | null>(null);

  /** Bridge query: load saved backups. */
  const backupsQuery = useBridgeQuery<{ backups: BackupResult[] }>('backup:list', undefined, {
    responseType: 'backup:list:result',
    // DataOpsHandler reports failures on the dataops domain channel.
    errorType: 'dataops:error',
  });

  /** Bridge mutation: create a backup. */
  const backupMutation = useBridgeMutation<Record<string, unknown>>('backup:execute', {
    responseType: 'dataops:backup:response',
    errorType: 'dataops:error',
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  /** Bridge mutation: anonymize data. */
  const anonymizeMutation = useBridgeMutation<Record<string, unknown>>('dataops:anonymize', {
    responseType: 'dataops:anonymize:response',
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  /** Bridge query: load anonymization templates. */
  const templatesQuery = useBridgeQuery<{ templates: AnonymizationTemplate[] }>(
    'dataops:anonymization-templates',
    undefined,
    { responseType: 'dataops:anonymization-templates:response' },
  );

  // Derive backups from bridge query + mutation results
  const backups = backupsQuery.data?.backups ?? [];

  /** Show error notifications from bridge hooks. */
  useEffect(() => {
    const bridgeError =
      backupsQuery.error ?? backupMutation.error ?? anonymizeMutation.error ?? templatesQuery.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({
        level: 'error',
        title: t('dataops.title'),
        message: bridgeError,
        autoDismissMs: 5000,
      });
    }
  }, [
    backupsQuery.error,
    backupMutation.error,
    anonymizeMutation.error,
    templatesQuery.error,
    addNotification,
    t,
  ]);

  const handleCreateBackup = () => {
    const firstOrg = orgs[0];
    if (!firstOrg) return;
    setError(null);
    backupMutation.mutate({
      orgId: firstOrg.id,
      objects: ['Account', 'Contact'],
    });
  };

  const handleRestore = (operationId: string) => {
    const firstOrg = orgs[0];
    if (!firstOrg) return;
    setError(null);
    void operationId;
    // Restore uses the same backup:execute pattern — could be extended
  };

  const handleApplyAnonymize = (templateId: string) => {
    const firstOrg = orgs[0];
    if (!firstOrg) return;
    setError(null);
    anonymizeMutation.mutate({
      orgId: firstOrg.id,
      templateId,
    });
  };

  const navigate = useAppStore((s) => s.navigate);

  if (orgs.length === 0) {
    return (
      <EmptyState
        module="dataops"
        title={t('dataops.emptyState.title')}
        description={t('dataops.emptyState.description')}
        steps={[
          t('emptyState.connectViaSfdx'),
          t('dataops.emptyState.step2'),
          t('dataops.emptyState.step3'),
          t('dataops.emptyState.step4'),
        ]}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  const recordsProcessed = backups.reduce((sum, b) => sum + b.totalRecords, 0);
  const failedObjects = backups.reduce(
    (sum, b) => sum + b.objectResults.filter((r) => r.status === 'failure').length,
    0,
  );
  const totalObjects = backups.reduce((sum, b) => sum + b.objectResults.length, 0);
  const errorRate = totalObjects > 0 ? ((failedObjects / totalObjects) * 100).toFixed(1) : '0.0';
  const templateCount = templatesQuery.data?.templates?.length ?? 0;

  return (
    <m.div
      className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]"
      data-testid="dataops-page"
      variants={fadeIn}
      initial="hidden"
      animate="visible"
    >
      <PageHeader title={t('dataops.title')} subtitle={t('dataops.selectOrg')} icon="tools" />

      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} data-testid="dataops-error" />
      )}

      {/* KPI summary row */}
      <m.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        data-testid="dataops-kpi-row"
      >
        <BentoGrid columns={3} gap="md">
          <m.div variants={slideUp}>
            <KPICard
              icon="archive"
              label={t('dataops.recordsProcessed')}
              value={recordsProcessed.toLocaleString()}
              variant="default"
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="warning"
              label={t('dataops.errorRate')}
              value={`${errorRate}%`}
              variant={Number(errorRate) > 5 ? 'error' : 'success'}
            />
          </m.div>
          <m.div variants={slideUp}>
            <KPICard
              icon="eye-closed"
              label={t('dataops.anonymizedFields')}
              value={templateCount}
              variant="default"
            />
          </m.div>
        </BentoGrid>
      </m.div>

      <PageTabs tabs={DATAOPS_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <BentoTile className="p-0">
        <div className="p-4" data-testid="dataops-content">
          {(backupsQuery.loading || templatesQuery.loading) && (
            <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="dataops-skeleton">
              <Skeleton variant="text" width="30%" height="1em" />
              <Skeleton variant="rect" height="120px" />
              <Skeleton variant="text" width="50%" height="1em" />
              <Skeleton variant="rect" height="80px" />
            </div>
          )}

          {activeTab === 'backup' && !backupsQuery.loading && (
            <BackupPanel backups={backups} onCreate={handleCreateBackup} />
          )}

          {activeTab === 'restore' && (
            <RestorePanel
              backups={backups}
              selectedBackupId={selectedBackupId}
              onSelectBackup={setSelectedBackupId}
              onRestore={handleRestore}
            />
          )}

          {activeTab === 'anonymize' && (
            <AnonymizePanel
              templates={templatesQuery.data?.templates ?? []}
              selectedTemplateId={selectedTemplateId}
              onSelectTemplate={setSelectedTemplateId}
              onPreview={handleApplyAnonymize}
              onApply={handleApplyAnonymize}
            />
          )}

          {activeTab === 'gdpr' && <GDPRPanel />}

          {activeTab === 'cleanup' && <CleanupPanel recommendations={[]} />}

          {activeTab === 'quality' && <QualityDashboard results={[]} />}
        </div>
      </BentoTile>
    </m.div>
  );
};
