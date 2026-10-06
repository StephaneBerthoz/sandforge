import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DataOpsAnonymizeCoverageResponse,
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
  isApplying?: boolean;
  previewData?: Record<string, unknown>[];
  /**
   * For the selected template, the rows of each object it masks in the org
   * against those the org's latest backup holds: what a restore can bring
   * back once the run has masked them.
   */
  coverage?: AnonymizeCoverage | null;
}

/** What the host answers `dataops:anonymize:coverage` with. */
type AnonymizeCoverage = DataOpsAnonymizeCoverageResponse['payload'];

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
  isApplying = false,
  previewData,
  coverage,
}) => {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // Held by id: a delete asked about one template is not a delete of the next one picked.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const selectedTemplate = templates.find((tpl) => tpl.id === selectedTemplateId);

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
                {/* Before Apply, which masks every row for good: an answer
                    for another template is not this one's. */}
                {coverage && coverage.templateId === selectedTemplate.id && (
                  <RestoreCoverage coverage={coverage} />
                )}
                <div className="flex flex-col gap-1 mt-2">
                  <div className="flex flex-wrap gap-2">
                    {/* No Preview button. One ran the very same irreversible
                        mutation as Apply, through one handler wired to both,
                        and was then left disabled under "Coming soon":
                        `dataops:anonymize` carries no dry-run flag, so there
                        is nothing a preview could run. Apply, behind its typed
                        confirmation, is the one way to run a template. */}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setConfirmOpen(true)}
                      loading={isApplying}
                      data-testid="apply-btn"
                    >
                      {t('dataops.applyAnonymization')}
                    </Button>
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
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false);
              onApply?.(selectedTemplate.id);
            }}
            title={t('dataops.applyAnonymization')}
            description={t('dataops.anonymizeDesc')}
            confirmText={t('dataops.anonymize')}
          />
        </div>
      )}

      {previewData && previewData.length > 0 && (
        <div data-testid="preview-data">
          <Card>
            <CardHeader title={t('dataops.previewAnonymization')} />
            <CardBody>
              <DataTable
                columns={Object.keys(previewData[0]).map((key) => ({ key, header: key }))}
                data={previewData}
                keyExtractor={(_row, i) => String(i)}
              />
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
};
