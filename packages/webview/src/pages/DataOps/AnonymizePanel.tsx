import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AnonymizePreviewValue,
  DataOpsAnonymizeCoverageResponse,
  DataOpsAnonymizePreviewResponse,
  ListedAnonymizationTemplate,
} from '@sandforge/shared';
import { formatNumber, formatStoredDate, uiLocale } from '../../utils/formatters';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { DataTable } from '../../components/ui/DataTable';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { AnonymizationTemplateEditor, ruleTypeLabel } from './AnonymizationTemplateEditor';
import type { AnonymizationTemplateDraft } from './AnonymizationTemplateEditor';

/** AnonymizePanel component props. */
export interface AnonymizePanelProps {
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
  onApply?: (templateId: string) => void;
  /**
   * Resumes the run of the template that stopped short, the checkpoint the
   * coverage answer names: only what that run left is masked.
   */
  onResume?: (templateId: string, resumeFrom: string) => void;
  isApplying?: boolean;
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

/**
 * What a template would write over the first rows of each object it masks:
 * per object, each masked field of each record, the value the org holds
 * beside the one Apply writes. Nothing was written to show it.
 */
const PreviewResult: React.FC<{ preview: AnonymizePreview }> = ({ preview }) => {
  const { t } = useTranslation();
  const shown = (value: AnonymizePreviewValue): string =>
    value === null || value === '' ? t('dataops.preview.empty') : String(value);
  return (
    <div data-testid="preview-data">
      <Card>
        <CardHeader
          title={t('dataops.previewAnonymization')}
          subtitle={t('dataops.preview.description')}
        />
        <CardBody>
          <div className="flex flex-col gap-3">
            {preview.fieldsNotFound.length > 0 && (
              <span className="text-xs text-text-primary" data-testid="preview-fields-not-found">
                {t('dataops.preview.fieldsNotFound', {
                  fields: preview.fieldsNotFound
                    .map((f) => `${f.objectApiName}.${f.fieldApiName}`)
                    .join(', '),
                })}
              </span>
            )}
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
                      {t('dataops.preview.noRecords')}
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
                <td className="text-right tabular-nums">{formatNumber(o.backedUp)}</td>
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
    </div>
  );
};

/** Panel for anonymizing sensitive data. */
export const AnonymizePanel: React.FC<AnonymizePanelProps> = ({
  templates = [],
  selectedTemplateId,
  onSelectTemplate,
  onSaveTemplate,
  savingTemplate = false,
  saveTemplateError = null,
  onDeleteTemplate,
  onApply,
  onResume,
  isApplying = false,
  onPreview,
  isPreviewing = false,
  preview,
  coverage,
}) => {
  const { t } = useTranslation();
  // Apply and Resume both write over the org's records, behind the same typed confirmation.
  const [confirming, setConfirming] = useState<'apply' | 'resume' | null>(null);
  const [editing, setEditing] = useState(false);
  // Held by id: a delete asked about one template is not a delete of the next one picked.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const selectedTemplate = templates.find((tpl) => tpl.id === selectedTemplateId);
  // An answer for another template is not this one's.
  const selectedCoverage =
    coverage && selectedTemplate && coverage.templateId === selectedTemplate.id ? coverage : null;
  const checkpoint = selectedCoverage?.checkpoint;
  const lost = selectedCoverage ? unrestorable(selectedCoverage) : [];
  // Nor is a preview of another template this one's.
  const selectedPreview =
    preview && selectedTemplate && preview.templateId === selectedTemplate.id ? preview : null;

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
          icon="🔒"
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
                {checkpoint && onResume && (
                  <span className="text-xs text-text-primary" data-testid="resume-hint">
                    {t('dataops.resumeHint', {
                      date:
                        formatStoredDate(checkpoint.savedAt, (d) => d.toLocaleString(uiLocale())) ??
                        t('common.dateUnknown'),
                    })}
                  </span>
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
                        disabled={isApplying}
                        data-testid="resume-btn"
                      >
                        {t('dataops.resumeAnonymization')}
                      </Button>
                    )}
                    {selectedTemplate.saved &&
                      onDeleteTemplate &&
                      (confirmDeleteId === selectedTemplate.id ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              onDeleteTemplate(selectedTemplate.id);
                            }}
                            data-testid="confirm-delete-template-btn"
                          >
                            {t('common.confirm')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setConfirmDeleteId(null)}
                            data-testid="cancel-delete-template-btn"
                          >
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setConfirmDeleteId(selectedTemplate.id)}
                          data-testid="delete-template-btn"
                        >
                          {t('dataops.deleteTemplate')}
                        </Button>
                      ))}
                  </div>
                </div>
              </div>
            </CardBody>
          </Card>
          {/* Apply masks records in the org for good; it used to fire straight
              off the click, with nothing between the pointer and the write. */}
          <DangerConfirm
            open={confirming !== null}
            onClose={() => setConfirming(null)}
            onConfirm={() => {
              const resumeFrom = confirming === 'resume' ? checkpoint?.id : undefined;
              setConfirming(null);
              if (resumeFrom !== undefined) onResume?.(selectedTemplate.id, resumeFrom);
              else onApply?.(selectedTemplate.id);
            }}
            title={
              confirming === 'resume'
                ? t('dataops.resumeAnonymization')
                : t('dataops.applyAnonymization')
            }
            description={t('dataops.anonymizeDesc')}
            confirmText={t('dataops.anonymize')}
          >
            {/* The confirmation said only 'Anonymize sensitive data', whatever
                the backup held: 1 220 contacts on a Developer Edition, 500
                backed up, and nothing said the other 720 could never come
                back. */}
            {lost.length > 0 && (
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
        </div>
      )}

      {!editing && selectedPreview && <PreviewResult preview={selectedPreview} />}
    </div>
  );
};
