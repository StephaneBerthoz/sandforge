import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import type {
  BackupDeleteResult,
  BackupExportResult,
  BackupObjectsResponse,
  BackupSummary,
  DataOpsAnonymizeCoverageResponse,
  DataOpsAnonymizePreviewResponse,
  ListedAnonymizationTemplate,
} from '@sandforge/shared';
import { useOrgStore, selectSelectedOrg } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import type { PageTab } from '../../components/ui/PageTabs';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { Skeleton } from '../../components/ui/Skeleton';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { fadeIn, staggerContainer, slideUp } from '../../motion/presets';
import { BackupPanel } from './BackupPanel';
import { RestorePanel, type RestoreCounts } from './RestorePanel';
import { AnonymizePanel } from './AnonymizePanel';
import { QualityPanel } from './QualityPanel';
import { CompliancePanel } from './CompliancePanel';
import { CleanupPanel } from './CleanupPanel';
import type { AnonymizationTemplateDraft } from './AnonymizationTemplateEditor';
import { formatNumber, uiLocale } from '../../utils/formatters';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';

/**
 * The objects templates mask, in the order their rules first name them: those
 * a masking run of each addresses.
 */
function maskedObjects(templates: readonly ListedAnonymizationTemplate[]): string[] {
  return templates
    .flatMap((tpl) => tpl.rules.map((rule) => rule.fieldPattern.split('.')[0]))
    .filter((name, i, all) => name !== '' && name !== '*' && all.indexOf(name) === i);
}

/**
 * The snapshot a masking run's answer names, which Restore puts back, or
 * none: a run asked for without one, or that masked nothing.
 */
function readSnapshot(
  answer: Record<string, unknown> | null,
): { operationId: string; totalRecords: number } | null {
  const snapshot = answer?.snapshot;
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const { operationId, totalRecords } = snapshot as Record<string, unknown>;
  return typeof operationId === 'string' && typeof totalRecords === 'number'
    ? { operationId, totalRecords }
    : null;
}

/** What Backup read whatever the templates masked, kept for an org that lists none. */
const DEFAULT_BACKUP_OBJECTS = ['Account', 'Contact'];

/**
 * What a restore of a Sync run's backup left as it is, changed since the run,
 * as its answer says it (`DataOpsRollbackResponse.keptChanged`); undefined
 * when it left nothing, or the answer does not say it in that shape.
 */
