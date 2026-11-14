import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BACKUP_MAX_RECORDS_PER_OBJECT } from '@sandforge/shared';
import type {
  AnonymizePreviewValue,
  DataOpsAnonymizeCoverageResponse,
  DataOpsAnonymizePreviewResponse,
  ListedAnonymizationTemplate,
  SliceSetResult,
} from '@sandforge/shared';
import { formatNumber, formatStoredDate, uiLocale } from '../../utils/formatters';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { SlicePlan, slicedObjects } from './SlicePlan';
import { SliceTable } from './SliceSetRow';
import { sliceProgressOf } from './sliceProgress';
import { maskingGapWords, type MaskingGaps } from '../../utils/maskingRefusal';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { DataTable } from '../../components/ui/DataTable';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { AnonymizationTemplateEditor, ruleTypeLabel } from './AnonymizationTemplateEditor';
import type { AnonymizationTemplateDraft } from './AnonymizationTemplateEditor';
import { RunStopControl } from './RunStopControl';
import { DeleteQuestion } from './DeleteQuestion';
import { DataOpsAutomation, NO_ACCORD, type DataOpsAutomationAccord } from './DataOpsAutomation';

/** AnonymizePanel component props. */
export interface AnonymizePanelProps {
  /**
   * The org a run masks, by the name the page shows it under: named in the
   * confirmation, and the word typed to confirm it. Apply is offered only
   * with one.
   */
  orgName?: string;
  /**
   * The org a run masks, by its id in the registry: its confirmation reads
   * what the org runs as the records are written over, and waits for it.
   * Without it, no such read, and the run carries no acceptance of what fires.
   */
  orgId?: string;
  /** The templates the host lists: those that ship, then those the user saved. */
  templates?: ListedAnonymizationTemplate[];
  selectedTemplateId?: string;
  onSelectTemplate?: (templateId: string) => void;
  /** Saves the editor's rules as a template of the user's. Create Template opens the editor. */
  onSaveTemplate?: (draft: AnonymizationTemplateDraft) => void;
  /** Whether a save is on its way to the host. The editor closes once one lands. */
  savingTemplate?: boolean;
  /** Why the last save was refused. The editor stays open with what was typed. */
  saveTemplateError?: string | null;
  /** Deletes a template the user saved; one that ships offers no delete. */
  onDeleteTemplate?: (templateId: string) => void;
  /**
   * Masks every row of the template's objects; `snapshot` takes, before the
   * first write, a backup of the fields it masks, which Restore puts back;
   * `slices`, of an object holding more rows than one backup does, a backup
   * of each slice just before it is masked.
   */
  onApply?: (
    templateId: string,
    options: { snapshot: boolean; slices?: true; accord?: DataOpsAutomationAccord },
  ) => void;
  /**
   * Resumes the run of the template that stopped short, the checkpoint the
   * coverage answer names: only what that run left is masked. A run in
   * slices resumes its set, `slices` given.
   */
  onResume?: (
    templateId: string,
    resumeFrom: string,
    accord?: DataOpsAutomationAccord,
    options?: { slices: true },
  ) => void;
  /**
   * Gives up the run in slices of the template left open on the org: nothing
   * more is masked, and its slices stay, which Restore puts back.
   */
  onAbandon?: (templateId: string) => void;
  /** Whether that giving up is on its way to the host. */
  isAbandoning?: boolean;
  isApplying?: boolean;
  /** Where the run in progress is, as its progress names it. */
  progress?: { percentage: number; step: string } | null;
  /**
   * Of the last run in slices, its set as its end says it — each slice, the
   * rows created late, whether slices are left —, or the set it gave up.
   */
  sliceRun?: { result: SliceSetResult; abandoned?: boolean } | null;
  /** Open the Restore tab on a set of slices. */
  onOpenSet?: (setId: string) => void;
  /**
   * Reads the first rows of each object the template masks and masks them as
   * Apply would, writing nothing. Preview shows them, original beside masked.
   */
  onPreview?: (templateId: string) => void;
  /** Whether a preview is on its way back from the host. */
  isPreviewing?: boolean;
  /** What the host answered the last preview with. */
  preview?: AnonymizePreview | null;
  /**
   * For the selected template, the rows of each object it masks in the org
   * against those the org's latest backup holds: what a restore can bring
   * back once the run has masked them.
   */
  coverage?: AnonymizeCoverage | null;
  /** Stop the run in progress: shown while it runs (`RunStopControl`). */
  onStop?: () => void;
  /** Whether that stop was sent and not refused. */
  stopRequested?: boolean;
  /** The snapshot the last run took before it masked, which Restore puts back. */
  snapshotTaken?: { operationId: string; totalRecords: number } | null;
  /** Open the Restore tab on that snapshot. */
  onOpenRestore?: (operationId: string) => void;
  /** Whether the last run was refused because its snapshot could not be taken. */
  snapshotRefused?: boolean;
}

