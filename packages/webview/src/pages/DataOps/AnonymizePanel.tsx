import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AnonymizationTemplate,
  AnonymizationMethod,
  ComplianceFrameworkType,
} from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { DataTable } from '../../components/ui/DataTable';

/** AnonymizePanel component props. */
export interface AnonymizePanelProps {
  templates?: AnonymizationTemplate[];
  selectedTemplateId?: string;
  onSelectTemplate?: (templateId: string) => void;
  onCreateTemplate?: () => void;
  onPreview?: (templateId: string) => void;
  onApply?: (templateId: string) => void;
  isApplying?: boolean;
  previewData?: Record<string, unknown>[];
}

const RULE_TYPE_LABELS: Partial<Record<AnonymizationMethod, string>> = {
  mask: 'dataops.ruleTypes.mask',
  hash: 'dataops.ruleTypes.hash',
  fake: 'dataops.ruleTypes.fake',
  nullify: 'dataops.ruleTypes.nullify',
  shuffle: 'dataops.ruleTypes.shuffle',
  truncate: 'dataops.ruleTypes.truncate',
  constant: 'dataops.ruleTypes.constant',
  preserve_format: 'dataops.ruleTypes.preserve_format',
};

const FRAMEWORK_LABELS: Partial<Record<ComplianceFrameworkType, string>> = {
  gdpr: 'dataops.frameworks.gdpr',
  ccpa: 'dataops.frameworks.ccpa',
  hipaa: 'dataops.frameworks.hipaa',
  pci_dss: 'dataops.frameworks.pci_dss',
  custom: 'dataops.frameworks.custom',
};

/** Panel for anonymizing sensitive data. */
export const AnonymizePanel: React.FC<AnonymizePanelProps> = ({
  templates = [],
  selectedTemplateId,
  onSelectTemplate,
  onCreateTemplate,
  onPreview,
  onApply,
  isApplying = false,
  previewData,
}) => {
  const { t } = useTranslation();

  const selectedTemplate = templates.find((tpl) => tpl.id === selectedTemplateId);

  return (
    <div className="flex flex-col gap-3" data-testid="anonymize-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('dataops.anonymize')}</h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCreateTemplate}
          data-testid="create-template-btn"
        >
          {t('dataops.createTemplate')}
        </Button>
      </div>

      {templates.length > 0 && (
        <Select
          value={selectedTemplateId ?? ''}
          onChange={(e) => onSelectTemplate?.(e.target.value)}
          placeholder={t('dataops.selectTemplate')}
          options={templates.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
          data-testid="template-select"
        />
      )}

      {templates.length === 0 && (
        <EmptyState
          icon="🔒"
          title={t('dataops.noTemplates')}
          description={t('dataops.anonymizeDesc')}
        />
      )}

      {selectedTemplate && (
        <div data-testid="template-detail">
          <Card>
            <CardHeader
              title={selectedTemplate.name}
              subtitle={selectedTemplate.description}
              action={
                selectedTemplate.complianceFramework && (
                  <Badge variant="info">
                    {t(
                      FRAMEWORK_LABELS[selectedTemplate.complianceFramework] ??
                        selectedTemplate.complianceFramework,
                    )}
                  </Badge>
                )
              }
            />
            <CardBody>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-text-secondary">
                  {selectedTemplate.rules.length} rules
                </span>
                <div className="flex flex-wrap gap-1">
                  {selectedTemplate.rules.map((rule, i) => (
                    <Badge key={i} variant="default">
                      {rule.fieldApiName}: {t(RULE_TYPE_LABELS[rule.method] ?? rule.method)}
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onPreview?.(selectedTemplate.id)}
                    data-testid="preview-btn"
                  >
                    {t('dataops.previewAnonymization')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => onApply?.(selectedTemplate.id)}
                    loading={isApplying}
                    data-testid="apply-btn"
                  >
                    {t('dataops.applyAnonymization')}
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
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
