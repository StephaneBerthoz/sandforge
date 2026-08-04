import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncTemplateConfig } from '@sandforge/shared';
import { PREBUILT_SYNC_TEMPLATES } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';

/** Props for the SyncTemplatePicker component. */
export interface SyncTemplatePickerProps {
  /** Callback invoked when the user applies a template. */
  onApply: (template: SyncTemplateConfig) => void;
  /** Optional additional CSS class. */
  className?: string;
}

/**
 * Displays pre-built sync templates as selectable cards.
 * Each card shows the template name, description, object list, and a "Use This" button.
 */
export const SyncTemplatePicker: React.FC<SyncTemplatePickerProps> = ({ onApply, className }) => {
  const { t } = useTranslation();

  return (
    <div
      className={cn('grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4', className)}
      data-testid="sync-template-picker"
    >
      {PREBUILT_SYNC_TEMPLATES.map((template) => (
        <Card key={template.templateId} data-testid={`sync-template-card-${template.templateId}`}>
          <CardHeader title={t(template.nameKey)} subtitle={t(template.descriptionKey)} />
          <CardBody className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              <Badge variant="info">
                {t('sync.templates.objectCount', { count: template.objects.length })}
              </Badge>
              <Badge variant="default">{t(`sync.directions.${template.direction}`)}</Badge>
              <Badge variant="default">{t(`sync.modes.${template.mode}`)}</Badge>
              <Badge variant="default">{t(`sync.conflicts.${template.conflictStrategy}`)}</Badge>
            </div>
            <p className="text-[10px] text-text-secondary">
              {template.objects.map((o) => o.objectApiName).join(', ')}
            </p>
            <Button
              size="sm"
              onClick={() => onApply(template)}
              data-testid={`sync-template-apply-${template.templateId}`}
            >
              {t('sync.templates.useThis')}
            </Button>
          </CardBody>
        </Card>
      ))}
    </div>
  );
};