/** What the host answers `dataops:anonymize:coverage` with. */
type AnonymizeCoverage = DataOpsAnonymizeCoverageResponse['payload'];

/** What the host answers `dataops:anonymize:preview` with. */
type AnonymizePreview = DataOpsAnonymizePreviewResponse['payload'];

/** One line of a preview table: a field of a record, as it is and as Apply writes it. */
type PreviewLine = {
  key: string;
  id: string;
  field: string;
  before: AnonymizePreviewValue;
  after: AnonymizePreviewValue;
};

/** What a preview found Apply would be refused for, or `undefined` when it would not be. */
function refusedFor(preview: AnonymizePreview): MaskingGaps | undefined {
  const objectsNotCovered = preview.objects.filter((o) => o.notCovered).map((o) => o.objectApiName);
  // A field shown read-only passed Preview, and Apply was then refused for it.
  const notWritable = preview.objects.flatMap((o) =>
    o.writeDenied === undefined
      ? []
      : o.writeDenied.deniedFields.length === 0
        ? [o.objectApiName]
        : o.writeDenied.deniedFields.map((field) => `${o.objectApiName}.${field}`),
  );
  return preview.fieldsNotFound.length > 0 || objectsNotCovered.length > 0 || notWritable.length > 0
    ? {
        fieldsNotFound: preview.fieldsNotFound,
        objectsNotCovered,
        ...(notWritable.length > 0 ? { notWritable } : {}),
      }
    : undefined;
}

/**
 * What Apply would be refused for, before the click, in the words the refusal
 * uses: the fields the org lacks or field-level security hides from the user
 * SandForge connects as, the objects left with no field, what that user may
 * not edit, and what to do.
 */
const ApplyRefusedFor: React.FC<{ gaps: MaskingGaps; testId: string }> = ({ gaps, testId }) => {
  const { t } = useTranslation();
  return (
    <p
      className="rounded border border-status-warning p-2 text-xs text-text-primary"
      data-testid={testId}
    >
      {`${t('dataops.preview.applyRefused')} ${maskingGapWords(gaps, t)}`}
    </p>
  );
};

/**
 * What a template would write over the first rows of each object it masks:
 * per object, each masked field of each record, the value the org holds
 * beside the one Apply writes. Nothing was written to show it.
 */
