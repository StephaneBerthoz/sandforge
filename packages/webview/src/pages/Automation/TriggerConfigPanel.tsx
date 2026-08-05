import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineTrigger, TriggerType } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';

/** TriggerConfigPanel component props. */
export interface TriggerConfigPanelProps {
  triggers?: PipelineTrigger[];
  onAddTrigger?: (type: TriggerType) => void;
  onRemoveTrigger?: (triggerId: string) => void;
  onToggleTrigger?: (triggerId: string, enabled: boolean) => void;
  onUpdateCron?: (triggerId: string, cron: string) => void;
}

const TRIGGER_TYPES: TriggerType[] = [
  'manual',
  'schedule',
  'event',
  'webhook',
  'sandbox_refresh',
  'deployment_complete',
];

const TRIGGER_VARIANT: Record<TriggerType, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  manual: 'default',
  schedule: 'info',
  event: 'success',
  webhook: 'warning',
  sandbox_refresh: 'error',
  deployment_complete: 'success',
};

/** Panel for configuring pipeline triggers. */
export const TriggerConfigPanel: React.FC<TriggerConfigPanelProps> = ({
  triggers = [],
  onAddTrigger,
  onRemoveTrigger,
  onToggleTrigger,
  onUpdateCron,
}) => {
  const { t } = useTranslation();
  const [newTriggerType, setNewTriggerType] = React.useState<TriggerType>('manual');

  return (
    <div className="flex flex-col gap-3" data-testid="trigger-config">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[var(--sf-text-primary)]">
          {t('automation.triggers')}
        </h3>
        <div className="flex items-center gap-2">
          <Select
            value={newTriggerType}
            onChange={(e) => setNewTriggerType(e.target.value as TriggerType)}
            options={TRIGGER_TYPES.map((type) => ({
              value: type,
              label: t(`automation.triggerTypes.${type}`),
            }))}
            data-testid="trigger-type-select"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onAddTrigger?.(newTriggerType)}
            data-testid="add-trigger-btn"
          >
            {t('automation.addTrigger')}
          </Button>
        </div>
      </div>

      {triggers.length === 0 && (
        <EmptyState
          icon="zap"
          title={t('automation.triggers')}
          description={t('automation.addTrigger')}
        />
      )}

      {triggers.map((trigger) => (
        <div key={trigger.id} data-testid={`trigger-${trigger.id}`}>
          <Card>
            <CardHeader
              title={t(`automation.triggerTypes.${trigger.type}`)}
              action={
                <div className="flex items-center gap-2">
                  <Badge variant={TRIGGER_VARIANT[trigger.type]}>
                    {trigger.enabled ? t('common.active') : t('common.disabled')}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggleTrigger?.(trigger.id, !trigger.enabled)}
                    data-testid={`toggle-trigger-${trigger.id}`}
                  >
                    {trigger.enabled ? t('common.disable') : t('common.enable')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemoveTrigger?.(trigger.id)}
                    data-testid={`remove-trigger-${trigger.id}`}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              }
            />
            {trigger.type === 'schedule' && (
              <CardBody>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--sf-text-secondary)]">
                    {t('automation.cronExpression')}:
                  </span>
                  <Input
                    value={trigger.config.cron ?? ''}
                    onChange={(e) => onUpdateCron?.(trigger.id, e.target.value)}
                    placeholder="0 0 * * *"
                    className="w-40"
                    data-testid={`cron-input-${trigger.id}`}
                  />
                </div>
              </CardBody>
            )}
          </Card>
        </div>
      ))}
    </div>
  );
};
