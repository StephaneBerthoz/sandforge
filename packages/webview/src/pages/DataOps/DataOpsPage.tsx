import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
import { isDevelopmentOrg, orgDisplayName } from '@sandforge/shared';
import type {
  BackupDeleteResult,
  BackupExportResult,
  BackupObjectsResponse,
  BackupSetSummary,
  BackupSummary,
  DataOpsAnonymizeCoverageResponse,
  DataOpsAnonymizePreviewResponse,
  ListedAnonymizationTemplate,
  SliceSetResult,
} from '@sandforge/shared';
import { useOrgStore, selectSelectedOrg } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useOperationCancel } from '../../hooks/useOperationCancel';
import { useOperationProgress } from '../../hooks/useOperationProgress';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { PageHeader } from '../../components/ui/PageHeader';
import { PageTabs } from '../../components/ui/PageTabs';
import type { PageTab } from '../../components/ui/PageTabs';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { OrgTypeBadge } from '../../components/ui/OrgBadge';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { Skeleton } from '../../components/ui/Skeleton';
import { BentoTile } from '../../components/ui/BentoGrid';
import { fadeIn } from '../../motion/presets';
import { BackupPanel, type RestoreCounts, type RestoreOptions } from './BackupPanel';
import { BackupCreate } from './BackupCreate';
import { AnonymizePanel, CleanupPanel, CompliancePanel, EmptyPanel } from './dataOpsParts';
import {
  isDataOpsTab,
  landingOf,
  maskedObjects,
  templateFor,
  type DataOpsTab,
} from './dataOpsLanding';
import type { AnonymizationTemplateDraft } from './AnonymizationTemplateEditor';
import {
  accordPayloadOf,
  ASKED_FROM_PAGE,
  type DataOpsAutomationAccord,
} from './DataOpsAutomation';
import { formatNumber } from '../../utils/formatters';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';

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

/**
 * The set of a masking run in slices, as its answer says it once it ended —
 * or as an answer that gave the set up says it —, or none: a run of no slice.
 */
function readSliceRun(
  answer: Record<string, unknown> | null,
): { result: SliceSetResult; abandoned?: boolean } | null {
  const slices = answer?.slices;
  if (typeof slices !== 'object' || slices === null) return null;
  const result = slices as Partial<SliceSetResult>;
  if (typeof result.setId !== 'string' || !Array.isArray(result.objects)) return null;
  return {
    result: slices as SliceSetResult,
    ...(answer?.abandoned === true ? { abandoned: true } : {}),
  };
}

/**
 * The objects Backup reads that hold more rows than one backup does: those
 * the masking coverage plans in more than one slice, and those the latest
 * backup holding them stopped at the cap for. A backup of them in slices
 * holds them whole; one without, the rows up to the cap.
 */
function pastOneBackup(
  objects: readonly string[],
  backups: readonly BackupSummary[],
  coverage: DataOpsAnonymizeCoverageResponse['payload'] | null,
): string[] {
  const latest = [...backups].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return objects.filter((name) => {
    const planned = coverage?.objects.find((o) => o.objectApiName === name)?.slicePlan;
    if (planned && planned.slices > 1) return true;
    const held = latest.flatMap((b) => b.objectResults).find((o) => o.objectApiName === name);
    return held?.stoppedAt === 'cap';
  });
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

/**
 * Of a restore of a set of slices, the slices it wrote back and those it
 * did not read again, restored before, as its answer lists them; undefined
 * for a restore of no set.
 */
function restoredSlicesOf(value: unknown): RestoreCounts['slices'] {
  if (!Array.isArray(value)) return undefined;
  const indexes = (skipped: boolean): number[] =>
    value.flatMap((slice: unknown) => {
      const { index, skipped: was } = (slice ?? {}) as { index?: unknown; skipped?: unknown };
      return typeof index === 'number' && (was === true) === skipped ? [index] : [];
    });
  return { restored: indexes(false), skipped: indexes(true) };
}

/**
 * The objects asked to be masked as Masking opened — those a refresh copied
 * from production, as Back into service names them —, and the ones the
 * template picked for them leaves unmasked.
 */
const MaskAsked: React.FC<{
  objects: readonly string[];
  org: string;
  template: ListedAnonymizationTemplate | undefined;
}> = ({ objects, org, template }) => {
  const { t } = useTranslation();
  const masked = template ? maskedObjects([template]) : [];
  const left = objects.filter((name) => !masked.includes(name));
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary"
      role="note"
      data-testid="mask-asked"
    >
      <p>{t('dataops.maskAsked.lead', { org, objects: objects.join(', ') })}</p>
      {left.length > 0 && (
        <p data-testid="mask-asked-left">
          {template
            ? t('dataops.maskAsked.notMasked', { name: template.name, objects: left.join(', ') })
            : t('dataops.maskAsked.noTemplate', { objects: left.join(', ') })}
        </p>
      )}
    </div>
  );
};