function keptChangedOf(value: unknown): RestoreCounts['keptChanged'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const { objects, runNotKept } = value as { objects?: unknown; runNotKept?: unknown };
  if (!Array.isArray(objects)) return undefined;
  const counted = objects.flatMap((object: unknown) => {
    const { objectApiName, count } = (object ?? {}) as { objectApiName?: unknown; count?: unknown };
    return typeof objectApiName === 'string' && typeof count === 'number' && count > 0
      ? [{ objectApiName, count }]
      : [];
  });
  if (counted.length === 0) return undefined;
  return { objects: counted, ...(runNotKept === true ? { runNotKept: true } : {}) };
}

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
  // The org the user actually picked — the same reactive selector MonitorPage
  // and the rest of the product read.
  const currentOrg = useOrgStore(selectSelectedOrg);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [activeTab, setActiveTab] = useState('backup');
  const [selectedBackupId, setSelectedBackupId] = useState<string>('');
  /** A restore writes every row back rather than the rows that changed since the backup. */
  const [rewriteAll, setRewriteAll] = useState(false);
  /** A restore of a Sync run's backup writes the records changed since the run too. */
  const [includeChanged, setIncludeChanged] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  // Local UI state
  const [error, setError] = useState<string | null>(null);

  /** Bridge query: load saved backups. */
  // The request type was declared in no Zod member, so the broker rejected the
  // message and this query never resolved — the list stayed empty and the KPI
  // row read 0 until the 30 s timeout turned it into an error banner.
  const backupsQuery = useBridgeQuery<{ backups: BackupSummary[] }>(
    'backup:list',
    currentOrg ? { orgId: currentOrg.id } : undefined,
    {
      responseType: 'backup:list:result',
      // DataOpsHandler reports failures on the dataops domain channel.
      errorType: 'dataops:error',
      skip: !currentOrg,
    },
  );

  /** Bridge mutation: create a backup. */
  const backupMutation = useBridgeMutation<Record<string, unknown>>('backup:execute', {
    responseType: 'dataops:backup:response',
    errorType: 'dataops:error',
    // A backup reads every page of each object, up to the cap of rows per
    // object (fifty thousand unless the setting says otherwise), so a large
    // org takes many minutes; operation:progress events keep flowing while
    // the response is pending. It answers once it ends, as every write run
    // does, and a wait that ends first says where it is, not to try again.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  /** Bridge mutation: restore a backup (dataops:rollback). */
  const rollbackMutation = useBridgeMutation<Record<string, unknown>>('dataops:rollback', {
    responseType: 'dataops:rollback:response',
    errorType: 'dataops:error',
    // Upserts every backed-up record in 200-row batches, as many as the
    // backup's cap of rows per object; the 30 s default is far too short.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  /**
   * Bridge mutation: export one backup. The host asks where, writes the file
   * a batch of records at a time, and answers where it went and how many
   * records of each object it holds — or that the dialog was dismissed.
   */
  const exportMutation = useBridgeMutation<BackupExportResult['payload']>('backup:export', {
    responseType: 'backup:export:result',
    errorType: 'dataops:error',
    // The Save dialog waits on the user, and a backup holds up to its cap of
    // rows per object, as many as a million: the 30 s default would call an
    // export failed while the host was still writing it.
    timeoutMs: 60 * 60_000,
  });

  /** Bridge mutation: delete backups of the org from this machine. */
  const deleteBackupsMutation = useBridgeMutation<BackupDeleteResult['payload']>('backup:delete', {
    responseType: 'backup:delete:result',
    errorType: 'dataops:error',
  });

  /** Bridge mutation: anonymize data. */
  const anonymizeMutation = useBridgeMutation<Record<string, unknown>>('dataops:anonymize', {
    responseType: 'dataops:anonymize:response',
    // A run masks every row of every object, page by page, so a large object
    // takes many minutes; operation:progress events keep flowing while the
    // response is pending. Two minutes showed a timeout while the run went on.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  /*
   * The Stop of each run the page started: the extension runs a backup, a
   * restore and a masking run under the id of the request that started it,
   * and `execution:abort` with that id stops it before its next page or
   * batch, as Live Operations' Cancel does. The tabs had none.
   */
  const cancelRefused = {
    title: t('common.runCancelRefused'),
    message: t('common.runCancelRefusedDetail'),
  };
  const backupStop = useOperationCancel(
    backupMutation.loading ? backupMutation.requestId : null,
    cancelRefused,
  );
  const restoreStop = useOperationCancel(
    rollbackMutation.loading ? rollbackMutation.requestId : null,
    cancelRefused,
  );
  const anonymizeStop = useOperationCancel(
    anonymizeMutation.loading ? anonymizeMutation.requestId : null,
    cancelRefused,
  );

  /**
   * Bridge query: load anonymization templates.
   *
   * Typed on what the host sends, `ListedAnonymizationTemplate`: it was typed
   * on the domain `AnonymizationTemplate`, whose rules carry `fieldApiName`
   * and `method`, and the rules on screen named no field.
   */
  const templatesQuery = useBridgeQuery<{ templates: ListedAnonymizationTemplate[] }>(
    'dataops:anonymization-templates',
    undefined,
    { responseType: 'dataops:anonymization-templates:response' },
  );

  /**
   * Bridge query: the objects Create Backup reads in the org — those a masking
   * run of the picked template plans there, or of every template listed.
   */
  const backupObjectsQuery = useBridgeQuery<BackupObjectsResponse['payload']>(
    'backup:objects',
    currentOrg
      ? { orgId: currentOrg.id, ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}) }
      : undefined,
    {
      responseType: 'backup:objects:response',
      errorType: 'dataops:error',
      skip: !currentOrg,
    },
  );

  /**
   * Bridge query: for the selected template, each object's rows in the org
   * against those its latest backup holds — what a restore can bring back,
   * said before Apply masks every row. Asked again whenever the tab opens, so
   * a backup taken meanwhile is counted.
   */
  const coverageQuery = useBridgeQuery<DataOpsAnonymizeCoverageResponse['payload']>(
    'dataops:anonymize:coverage',
    currentOrg && selectedTemplateId
      ? { orgId: currentOrg.id, templateId: selectedTemplateId }
      : undefined,
    {
      responseType: 'dataops:anonymize:coverage:response',
      errorType: 'dataops:error',
      skip: !currentOrg || !selectedTemplateId || activeTab !== 'anonymize',
    },
  );

  /**
   * Bridge mutation: the first rows of each object the selected template
   * masks, original beside masked, as Apply would write them. Reads only.
   */
  const previewMutation = useBridgeMutation<DataOpsAnonymizePreviewResponse['payload']>(
    'dataops:anonymize:preview',
    {
      responseType: 'dataops:anonymize:preview:response',
      errorType: 'dataops:error',
      // A describe and one short page per object the template masks.
      timeoutMs: 120_000,
    },
  );

  /** Bridge mutation: save rules as a template of the user's, kept in extension storage. */
  const saveTemplateMutation = useBridgeMutation<{ template: ListedAnonymizationTemplate }>(
    'dataops:anonymization-template:save',
    { responseType: 'dataops:anonymization-template:save:response', errorType: 'dataops:error' },
  );

  /** Bridge mutation: delete a template the user saved. */
  const deleteTemplateMutation = useBridgeMutation<{ templateId: string; deleted: boolean }>(
    'dataops:anonymization-template:delete',
    { responseType: 'dataops:anonymization-template:delete:response', errorType: 'dataops:error' },
  );

  // Derive backups from bridge query + mutation results
  const backups = backupsQuery.data?.backups ?? [];

  // What Backup reads: the objects the picked template masks, or, with none
  // picked, every object a listed template masks — what an Anonymize writes
  // over. It read Account and Contact whatever the templates masked, and the
  // shipped ones also mask Lead and Opportunity, which never had a backup.
  //
  // The host says which, as a masking run plans them in the org: Account
  // too, for a template that masks contacts in an org with person accounts,
  // which the rules do not name. Until it answers, the rules' objects.
  const templates = templatesQuery.data?.templates ?? [];
  const pickedTemplate = templates.find((tpl) => tpl.id === selectedTemplateId);
  const templateObjects = maskedObjects(pickedTemplate ? [pickedTemplate] : templates);
  const plannedObjects = backupObjectsQuery.data?.objects ?? templateObjects;
  const backupObjects = plannedObjects.length > 0 ? plannedObjects : DEFAULT_BACKUP_OBJECTS;

  // A run that stopped short leaves a checkpoint to resume, and one that
  // finished forgets it: the coverage answer says which, so it is asked again
  // once a run ends, however it ends.
  const refetchCoverage = useLatestRef(() => coverageQuery.refetch());
  const anonymizeEnded = anonymizeMutation.data ?? anonymizeMutation.error;
  useEffect(() => {
    if (anonymizeEnded) refetchCoverage.current();
  }, [anonymizeEnded, refetchCoverage]);

  // The snapshot a run took before it masked is a backup of the org: listed
  // once the run ends, so Restore offers it.
  const anonymizeAnswer = anonymizeMutation.data;
  const anonymizeSnapshot = useMemo(() => readSnapshot(anonymizeAnswer), [anonymizeAnswer]);
  const refetchBackupsOnSnapshot = useLatestRef(() => backupsQuery.refetch());
  useEffect(() => {
    if (anonymizeSnapshot) refetchBackupsOnSnapshot.current();
  }, [anonymizeSnapshot, refetchBackupsOnSnapshot]);

  // A backup that ends, however it ends, is listed: one that stopped at the
  // cap, or whose read failed part-way, says so in the list, and the list was
  // only asked for when the page opened.
  const refetchBackups = useLatestRef(() => backupsQuery.refetch());
  const backupEnded = backupMutation.data ?? backupMutation.error;
  useEffect(() => {
    if (backupEnded) refetchBackups.current();
  }, [backupEnded, refetchBackups]);

  // A preview shows an org's own records: it does not stay on screen under
  // the name of the next org picked.
  const resetPreview = useLatestRef(() => previewMutation.reset());
  const orgId = currentOrg?.id;
  useEffect(() => {
    resetPreview.current();
  }, [orgId, resetPreview]);

  /** Show error notifications from bridge hooks. */
  useEffect(() => {
    const bridgeError =
      backupsQuery.error ??
      backupMutation.error ??
      // A failed rollback used to be swallowed here: the restore silently did
      // nothing and the page looked exactly as it does on success.
      rollbackMutation.error ??
      exportMutation.error ??
      deleteBackupsMutation.error ??
      anonymizeMutation.error ??
      previewMutation.error ??
      templatesQuery.error ??
      saveTemplateMutation.error ??
      deleteTemplateMutation.error;
    if (bridgeError) {
      setError(bridgeError);
      addNotification({
        level: 'error',
        title: t('dataops.title'),
        message: bridgeError,
      });
    }
  }, [
    backupsQuery.error,
    backupMutation.error,
    rollbackMutation.error,
    exportMutation.error,
    deleteBackupsMutation.error,
    anonymizeMutation.error,
    previewMutation.error,
    templatesQuery.error,
    saveTemplateMutation.error,
    deleteTemplateMutation.error,
    addNotification,
    t,
  ]);

  // A saved template is listed and picked, so Apply is one click away. The
  // list is asked for again rather than patched: the host is what lists it.
  // Each answer is taken up once: the effects below run on the answer alone.
  const adoptSavedTemplate = useLatestRef((template: ListedAnonymizationTemplate) => {
    templatesQuery.refetch();
    setSelectedTemplateId(template.id);
    addNotification({
      level: 'success',
      title: t('dataops.title'),
      message: t('dataops.templateSaved', { name: template.name }),
      autoDismissMs: 3000,
    });
  });
  const saved = saveTemplateMutation.data;
  useEffect(() => {
    if (saved) adoptSavedTemplate.current(saved.template);
  }, [saved, adoptSavedTemplate]);

  const forgetDeletedTemplate = useLatestRef((templateId: string) => {
    templatesQuery.refetch();
    // With none picked, Backup reads what every template listed masks.
    backupObjectsQuery.refetch();
    setSelectedTemplateId((current) => (current === templateId ? '' : current));
  });
  const deleted = deleteTemplateMutation.data;
  useEffect(() => {
    if (deleted) forgetDeletedTemplate.current(deleted.templateId);
  }, [deleted, forgetDeletedTemplate]);

  // Both handlers previously targeted `orgs[0]` — the first org in the list,
  // not the one the user selected — while the page header read "Select Org".
  // Backup and anonymize both write to the org, so a user with several
  // connections was anonymising a different org than the one on screen.
  const handleCreateBackup = () => {
    if (!currentOrg) return;
    setError(null);
    backupMutation.mutate({
      orgId: currentOrg.id,
      objects: backupObjects,
    });
  };

  // `dataops:rollback` has been implemented, routed and unit-tested on the
  // extension side all along — CRUD/FLS guard, 200-record upsert batching, api
  // limit checks, progress events — and nothing had ever sent it. The Restore
  // button voided its argument behind a comment saying it "could be extended".
  const handleRestore = (operationId: string) => {
    if (!currentOrg) return;
    setError(null);
    rollbackMutation.mutate({
      orgId: currentOrg.id,
      operationId,
      ...(rewriteAll ? { rewriteAll: true } : {}),
      ...(includeChanged ? { includeChanged: true } : {}),
    });
  };
  /** What the last restore wrote, left alone and had refused, from its answer. */
  const restored = rollbackMutation.data;
  const keptChanged = keptChangedOf(restored?.keptChanged);
  const lastRestore =
    restored && typeof restored.totalRestored === 'number'
      ? {
          written: restored.totalRestored,
          unchanged: typeof restored.totalUnchanged === 'number' ? restored.totalUnchanged : 0,
          failed: typeof restored.totalFailed === 'number' ? restored.totalFailed : 0,
          ...(keptChanged ? { keptChanged } : {}),
        }
      : undefined;

  // dataops:backup writes record payloads into ConfigStore, which is VSCode
  // globalState: a backup lived on one laptop with no way out of it.
  const handleExportBackup = (operationId: string) => {
    if (!currentOrg) return;
    setError(null);
    exportMutation.mutate({ orgId: currentOrg.id, operationId });
  };

  /**
   * Say where the host wrote the backup, and what the file holds. The whole
   * document used to come back in one message for the page to save: every
   * record of the backup, held on both sides of the bridge at once.
   */
  useEffect(() => {
    const outcome = exportMutation.data;
    if (!outcome) return;
    // Dismissing the dialog is not news.
    if (outcome.status === 'saved') {
      addNotification({
        level: 'success',
        title: t('common.export'),
        message: t('dataops.backupExported', {
          path: outcome.path,
          records: outcome.objects
            .map((o) => `${o.objectApiName} ${formatNumber(o.records)}`)
            .join(', '),
        }),
        autoDismissMs: 6000,
      });
    }
    exportMutation.reset();
  }, [exportMutation, addNotification, t]);

  /**
   * Delete one backup of the org, or every one, from this machine. A backup
   * holds the records' values in clear, and nothing in the panel deleted one.
   */
  const handleDeleteBackups = (operationIds?: string[]) => {
    if (!currentOrg) return;
    setError(null);
    deleteBackupsMutation.mutate({
      orgId: currentOrg.id,
      ...(operationIds ? { operationIds } : {}),
    });
  };

  /** Once deleted, the list is asked for again and the deletion said. */
  useEffect(() => {
    const outcome = deleteBackupsMutation.data;
    if (!outcome) return;
    if (outcome.deleted.includes(selectedBackupId)) setSelectedBackupId('');
    refetchBackups.current();
    addNotification({
      level: 'success',
      title: t('dataops.title'),
      message: t('dataops.backupsDeleted', { count: outcome.deleted.length }),
      autoDismissMs: 4000,
    });
    deleteBackupsMutation.reset();
  }, [deleteBackupsMutation, selectedBackupId, refetchBackups, addNotification, t]);

  const handleSaveTemplate = (draft: AnonymizationTemplateDraft) => {
    setError(null);
    saveTemplateMutation.mutate({ name: draft.name, rules: draft.rules });
  };

  const handleDeleteTemplate = (templateId: string) => {
    setError(null);
    deleteTemplateMutation.mutate({ templateId });
  };

  const handlePreviewAnonymize = (templateId: string) => {
    if (!currentOrg) return;
    setError(null);
    previewMutation.mutate({ orgId: currentOrg.id, templateId });
  };

  // A run writes over the records a preview showed as they were: the preview
  // goes with it. Unless unticked, it keeps the values it masks first, as the
  // command line's runs always did: the panel's took no snapshot, and a run
  // on an org with no backup had no way back.
  const handleApplyAnonymize = (templateId: string, options: { snapshot: boolean }) => {
    if (!currentOrg) return;
    setError(null);
    previewMutation.reset();
    anonymizeMutation.mutate({
      orgId: currentOrg.id,
      templateId,
      ...(options.snapshot ? { snapshot: true } : {}),
    });
  };

  /** Open the Restore tab on the snapshot a masking run took. */
  const openRestoreOn = (operationId: string) => {
    setSelectedBackupId(operationId);
    setActiveTab('restore');
  };

  // Masks only what the run that stopped short left, from where it stopped.
  const handleResumeAnonymize = (templateId: string, resumeFrom: string) => {
    if (!currentOrg) return;
    setError(null);
    previewMutation.reset();
    anonymizeMutation.mutate({ orgId: currentOrg.id, templateId, resumeFrom });
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
  const failedObjects = backups.filter((b) => b.status === 'failed').length;
  const totalObjects = backups.reduce((sum, b) => sum + b.objectResults.length, 0);
  const errorRate = totalObjects > 0 ? ((failedObjects / totalObjects) * 100).toFixed(1) : '0.0';
  const templateCount = templates.length;

  // A tab waits only on the query it actually reads. Gating the skeleton on
  // both queries at once let a slow templates response paint a skeleton on top
  // of an already-loaded backup list; Compliance, Cleanup and Quality read
  // neither query, and each says what it waits on itself.
  //
  // And only for its first answer. The list is read again after a backup
  // ends, after a backup is deleted and after a template is saved or deleted,
  // and the skeleton took the panel's place each time: the control the
  // keyboard was on went with it — the Delete button a confirmation hands
  // focus back to — and the panel's own state, a confirmation it was asking.
  // Read again, the panel stays drawn and says it is busy.
  const tabQuery =
    activeTab === 'anonymize'
      ? templatesQuery
      : activeTab === 'backup' || activeTab === 'restore'
        ? backupsQuery
        : null;
  const tabLoading = tabQuery !== null && tabQuery.loading && tabQuery.data === null;
  const tabReading = tabQuery !== null && tabQuery.loading && tabQuery.data !== null;

  return (
    <m.div
      className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="dataops-page"
      variants={fadeIn}
      initial="hidden"
      animate="visible"
    >
      {/* The target org has to be visible before the user clicks: backup and
          anonymize both write to it, and the page previously named no org at
          all while silently acting on the first one in the list. */}
      <PageHeader
        title={t('dataops.title')}
        // "Select Org" is a prompt, not a description: showing it while an org
        // IS selected — and named by the badge two elements to the right —
        // reads as "no org chosen" on a page that is about to write to one.
        subtitle={currentOrg ? undefined : t('dataops.selectOrg')}
        icon="wrench"
        actions={
          currentOrg ? (
            <OrgBadge
              alias={currentOrg.alias || currentOrg.username}
              orgType={String(currentOrg.orgType)}
              status={currentOrg.status}
              instanceUrl={currentOrg.instanceUrl}
              staging={currentOrg.staging}
            />
          ) : undefined
        }
      />
      <ModuleHowTo module="dataops" />

      {!currentOrg && (
        <ErrorBanner message={t('dataops.noOrgSelected')} data-testid="dataops-no-org" />
      )}

      {error && (
        <ErrorBanner
          message={error}
          code={null}
          onDismiss={() => setError(null)}
          data-testid="dataops-error"
        />
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
              value={recordsProcessed.toLocaleString(uiLocale())}
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
        <div className="p-4" data-testid="dataops-content" aria-busy={tabReading || undefined}>
          {tabLoading && (
            <div className="flex flex-col gap-(--sf-space-3)" data-testid="dataops-skeleton">
              <Skeleton variant="text" width="30%" height="1em" />
              <Skeleton variant="rect" height="120px" />
              <Skeleton variant="text" width="50%" height="1em" />
              <Skeleton variant="rect" height="80px" />
            </div>
          )}

          {activeTab === 'backup' && !tabLoading && (
            <BackupPanel
              backups={backups}
              objects={backupObjects}
              template={pickedTemplate?.name}
              onCreate={handleCreateBackup}
              onExport={handleExportBackup}
              // Nothing held the button while a backup read, nor stopped it.
              isCreating={backupMutation.loading}
              onStop={backupStop.cancel}
              stopRequested={backupStop.requested}
            />
          )}

          {activeTab === 'restore' && !tabLoading && (
            <RestorePanel
              backups={backups}
              selectedBackupId={selectedBackupId}
              onSelectBackup={(operationId) => {
                // The choice is made of one backup: another starts without it.
                if (operationId !== selectedBackupId) setIncludeChanged(false);
                setSelectedBackupId(operationId);
              }}
              onRestore={handleRestore}
              // Nothing disabled the button while the upserts ran, so a second
              // click started a second restore over the first one.
              isRestoring={rollbackMutation.loading}
              rewriteAll={rewriteAll}
              onRewriteAllChange={setRewriteAll}
              includeChanged={includeChanged}
              onIncludeChangedChange={setIncludeChanged}
              lastRestore={lastRestore}
              onDelete={(operationId) => handleDeleteBackups([operationId])}
              onDeleteAll={() => handleDeleteBackups()}
              isDeleting={deleteBackupsMutation.loading}
              onStop={restoreStop.cancel}
              stopRequested={restoreStop.requested}
            />
          )}

          {activeTab === 'anonymize' && !tabLoading && (
            <AnonymizePanel
              templates={templates}
              selectedTemplateId={selectedTemplateId}
              onSelectTemplate={setSelectedTemplateId}
              onSaveTemplate={handleSaveTemplate}
              savingTemplate={saveTemplateMutation.loading}
              saveTemplateError={saveTemplateMutation.error}
              onDeleteTemplate={handleDeleteTemplate}
              // A request of its own, read-only: onPreview used to be Apply's
              // handler, and clicking "Preview" masked the org's data for real.
              onPreview={handlePreviewAnonymize}
              isPreviewing={previewMutation.loading}
              preview={previewMutation.data}
              onApply={handleApplyAnonymize}
              onResume={handleResumeAnonymize}
              // Nothing held the buttons while a run went on, so a second
              // click started a second run over the same records.
              isApplying={anonymizeMutation.loading}
              coverage={coverageQuery.data}
              onStop={anonymizeStop.cancel}
              stopRequested={anonymizeStop.requested}
              snapshotTaken={anonymizeSnapshot}
              onOpenRestore={openRestoreOn}
              snapshotRefused={anonymizeMutation.errorCode === 'SNAPSHOT_NOT_TAKEN'}
            />
          )}

          {/* Keyed by org, the three panels below: results read on one org —
              a person's records above all — must not stay on screen under the
              name of the next. */}
          {activeTab === 'gdpr' && currentOrg && (
            <CompliancePanel key={currentOrg.id} orgId={currentOrg.id} />
          )}

          {activeTab === 'cleanup' && currentOrg && (
            <CleanupPanel key={currentOrg.id} orgId={currentOrg.id} />
          )}

          {activeTab === 'quality' && currentOrg && (
            <QualityPanel key={currentOrg.id} orgId={currentOrg.id} />
          )}
        </div>
      </BentoTile>
    </m.div>
  );
};