const PreviewResult: React.FC<{ preview: AnonymizePreview }> = ({ preview }) => {
  const { t } = useTranslation();
  const shown = (value: AnonymizePreviewValue): string =>
    value === null || value === '' ? t('dataops.preview.empty') : String(value);
  const gaps = refusedFor(preview);
  return (
    <div data-testid="preview-data">
      <Card>
        <CardHeader
          title={t('dataops.previewAnonymization')}
          subtitle={t('dataops.preview.description')}
        />
        <CardBody>
          <div className="flex flex-col gap-3">
            {/* A field the describe does not list is one the org lacks or
                one field-level security hides from the user: said with what
                to do, as a line the eye stops at — it read as if no data were
                at risk, and Contact.Birthdate stayed as it was. */}
            {gaps && <ApplyRefusedFor gaps={gaps} testId="preview-fields-not-found" />}
            {preview.objects.map((object) => {
              const lines: PreviewLine[] = object.rows.flatMap((row) =>
                object.fields.map((field) => ({
                  key: `${row.id}-${field}`,
                  id: row.id,
                  field,
                  before: row.before[field] ?? null,
                  after: row.after[field] ?? null,
                })),
              );
              return (
                <section
                  key={object.objectApiName}
                  className="flex flex-col gap-1"
                  data-testid={`preview-object-${object.objectApiName}`}
                >
                  <h3 className="text-xs font-semibold text-text-primary">
                    {object.objectApiName}
                  </h3>
                  {object.error !== undefined ? (
                    <span className="text-xs text-status-error">
                      {t('dataops.preview.notRead', { error: object.error })}
                    </span>
                  ) : lines.length === 0 ? (
                    <span className="text-xs text-text-secondary">
                      {/* Its rows are read and none of its fields is masked:
                          "No records" read as if it held nothing to mask. */}
                      {object.notCovered
                        ? t('common.refusal.maskingObjectNotCovered', {
                            objects: object.objectApiName,
                          })
                        : t('dataops.preview.noRecords')}
                    </span>
                  ) : (
                    <DataTable<PreviewLine>
                      columns={[
                        { key: 'id', header: t('dataops.preview.record') },
                        { key: 'field', header: t('dataops.preview.field') },
                        {
                          key: 'before',
                          header: t('dataops.preview.original'),
                          render: (line) => shown(line.before),
                        },
                        {
                          key: 'after',
                          header: t('dataops.preview.masked'),
                          render: (line) => shown(line.after),
                        },
                      ]}
                      data={lines}
                      keyExtractor={(line) => line.key}
                      stickyHeader={false}
                    />
                  )}
                </section>
              );
            })}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};

/**
 * Per object, the rows a restore of the latest backup can never bring back
 * once a run has masked them: those past what it holds, all of them without
 * a backup; `null` where the org did not count them and nothing says they are
 * held.
 */
function unrestorable(
  coverage: AnonymizeCoverage,
): Array<{ objectApiName: string; rows: number | null }> {
  return coverage.objects.flatMap((o): Array<{ objectApiName: string; rows: number | null }> => {
    if (o.count === null) {
      return o.truncated || o.backedUp === 0
        ? [{ objectApiName: o.objectApiName, rows: null }]
        : [];
    }
    const rows = o.count - o.backedUp;
    return rows > 0 ? [{ objectApiName: o.objectApiName, rows }] : [];
  });
}

const FRAMEWORK_LABELS: Record<string, string> = {
  gdpr: 'dataops.frameworks.gdpr',
  ccpa: 'dataops.frameworks.ccpa',
  hipaa: 'dataops.frameworks.hipaa',
  pci_dss: 'dataops.frameworks.pci_dss',
  custom: 'dataops.frameworks.custom',
};

/**
 * What a restore can bring back of what the template masks: per object, its
 * rows in the org against those the latest backup holds. A backup reads each
 * object up to a cap of rows and a masking run masks every row, so the rows
 * past the cap stay masked whatever is restored; the page said neither.
 */
const RestoreCoverage: React.FC<{ coverage: AnonymizeCoverage }> = ({ coverage }) => {
  const { t } = useTranslation();
  const short = coverage.objects
    .filter((o) => o.truncated || (o.count !== null && o.count > o.backedUp))
    .map((o) => o.objectApiName);
  // The backup reached the cap the user sets: raising it is what brings the
  // rest into the next backup, up to what any backup holds of one object.
  // Past that, nothing raises it, and the page said to all the same.
  const pastMax = (o: { count: number | null }): boolean =>
    o.count !== null && o.count > BACKUP_MAX_RECORDS_PER_OBJECT;
  const atCap = coverage.objects.filter((o) => o.stoppedAt === 'cap');
  const capped = atCap.filter((o) => !pastMax(o)).map((o) => o.objectApiName);
  const beyond = atCap.filter(pastMax).map((o) => o.objectApiName);
  // Past what one backup holds, a run keeping the values first masks the
  // object in slices, each backed up just before it is masked: what it would
  // cost is said here, as the command line's dry run says it. The page
  // offered only to mask from the command line, a slice a run.
  const sliced = slicedObjects(coverage.objects);
  const date = coverage.backup
    ? (formatStoredDate(coverage.backup.timestamp, (d) => d.toLocaleString(uiLocale())) ??
      t('common.dateUnknown'))
    : null;
  return (
    <div
      className="flex flex-col gap-1 rounded border border-subtle p-2 mt-1"
      data-testid="restore-coverage"
    >
      <span className="text-xs font-medium text-text-primary">{t('dataops.coverage.title')}</span>
      <span className="text-xs text-text-secondary" data-testid="restore-coverage-backup">
        {date ? t('dataops.coverage.latestBackup', { date }) : t('dataops.coverage.noBackup')}
      </span>
      {coverage.objects.length > 0 && (
        <table className="text-xs text-text-primary w-full">
          <thead>
            <tr className="text-text-secondary">
              <th scope="col" className="text-left font-normal">
                {t('dataops.coverage.object')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('dataops.coverage.inOrg')}
              </th>
              <th scope="col" className="text-right font-normal">
                {t('dataops.coverage.inBackup')}
              </th>
              {sliced.length > 0 && (
                <th scope="col" className="text-right font-normal">
                  {t('dataops.slices.column')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {coverage.objects.map((o) => (
              <tr key={o.objectApiName} data-testid={`restore-coverage-${o.objectApiName}`}>
                <th scope="row" className="text-left font-normal">
                  {o.objectApiName}
                </th>
                <td className="text-right tabular-nums">
                  {o.count === null ? t('dataops.coverage.notCounted') : formatNumber(o.count)}
                </td>
                <td className="text-right tabular-nums">
                  {o.stoppedAt === 'cap'
                    ? t('dataops.coverage.stoppedAtCap', { rows: formatNumber(o.backedUp) })
                    : o.stoppedAt === 'failure'
                      ? t('dataops.coverage.readFailed', { rows: formatNumber(o.backedUp) })
                      : formatNumber(o.backedUp)}
                </td>
                {sliced.length > 0 && (
                  <td
                    className="text-right tabular-nums"
                    data-testid={`restore-coverage-slices-${o.objectApiName}`}
                  >
                    {/* In slices, every object of the run is: one under a
                        backup's rows makes a single slice. */}
                    {o.slicePlan
                      ? t('dataops.slices.columnValue', {
                          count: o.slicePlan.slices,
                          formatted: formatNumber(o.slicePlan.slices),
                        })
                      : t('dataops.coverage.notCounted')}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {short.length > 0 && (
        <span className="text-xs text-text-primary" data-testid="restore-coverage-shortfall">
          {t('dataops.coverage.shortfall', { objects: short.join(', ') })}
        </span>
      )}
      {(capped.length > 0 || beyond.length > 0) && (
        <span className="text-xs text-text-secondary" data-testid="restore-coverage-cap">
          {[
            ...(capped.length > 0
              ? [t('dataops.coverage.capHint', { objects: capped.join(', ') })]
              : []),
            ...(beyond.length > 0
              ? [
                  t('dataops.slices.capBeyond', {
                    count: beyond.length,
                    objects: beyond.join(', '),
                  }),
                ]
              : []),
          ].join(' ')}
        </span>
      )}
      {sliced.length > 0 && coverage.plan && (
        <div className="flex flex-col gap-1" data-testid="restore-coverage-plan">
          <span className="text-xs text-text-primary">
            {t('dataops.slices.plan.lead', {
              count: sliced.length,
              objects: sliced.map((o) => o.objectApiName).join(', '),
            })}
          </span>
          <SlicePlan plan={coverage.plan} objects={sliced} testId="coverage-slice-plan" />
        </div>
      )}
    </div>
  );
};

/**
 * Where a masking run is: the slice and its phase of a run in slices — backed
 * up, then masked —, in the interface language; the step as the extension
 * wrote it otherwise.
 */
const AnonymizeProgress: React.FC<{ progress: { percentage: number; step: string } }> = ({
  progress,
}) => {
  const { t } = useTranslation();
  const slice = sliceProgressOf(progress.step);
  const said =
    slice === undefined
      ? progress.step
      : slice.phase === 'backingUp'
        ? t(
            slice.about === undefined
              ? 'dataops.slices.progress.backingUpResumed'
              : 'dataops.slices.progress.backingUp',
            {
              object: slice.object,
              index: formatNumber(slice.index),
              about: formatNumber(slice.about ?? slice.index),
            },
          )
        : t(
            slice.about === undefined
              ? 'dataops.slices.progress.maskingResumed'
              : 'dataops.slices.progress.masking',
            {
              object: slice.object,
              index: formatNumber(slice.index),
              about: formatNumber(slice.about ?? slice.index),
              done: formatNumber(slice.done),
              total: formatNumber(slice.total),
            },
          );
  return (
    <div className="flex flex-col gap-1" data-testid="anonymize-progress">
      <p className="text-xs text-text-primary" data-testid="anonymize-progress-step">
        {said}
      </p>
      <ProgressBar
        value={progress.percentage}
        max={100}
        ariaLabel={t('dataops.slices.progress.label')}
        valueText={`${formatNumber(Math.round(progress.percentage))} %`}
      />
    </div>
  );
};

/**
 * What a run in slices left, once it ended: each slice of its set, the rows
 * created during the run that no backup holds, why it stopped between two
 * slices, and how to go on; the set opens in Restore, which puts its values
 * back. Of a set given up, what giving it up left.
 */
const SliceRunResult: React.FC<{
  run: { result: SliceSetResult; abandoned?: boolean };
  onOpenSet?: (setId: string) => void;
}> = ({ run, onOpenSet }) => {
  const { t } = useTranslation();
  const { result } = run;
  const slices = result.objects.flatMap((o) => o.slices);
  const done = slices.filter((s) => s.state === 'masked' || s.state === 'restored').length;
  return (
    <div className="flex flex-col gap-2" data-testid="anonymize-slices" role="status">
      <p className="text-xs text-text-primary" data-testid="anonymize-slices-summary">
        {run.abandoned
          ? t('dataops.slices.result.abandoned', {
              count: done,
              formatted: formatNumber(done),
            })
          : t('dataops.slices.result.summary', {
              count: slices.length,
              done: formatNumber(done),
              formatted: formatNumber(slices.length),
              size: formatNumber(result.size),
            })}
      </p>
      {slices.length > 0 && (
        <div className="overflow-x-auto">
          <SliceTable slices={slices} kind="masking" testId="anonymize-slices-table" />
        </div>
      )}
      {result.stoppedOnBudget && (
        <p className="text-xs text-text-primary" data-testid="anonymize-slices-budget">
          {t('dataops.slices.result.budget', {
            requests: formatNumber(result.requestsSpent),
          })}
        </p>
      )}
      {result.lateRecords > 0 && (
        <p className="text-xs text-text-primary" data-testid="anonymize-slices-late">
          {t('dataops.slices.result.late', {
            count: result.lateRecords,
            formatted: formatNumber(result.lateRecords),
          })}
        </p>
      )}
      {!run.abandoned && result.state === 'open' && result.slicesLeft && (
        <p className="text-xs text-text-primary" data-testid="anonymize-slices-left">
          {t('dataops.slices.result.left')}
        </p>
      )}
      {onOpenSet && slices.some((s) => s.state !== 'pending') && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenSet(result.setId)}
            data-testid="anonymize-open-set"
          >
            {t('dataops.slices.result.openRestore')}
          </Button>
        </div>
      )}
    </div>
  );
};

/** Panel for anonymizing sensitive data. */
export const AnonymizePanel: React.FC<AnonymizePanelProps> = ({
  orgName,
  orgId,
  templates = [],
  selectedTemplateId,
  onSelectTemplate,
  onSaveTemplate,
  savingTemplate = false,
  saveTemplateError = null,
  onDeleteTemplate,
  onApply,
  onResume,
  onAbandon,
  isAbandoning = false,
  isApplying = false,
  progress,
  sliceRun,
  onOpenSet,
  onPreview,
  isPreviewing = false,
  preview,
  coverage,
  onStop,
  stopRequested = false,
  snapshotTaken,
  onOpenRestore,
  snapshotRefused = false,
}) => {
  const { t } = useTranslation();
  // Apply and Resume both write over the org's records, behind the same typed confirmation.
  const [confirming, setConfirming] = useState<'apply' | 'resume' | null>(null);
  /**
   * Whether Apply masks in slices the objects holding more rows than one
   * backup does: asked each time, never ticked for the user — a run in
   * slices masks for hours, a backup a slice, and the slices before a slice
   * that cannot be backed up stay masked.
   */
  const [inSlices, setInSlices] = useState(false);
  const slicesHintId = useId();
  /** Whether Abandon asks to give up the run in slices left open. */
  const [askingAbandon, setAskingAbandon] = useState(false);
  const applyHeldId = useId();
  /**
   * Whether Apply keeps the values it masks first, as the command line always
   * does: ticked unless the user unticks it. The panel took no snapshot, and
   * a masking run on an org with no backup had no way back.
   */
  const [keepValues, setKeepValues] = useState(true);
  const keepHintId = useId();
  /** What the confirmation's read of the org's automation lets through and mutes. */
  const [accord, setAccord] = useState<DataOpsAutomationAccord>(NO_ACCORD);
  /** Why the confirmation waits on that read, if it does. */
  const [automationHeld, setAutomationHeld] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  // Held by id: a delete asked about one template is not a delete of the next one picked.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const deleteQuestionId = useId();
  const deleteTemplateButton = useRef<HTMLButtonElement>(null);

  const selectedTemplate = templates.find((tpl) => tpl.id === selectedTemplateId);
  // An answer for another template is not this one's.
  const selectedCoverage =
    coverage && selectedTemplate && coverage.templateId === selectedTemplate.id ? coverage : null;
  const checkpoint = selectedCoverage?.checkpoint;
  const lost = selectedCoverage ? unrestorable(selectedCoverage) : [];
  /**
   * The run in slices of this template left open on the org: a new Apply is
   * refused while it is — it would mask again what its slices masked —, and
   * it is resumed or given up.
   */
  const openSet = selectedCoverage?.sliceSet?.state === 'open' ? selectedCoverage.sliceSet : null;
  /** The objects past what one backup holds, which a run keeping the values masks in slices. */
  const sliced = slicedObjects(selectedCoverage?.objects);
  const slicesPlan = selectedCoverage?.plan;
  const asksSlices = confirming === 'apply' && keepValues && sliced.length > 0;
  // The run keeps no value of an object past one backup unless in slices:
  // the confirmation waits on the box, as on the read of the org's automation.
  const slicesHeld =
    asksSlices && !inSlices
      ? t('dataops.slices.confirm.held', {
          count: sliced.length,
          objects: sliced.map((o) => o.objectApiName).join(', '),
        })
      : undefined;
  const held = slicesHeld ?? (orgId ? automationHeld : undefined);
  // Nor is a preview of another template this one's.
  const selectedPreview =
    preview && selectedTemplate && preview.templateId === selectedTemplate.id ? preview : null;
  const refusal = selectedPreview ? refusedFor(selectedPreview) : undefined;

  // The editor closes when a save it sent lands, and stays open, with what was
  // typed, when the host refuses it.
  const wasSaving = useRef(savingTemplate);
  useEffect(() => {
    if (wasSaving.current && !savingTemplate && !saveTemplateError) setEditing(false);
    wasSaving.current = savingTemplate;
  }, [savingTemplate, saveTemplateError]);

  return (
    <div className="flex flex-col gap-3" data-testid="anonymize-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('dataops.anonymize')}</h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing(true)}
          disabled={!onSaveTemplate || editing}
          data-testid="create-template-btn"
        >
          {t('dataops.createTemplate')}
        </Button>
      </div>

      {editing && onSaveTemplate && (
        <AnonymizationTemplateEditor
          // Starts from the rules on screen: the selected template's.
          initialRules={selectedTemplate?.rules ?? []}
          startsFrom={selectedTemplate?.name}
          takenNames={templates.map((tpl) => tpl.name)}
          saving={savingTemplate}
          onSave={onSaveTemplate}
          onCancel={() => setEditing(false)}
        />
      )}

      {!editing && templates.length > 0 && (
        <Select
          value={selectedTemplateId ?? ''}
          onChange={(e) => onSelectTemplate?.(e.target.value)}
          placeholder={t('dataops.selectTemplate')}
          options={templates.map((tpl) => ({
            value: tpl.id,
            label: tpl.saved ? t('dataops.savedTemplateOption', { name: tpl.name }) : tpl.name,
          }))}
          data-testid="template-select"
        />
      )}

      {!editing && templates.length === 0 && (
        <EmptyState
          icon={<Icon name="lock" />}
          title={t('dataops.noTemplates')}
          description={t('dataops.anonymizeDesc')}
        />
      )}

      {!editing && selectedTemplate && (
        <div data-testid="template-detail">
          <Card>
            <CardHeader
              title={selectedTemplate.name}
              subtitle={selectedTemplate.description}
              action={
                <div className="flex items-center gap-1">
                  {selectedTemplate.saved && (
                    <Badge variant="default" data-testid="template-saved-badge">
                      {t('dataops.savedTemplate')}
                    </Badge>
                  )}
                  {selectedTemplate.complianceFramework && (
                    <Badge variant="info">
                      {FRAMEWORK_LABELS[selectedTemplate.complianceFramework]
                        ? t(FRAMEWORK_LABELS[selectedTemplate.complianceFramework])
                        : selectedTemplate.complianceFramework}
                    </Badge>
                  )}
                </div>
              }
            />
            <CardBody>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-text-secondary" data-testid="template-rule-count">
                  {t('dataops.ruleCount', { count: selectedTemplate.rules.length })}
                </span>
                {/* What the host sends: `Object.Field` and the method. The
                    badges used to read `fieldApiName` and `method`, which no
                    template the host lists carries: each one read ": ". */}
                <div className="flex flex-wrap gap-1">
                  {selectedTemplate.rules.map((rule, i) => (
                    <Badge key={`${rule.fieldPattern}-${i}`} variant="default">
                      {rule.fieldPattern}: {ruleTypeLabel(t, rule.ruleType)}
                    </Badge>
                  ))}
                </div>
                {/* Before Apply, which masks every row for good. */}
                {selectedCoverage && <RestoreCoverage coverage={selectedCoverage} />}
                {checkpoint && onResume && !openSet && (
                  <span className="text-xs text-text-primary" data-testid="resume-hint">
                    {t('dataops.resumeHint', {
                      date:
                        formatStoredDate(checkpoint.savedAt, (d) => d.toLocaleString(uiLocale())) ??
                        t('common.dateUnknown'),
                    })}
                  </span>
                )}
                {/* Said where Apply is: it waits on the run left open, which
                    Resume carries on and Abandon gives up. */}
                {openSet && (
                  <p
                    id={applyHeldId}
                    className="text-xs text-text-primary"
                    data-testid="slices-open"
                  >
                    {t('dataops.slices.open.notice', {
                      done: formatNumber(openSet.done),
                      total: formatNumber(openSet.total),
                      size: formatNumber(openSet.size),
                      date:
                        formatStoredDate(openSet.savedAt, (d) => d.toLocaleString(uiLocale())) ??
                        t('common.dateUnknown'),
                    })}{' '}
                    {/* With no checkpoint of it for the template's rules as
                        they are, the run cannot be resumed: given up only. */}
                    {t(checkpoint ? 'dataops.slices.open.ways' : 'dataops.slices.open.abandonOnly')}
                  </p>
                )}
                <div className="flex flex-col gap-1 mt-2">
                  <div className="flex flex-wrap gap-2">
                    {/* A preview of its own request, which reads and writes
                        nothing: one ran the very same irreversible mutation as
                        Apply, through one handler wired to both, and was then
                        left disabled under "Coming soon". */}
                    {onPreview && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onPreview(selectedTemplate.id)}
                        loading={isPreviewing}
                        disabled={isApplying}
                        data-testid="preview-btn"
                      >
                        {t('dataops.previewAnonymization')}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setConfirming('apply')}
                      loading={isApplying}
                      // Its confirmation names the org and asks for its name.
                      // A run in slices left open holds it, and says why
                      // where the keyboard lands on it.
                      disabled={!orgName || openSet !== null}
                      focusableWhenDisabled={openSet !== null}
                      {...(openSet ? { 'aria-describedby': applyHeldId } : {})}
                      data-testid="apply-btn"
                    >
                      {t('dataops.applyAnonymization')}
                    </Button>
                    {/* Where the last run stopped short: Apply would mask
                        again what it masked, and an address it hashed is
                        hashed once more. */}
                    {checkpoint && onResume && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirming('resume')}
                        disabled={isApplying || isAbandoning || !orgName}
                        data-testid="resume-btn"
                      >
                        {t(openSet ? 'dataops.slices.open.resume' : 'dataops.resumeAnonymization')}
                      </Button>
                    )}
                    {openSet && onAbandon && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setAskingAbandon(true)}
                        loading={isAbandoning}
                        disabled={isApplying || !orgName}
                        data-testid="abandon-btn"
                      >
                        {t('dataops.slices.open.abandon')}
                      </Button>
                    )}
                    {isApplying && onStop && (
                      <RunStopControl
                        onStop={onStop}
                        requested={stopRequested}
                        testId="anonymize-stop"
                      />
                    )}
                    {selectedTemplate.saved && onDeleteTemplate && (
                      <Button
                        ref={deleteTemplateButton}
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirmDeleteId(selectedTemplate.id)}
                        data-testid="delete-template-btn"
                      >
                        {t('dataops.deleteTemplate')}
                      </Button>
                    )}
                  </div>
                  {/* A question of its own, on a line below Apply: a bare
                      red Confirm took the Delete's place on the row of
                      Preview and Apply, and read as confirming Apply. */}
                  {selectedTemplate.saved &&
                    onDeleteTemplate &&
                    confirmDeleteId === selectedTemplate.id && (
                      <DeleteQuestion
                        id={deleteQuestionId}
                        testId="delete-template"
                        question={t('dataops.deleteTemplateConfirm', {
                          name: selectedTemplate.name,
                        })}
                        confirmLabel={t('dataops.deleteTemplate')}
                        onConfirm={() => {
                          setConfirmDeleteId(null);
                          onDeleteTemplate(selectedTemplate.id);
                        }}
                        onCancel={() => {
                          setConfirmDeleteId(null);
                          deleteTemplateButton.current?.focus();
                        }}
                      />
                    )}
                </div>
                {isApplying && progress && <AnonymizeProgress progress={progress} />}
                {sliceRun && !isApplying && (
                  <SliceRunResult run={sliceRun} {...(onOpenSet ? { onOpenSet } : {})} />
                )}
                {snapshotRefused && !isApplying && (
                  <p
                    role="status"
                    className="text-xs text-text-primary"
                    data-testid="anonymize-snapshot-refused"
                  >
                    {t('dataops.snapshot.refused')}
                  </p>
                )}
                {snapshotTaken && !isApplying && (
                  <div
                    className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
                    data-testid="anonymize-snapshot-taken"
                  >
                    <span>
                      {t('dataops.snapshot.taken', {
                        count: snapshotTaken.totalRecords,
                        formatted: formatNumber(snapshotTaken.totalRecords),
                      })}
                    </span>
                    {onOpenRestore && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onOpenRestore(snapshotTaken.operationId)}
                        data-testid="anonymize-open-restore"
                      >
                        {t('dataops.snapshot.openRestore')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
          {/* Apply masks records in the org for good; it used to fire straight
              off the click, with nothing between the pointer and the write. */}
          {orgName && (
            <DangerConfirm
              open={confirming !== null}
              onClose={() => {
                setConfirming(null);
                setAccord(NO_ACCORD);
                setInSlices(false);
              }}
              onConfirm={() => {
                const resumeFrom = confirming === 'resume' ? checkpoint?.id : undefined;
                // Confirmed once what the org runs was listed above: what
                // fires is accepted, the emails as their box says.
                const given = orgId ? accord : undefined;
                const slices = asksSlices && inSlices;
                setConfirming(null);
                setAccord(NO_ACCORD);
                setInSlices(false);
                if (resumeFrom !== undefined) {
                  // A run in slices resumes its set: its next slice is backed
                  // up before it is masked, as the run's were.
                  if (openSet) onResume?.(selectedTemplate.id, resumeFrom, given, { slices: true });
                  else if (given) onResume?.(selectedTemplate.id, resumeFrom, given);
                  else onResume?.(selectedTemplate.id, resumeFrom);
                } else {
                  onApply?.(selectedTemplate.id, {
                    snapshot: keepValues,
                    ...(slices ? { slices: true as const } : {}),
                    ...(given ? { accord: given } : {}),
                  });
                }
              }}
              {...(held !== undefined ? { held } : {})}
              // It was titled Apply over "Anonymize sensitive data", naming
              // neither the org nor the template, and asked to type the word
              // Anonymize — 匿名化 in Japanese, typed only through an input
              // method. The org's name, as Rewind and Deploy ask, is the same
              // in every language.
              title={t(
                confirming === 'resume'
                  ? 'dataops.anonymizeConfirm.resumeTitle'
                  : 'dataops.anonymizeConfirm.title',
                { org: orgName, name: selectedTemplate.name },
              )}
              description={t(
                confirming === 'resume'
                  ? 'dataops.anonymizeConfirm.resumeDescription'
                  : 'dataops.anonymizeConfirm.description',
                {
                  fields: selectedTemplate.rules
                    .map((rule) => `${rule.fieldPattern} (${ruleTypeLabel(t, rule.ruleType)})`)
                    .join(', '),
                },
              )}
              confirmText={orgName}
            >
              {/* The confirmation said only 'Anonymize sensitive data', whatever
                the backup held: 1 220 contacts on a Developer Edition, 500
                backed up, and nothing said the other 720 could never come
                back. */}
              {/* A resume takes no snapshot: the run it resumes took one. */}
              {confirming === 'apply' && (
                <div className="flex flex-col gap-1" data-testid="confirm-keep-values">
                  <label className="flex items-start gap-2 text-xs text-text-primary">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={keepValues}
                      onChange={(e) => setKeepValues(e.target.checked)}
                      aria-describedby={keepHintId}
                      data-testid="confirm-keep-values-toggle"
                    />
                    <span>{t('dataops.snapshot.keep')}</span>
                  </label>
                  <p id={keepHintId} className="text-xs text-text-secondary">
                    {t('dataops.snapshot.keepHint')}
                  </p>
                </div>
              )}
              {/* Past what one backup holds of an object, the values are
                  kept a slice at a time: what that costs, and the box that
                  asks for it. Unticked "Keep the values first" takes no
                  backup, and no slice. */}
              {asksSlices && (
                <div className="flex flex-col gap-1" data-testid="confirm-slices">
                  {slicesPlan && (
                    <SlicePlan plan={slicesPlan} objects={sliced} testId="confirm-slice-plan" />
                  )}
                  <label className="flex items-start gap-2 text-xs text-text-primary">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={inSlices}
                      onChange={(e) => setInSlices(e.target.checked)}
                      aria-describedby={slicesHintId}
                      data-testid="confirm-slices-toggle"
                    />
                    <span>{t('dataops.slices.confirm.toggle')}</span>
                  </label>
                  <div
                    id={slicesHintId}
                    className="flex flex-col gap-1 text-xs text-text-secondary"
                  >
                    <p>{t('dataops.slices.confirm.hint')}</p>
                    <p data-testid="confirm-slices-lock">
                      {t('dataops.slices.confirm.lock', { org: orgName })}
                    </p>
                  </div>
                </div>
              )}
              {/* A resume of a run in slices holds the org as the run did. */}
              {confirming === 'resume' && openSet && (
                <p className="text-xs text-text-secondary" data-testid="confirm-slices-lock">
                  {t('dataops.slices.confirm.lock', { org: orgName })}
                </p>
              )}
              {/* What the preview found Apply would be refused for, said again
                where the user confirms it. The host decides: a preview can
                be out of date once the user has given the access it asks for. */}
              {refusal && <ApplyRefusedFor gaps={refusal} testId="confirm-fields-not-found" />}
              {orgId && confirming !== null && (
                <DataOpsAutomation
                  orgId={orgId}
                  org={orgName}
                  act="masking"
                  objects={(selectedCoverage?.objects ?? []).map((o) => ({
                    objectApiName: o.objectApiName,
                    records: o.count ?? 0,
                  }))}
                  accord={accord}
                  onAccordChange={setAccord}
                  onHeld={setAutomationHeld}
                />
              )}
              {/* What a restore cannot bring back, unless the run keeps the
                values first: then it writes nothing unless it keeps them all. */}
              {lost.length > 0 && !(confirming === 'apply' && keepValues) && (
                <div className="text-xs text-text-primary" data-testid="confirm-unrestorable">
                  <p>{t('dataops.coverage.confirmShortfall')}</p>
                  <ul className="list-disc pl-4">
                    {lost.map((o) => (
                      <li key={o.objectApiName}>
                        {o.objectApiName}:{' '}
                        {o.rows === null
                          ? t('dataops.coverage.notCounted')
                          : t('common.recordCountFormatted', {
                              count: o.rows,
                              formatted: formatNumber(o.rows),
                            })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </DangerConfirm>
          )}
          {/* Giving up writes nothing to the org, and cannot be taken back:
              the run's key goes with it, and a later run masks with another. */}
          {orgName && openSet && onAbandon && (
            <DangerConfirm
              open={askingAbandon}
              variant="warning"
              onClose={() => setAskingAbandon(false)}
              onConfirm={() => {
                setAskingAbandon(false);
                onAbandon(selectedTemplate.id);
              }}
              title={t('dataops.slices.open.abandonTitle', {
                org: orgName,
                name: selectedTemplate.name,
              })}
              description={t('dataops.slices.open.abandonDescription', {
                count: openSet.done,
                formatted: formatNumber(openSet.done),
              })}
              confirmLabel={t('dataops.slices.open.abandonConfirm')}
            />
          )}
        </div>
      )}

      {!editing && selectedPreview && <PreviewResult preview={selectedPreview} />}
    </div>
  );
};