/** Main DataOps page — wired to extension via bridge hooks. */
export const DataOpsPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  // The org the user actually picked — the same reactive selector MonitorPage
  // and the rest of the product read.
  const currentOrg = useOrgStore(selectSelectedOrg);
  const orgName = currentOrg ? orgDisplayName(currentOrg) : undefined;
  const selectOrgLocal = useOrgStore((s) => s.selectOrg);
  // The org picked here is the org picked everywhere, as Checkpoints' own
  // picker does: the status bar, the sidebar and the other panels follow it.
  // The header showed the org as a badge, and the page with no org sent the
  // user to the Organizations page to pick one.
  const selectOrg = useCallback(
    (id: string) => {
      selectOrgLocal(id);
      sendBridgeMessage('org:select', { orgId: id });
    },
    [selectOrgLocal],
  );
  const addNotification = useNotificationStore((s) => s.addNotification);

  // Where the navigation asked the page to open, read once: a tab by its id;
  // Emptying with the objects Forge's Review of a clone of the whole org, or
  // Quick Sync's refusal, asks to empty first; Masking with the objects Back
  // into service asks to mask. Objects are taken for the org selected alone.
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  const [landing] = useState(() => landingOf(navigationIntent, currentOrg?.id));
  useEffect(() => {
    if (navigationIntent?.route === 'dataops') clearNavigationIntent();
  }, [navigationIntent, clearNavigationIntent]);
  const [activeTab, setActiveTab] = useState<DataOpsTab>(landing.tab);
  /**
   * Whether Emptying, opened by the navigation, brings its first section into
   * view and gives it the focus: arrived from Forge, the objects picked sat
   * below the Cleanup scan, off screen at 1280×800, and nothing moved to them.
   * Once, as the page opens.
   */
  const [emptyingLanded, setEmptyingLanded] = useState(landing.tab === 'emptying');
  const changeTab = (id: string): void => {
    if (!isDataOpsTab(id)) return;
    setEmptyingLanded(false);
    setActiveTab(id);
  };
  /** The backup or set a masking run's result opened Backups on. */
  const [openedBackupId, setOpenedBackupId] = useState<string>('');
  /**
   * The template picked, or none yet: then, with objects asked to be masked,
   * the one that masks them (`templateFor`), as soon as the templates are
   * listed.
   */
  const [pickedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // Local UI state
  const [error, setError] = useState<string | null>(null);

  /** Bridge query: load saved backups. */
  // The request type was declared in no Zod member, so the broker rejected the
  // message and this query never resolved — the list stayed empty and the KPI
  // row read 0 until the 30 s timeout turned it into an error banner.
  const backupsQuery = useBridgeQuery<{ backups: BackupSummary[]; sets?: BackupSetSummary[] }>(
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

  /**
   * Bridge mutation: give up the run in slices of a template left open on the
   * org. It masks nothing and writes nothing to the org: its answer is the
   * set, given up.
   */
  const abandonMutation = useBridgeMutation<Record<string, unknown>>('dataops:anonymize', {
    responseType: 'dataops:anonymize:response',
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
   * Where the masking run is, as the extension reports it under the id of the
   * request that started it: of a run in slices, which can take hours, the
   * slice and its phase. The tab said nothing but Stop while a run went.
   */
  const { getProgress } = useOperationProgress();
  const anonymizeReported =
    anonymizeMutation.loading && anonymizeMutation.requestId
      ? getProgress(anonymizeMutation.requestId)
      : undefined;
  const anonymizeProgress = anonymizeReported
    ? { percentage: anonymizeReported.percentage, step: anonymizeReported.currentStep }
    : null;

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
  const templates = templatesQuery.data?.templates ?? [];
  // The objects asked to be masked are the selected org's alone: another org
  // picked since takes them off the tab.
  const maskAsked =
    landing.mask && landing.mask.orgId === currentOrg?.id ? landing.mask : undefined;
  const selectedTemplateId =
    pickedTemplateId ?? (maskAsked ? (templateFor(templates, maskAsked.objects) ?? '') : '');

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
  // The sets of slices of the org, one entry each: a slice is restored and
  // deleted with its set, and is listed in none of the backups.
  const sets = useMemo(() => backupsQuery.data?.sets ?? [], [backupsQuery.data]);

  // What Backup reads: the objects the picked template masks, or, with none
  // picked, every object a listed template masks — what an Anonymize writes
  // over. It read Account and Contact whatever the templates masked, and the
  // shipped ones also mask Lead and Opportunity, which never had a backup.
  //
  // The host says which, as a masking run plans them in the org: Account
  // too, for a template that masks contacts in an org with person accounts,
  // which the rules do not name. Until it answers, the rules' objects.
  const pickedTemplate = templates.find((tpl) => tpl.id === selectedTemplateId);
  const templateObjects = maskedObjects(pickedTemplate ? [pickedTemplate] : templates);
  const plannedObjects = backupObjectsQuery.data?.objects ?? templateObjects;
  const backupObjects = plannedObjects.length > 0 ? plannedObjects : DEFAULT_BACKUP_OBJECTS;
  // Of those, the ones past what one backup holds, which a backup in slices
  // holds whole: offered then, and only then, as its box.
  const coverageOfPicked =
    coverageQuery.data && coverageQuery.data.templateId === selectedTemplateId
      ? coverageQuery.data
      : null;
  const backupSliced = pastOneBackup(backupObjects, backups, coverageOfPicked);
  const [backupInSlices, setBackupInSlices] = useState(false);

  // A run that stopped short leaves a checkpoint to resume, and one that
  // finished forgets it: the coverage answer says which, so it is asked again
  // once a run ends, however it ends.
  const refetchCoverage = useLatestRef(() => coverageQuery.refetch());
  const anonymizeEnded = anonymizeMutation.data ?? anonymizeMutation.error;
  useEffect(() => {
    if (anonymizeEnded) refetchCoverage.current();
  }, [anonymizeEnded, refetchCoverage]);
  // A set given up is no longer open: Apply is offered again, and the set,
  // listed in Backups, says so.
  const abandonEnded = abandonMutation.data ?? abandonMutation.error;
  const refetchAfterAbandon = useLatestRef(() => {
    coverageQuery.refetch();
    backupsQuery.refetch();
  });
  useEffect(() => {
    if (abandonEnded) refetchAfterAbandon.current();
  }, [abandonEnded, refetchAfterAbandon]);

  // The snapshot a run took before it masked is a backup of the org: listed
  // once the run ends, so Backups offers to restore it. So is the set of a
  // run in slices, each slice's backup in it.
  const anonymizeAnswer = anonymizeMutation.data;
  const anonymizeSnapshot = useMemo(() => readSnapshot(anonymizeAnswer), [anonymizeAnswer]);
  const anonymizeSlices = useMemo(() => readSliceRun(anonymizeAnswer), [anonymizeAnswer]);
  const abandonAnswer = abandonMutation.data;
  const abandonedSlices = useMemo(() => readSliceRun(abandonAnswer), [abandonAnswer]);
  /** The run in slices the tab says the end of: the last one masked, or the set given up since. */
  const [sliceRunShown, setSliceRunShown] = useState<'run' | 'abandon'>('run');
  const sliceRun = sliceRunShown === 'abandon' ? abandonedSlices : anonymizeSlices;
  const refetchBackupsOnSnapshot = useLatestRef(() => backupsQuery.refetch());
  useEffect(() => {
    if (anonymizeSnapshot || anonymizeSlices) refetchBackupsOnSnapshot.current();
  }, [anonymizeSnapshot, anonymizeSlices, refetchBackupsOnSnapshot]);

  // A run in slices can take hours, the tab left meanwhile: its end is said
  // where any tab shows it, in the interface language — every slice masked,
  // slices left for Resume, or records created during the run left unmasked.
  const announceSliceRun = useLatestRef((run: { result: SliceSetResult }) => {
    const slices = run.result.objects.flatMap((o) => o.slices);
    const done = slices.filter((s) => s.state === 'masked').length;
    const counts = { done: formatNumber(done), total: formatNumber(slices.length) };
    const late = run.result.lateRecords;
    addNotification(
      late > 0
        ? {
            level: 'warning',
            title: t('dataops.title'),
            message: t('dataops.slices.notify.late', {
              count: late,
              formatted: formatNumber(late),
            }),
          }
        : run.result.state === 'open'
          ? {
              level: 'warning',
              title: t('dataops.title'),
              message: t('dataops.slices.notify.open', counts),
            }
          : {
              level: 'success',
              title: t('dataops.title'),
              message: t('dataops.slices.notify.done', counts),
              autoDismissMs: 6000,
            },
    );
  });
  useEffect(() => {
    if (anonymizeSlices) announceSliceRun.current(anonymizeSlices);
  }, [anonymizeSlices, announceSliceRun]);

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
      abandonMutation.error ??
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
    abandonMutation.error,
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
    // With none picked, Create backup reads what every template listed masks.
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
      // Offered only for an object past one backup, and asked, never assumed.
      ...(backupInSlices && backupSliced.length > 0 ? { slices: true } : {}),
    });
  };

  // `dataops:rollback` has been implemented, routed and unit-tested on the
  // extension side all along — CRUD/FLS guard, 200-record upsert batching, api
  // limit checks, progress events — and nothing had ever sent it. The Restore
  // button voided its argument behind a comment saying it "could be extended".
  // How it writes is asked in its question, the boxes there.
  const handleRestore = (
    operationId: string,
    options: RestoreOptions,
    accord?: DataOpsAutomationAccord,
  ) => {
    if (!currentOrg) return;
    setError(null);
    rollbackMutation.mutate({
      orgId: currentOrg.id,
      operationId,
      ...(options.rewriteAll ? { rewriteAll: true } : {}),
      ...(options.includeChanged ? { includeChanged: true } : {}),
      ...accordPayloadOf(accord),
      ...ASKED_FROM_PAGE,
    });
  };
  /**
   * Restore a set of slices: every slice not restored yet, or the slices
   * named, each from its own backup, in order.
   */
  const handleRestoreSet = (
    setId: string,
    slices: number[] | undefined,
    options: Pick<RestoreOptions, 'rewriteAll'>,
    accord?: DataOpsAutomationAccord,
  ) => {
    if (!currentOrg) return;
    setError(null);
    rollbackMutation.mutate({
      orgId: currentOrg.id,
      operationId: setId,
      ...(slices ? { slices } : {}),
      ...(options.rewriteAll ? { rewriteAll: true } : {}),
      ...accordPayloadOf(accord),
      ...ASKED_FROM_PAGE,
    });
  };
  /** What the last restore wrote, left alone and had refused, from its answer. */
  const restored = rollbackMutation.data;
  const keptChanged = keptChangedOf(restored?.keptChanged);
  const restoredSlices = restoredSlicesOf(restored?.slices);
  const lastRestore =
    restored && typeof restored.totalRestored === 'number'
      ? {
          written: restored.totalRestored,
          unchanged: typeof restored.totalUnchanged === 'number' ? restored.totalUnchanged : 0,
          failed: typeof restored.totalFailed === 'number' ? restored.totalFailed : 0,
          ...(keptChanged ? { keptChanged } : {}),
          ...(restoredSlices ? { slices: restoredSlices } : {}),
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
    if (outcome.deleted.includes(openedBackupId)) setOpenedBackupId('');
    refetchBackups.current();
    addNotification({
      level: 'success',
      title: t('dataops.title'),
      message: t('dataops.backupsDeleted', { count: outcome.deleted.length }),
      autoDismissMs: 4000,
    });
    deleteBackupsMutation.reset();
  }, [deleteBackupsMutation, openedBackupId, refetchBackups, addNotification, t]);

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
  const handleApplyAnonymize = (
    templateId: string,
    options: { snapshot: boolean; slices?: true; accord?: DataOpsAutomationAccord },
  ) => {
    if (!currentOrg) return;
    setError(null);
    previewMutation.reset();
    setSliceRunShown('run');
    anonymizeMutation.mutate({
      orgId: currentOrg.id,
      templateId,
      ...(options.snapshot ? { snapshot: true } : {}),
      // In slices, each backed up just before it is masked: a slice is a snapshot.
      ...(options.snapshot && options.slices ? { slices: true } : {}),
      ...accordPayloadOf(options.accord),
      ...ASKED_FROM_PAGE,
    });
  };

  /** Open Backups on the snapshot a masking run took, or on its set of slices. */
  const openBackupsOn = (operationId: string) => {
    setOpenedBackupId(operationId);
    changeTab('backup');
  };

  // Masks only what the run that stopped short left, from where it stopped:
  // of a run in slices, its set, with the key it was masked with.
  const handleResumeAnonymize = (
    templateId: string,
    resumeFrom: string,
    accord?: DataOpsAutomationAccord,
    options?: { slices: true },
  ) => {
    if (!currentOrg) return;
    setError(null);
    previewMutation.reset();
    setSliceRunShown('run');
    anonymizeMutation.mutate({
      orgId: currentOrg.id,
      templateId,
      resumeFrom,
      ...(options?.slices ? { slices: true } : {}),
      ...accordPayloadOf(accord),
      ...ASKED_FROM_PAGE,
    });
  };

  // Gives the run in slices up: nothing more is masked, its slices stay.
  const handleAbandonAnonymize = (templateId: string) => {
    if (!currentOrg) return;
    setError(null);
    setSliceRunShown('abandon');
    abandonMutation.mutate({
      orgId: currentOrg.id,
      templateId,
      abandon: true,
      ...ASKED_FROM_PAGE,
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

  // The tabs, in the order of the work, Masking first. Backups carries the
  // count of the org's backups, a set of slices one backup whatever its
  // slices: the page drew three cards of counts above every tab, Cleanup's
  // and Personal data's too, and pushed their work below the fold.
  const DATAOPS_TABS: PageTab[] = [
    { id: 'anonymize', label: t('dataops.anonymize'), icon: 'eye-closed' },
    {
      id: 'backup',
      label: t('dataops.backup'),
      icon: 'archive',
      ...(currentOrg ? { badge: backups.length + sets.length } : {}),
    },
    { id: 'gdpr', label: t('dataops.compliance'), icon: 'shield' },
    { id: 'cleanup', label: t('dataops.cleanup'), icon: 'checklist' },
    { id: 'emptying', label: t('dataops.emptying'), icon: 'trash' },
  ];

  // A checkpoint is the way back from a run on any object: offered where one
  // can be taken.
  const takeCheckpoint =
    currentOrg && currentOrg.status === 'connected' && isDevelopmentOrg(currentOrg)
      ? () => {
          selectOrg(currentOrg.id);
          navigate('checkpoint', { takeCheckpoint: true, targetOrgId: currentOrg.id });
        }
      : undefined;

  // A tab waits only on the query it actually reads. Gating the skeleton on
  // both queries at once let a slow templates response paint a skeleton on top
  // of an already-loaded backup list; Personal data, Cleanup and Emptying
  // read neither query, and each says what it waits on itself.
  //
  // And only for its first answer. The list is read again after a backup
  // ends, after a backup is deleted and after a template is saved or deleted,
  // and the skeleton took the panel's place each time: the control the
  // keyboard was on went with it — the Delete button a confirmation hands
  // focus back to — and the panel's own state, a confirmation it was asking.
  // Read again, the panel stays drawn and says it is busy.
  const tabQuery =
    activeTab === 'anonymize' ? templatesQuery : activeTab === 'backup' ? backupsQuery : null;
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
        icon="wrench"
        // The org picker, as on Checkpoints, Forge and Frozen, with the org's
        // type beside it: a production org, or a sandbox marked Staging,
        // shows what it is before anything is clicked.
        actions={
          <div className="flex items-center gap-(--sf-space-2)">
            <OrgDropdown
              value={currentOrg?.id ?? ''}
              onChange={selectOrg}
              orgs={orgs}
              ariaLabel={t('dataops.orgPicker')}
              testId="dataops-org"
              className="min-w-56"
            />
            {currentOrg && <OrgTypeBadge org={currentOrg} testId="dataops-org-type" />}
          </div>
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

      <PageTabs tabs={DATAOPS_TABS} activeTab={activeTab} onTabChange={changeTab} />

      <BentoTile className="p-0" hover={false}>
        <div className="p-4" data-testid="dataops-content" aria-busy={tabReading || undefined}>
          {tabLoading && (
            <div className="flex flex-col gap-(--sf-space-3)" data-testid="dataops-skeleton">
              <Skeleton variant="text" width="30%" height="1em" />
              <Skeleton variant="rect" height="120px" />
              <Skeleton variant="text" width="50%" height="1em" />
              <Skeleton variant="rect" height="80px" />
            </div>
          )}

          {activeTab === 'anonymize' && !tabLoading && (
            <AnonymizePanel
              orgName={orgName}
              {...(currentOrg ? { orgId: currentOrg.id } : {})}
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
              onAbandon={handleAbandonAnonymize}
              isAbandoning={abandonMutation.loading}
              // Nothing held the buttons while a run went on, so a second
              // click started a second run over the same records.
              isApplying={anonymizeMutation.loading}
              progress={anonymizeProgress}
              sliceRun={sliceRun}
              onOpenSet={openBackupsOn}
              coverage={coverageQuery.data}
              onStop={anonymizeStop.cancel}
              stopRequested={anonymizeStop.requested}
              snapshotTaken={anonymizeSnapshot}
              onOpenRestore={openBackupsOn}
              snapshotRefused={anonymizeMutation.errorCode === 'SNAPSHOT_NOT_TAKEN'}
              {...(maskAsked && orgName
                ? {
                    asked: (
                      <MaskAsked
                        objects={maskAsked.objects}
                        org={orgName}
                        template={pickedTemplate}
                      />
                    ),
                  }
                : {})}
              // Beside the template whose objects it reads: it was taken on a
              // tab of its own, which listed what Masking wrote over.
              {...(currentOrg
                ? {
                    backup: (
                      <BackupCreate
                        objects={backupObjects}
                        {...(pickedTemplate ? { template: pickedTemplate.name } : {})}
                        slicesOffered={backupSliced}
                        inSlices={backupInSlices}
                        onInSlicesChange={setBackupInSlices}
                        onCreate={handleCreateBackup}
                        // Nothing held the button while a backup read, nor stopped it.
                        isCreating={backupMutation.loading}
                        onStop={backupStop.cancel}
                        stopRequested={backupStop.requested}
                      />
                    ),
                  }
                : {})}
            />
          )}

          {activeTab === 'backup' && !tabLoading && (
            <BackupPanel
              orgName={orgName}
              {...(currentOrg ? { orgId: currentOrg.id } : {})}
              onCreateBackup={() => changeTab('anonymize')}
              backups={backups}
              sets={sets}
              openedId={openedBackupId}
              onRestore={handleRestore}
              onRestoreSet={handleRestoreSet}
              // Nothing disabled the button while the upserts ran, so a second
              // click started a second restore over the first one.
              isRestoring={rollbackMutation.loading}
              lastRestore={lastRestore}
              onExport={handleExportBackup}
              onDelete={(operationId) => handleDeleteBackups([operationId])}
              onDeleteAll={() => handleDeleteBackups()}
              isDeleting={deleteBackupsMutation.loading}
              onStop={restoreStop.cancel}
              stopRequested={restoreStop.requested}
              onTakeCheckpoint={takeCheckpoint}
            />
          )}

          {/* Keyed by org, the three panels below: results read on one org —
              a person's records above all — must not stay on screen under the
              name of the next. */}
          {activeTab === 'gdpr' && currentOrg && orgName && (
            <CompliancePanel key={currentOrg.id} orgId={currentOrg.id} orgName={orgName} />
          )}

          {/* The scan counts what Quality counted beside what can be deleted:
              one picker, one scan, each delete beside what it found. */}
          {activeTab === 'cleanup' && currentOrg && orgName && (
            <CleanupPanel key={currentOrg.id} orgId={currentOrg.id} orgName={orgName} />
          )}

          {/* Emptying objects or the whole org: a tab of its own, Cleanup's
              scan no longer above it, a chunk fetched once it is opened. */}
          {activeTab === 'emptying' && currentOrg && orgName && (
            <EmptyPanel
              key={`empty-${currentOrg.id}`}
              orgId={currentOrg.id}
              orgName={orgName}
              {...(landing.empty?.orgId === currentOrg.id
                ? { initialObjects: landing.empty.objects }
                : {})}
              focusOnOpen={emptyingLanded}
            />
          )}
        </div>
      </BentoTile>
    </m.div>
  );
};
