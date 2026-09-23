import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PipelineTrigger,
  PipelineTriggerStatus,
  TriggerConfig,
  TriggerType,
} from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { dateTimeFormat, formatStoredDate } from '../../utils/formatters';
import { getLocalTimezone, getTimezones } from '../Sync/CronScheduleBuilder';

/** A registered sandbox a sandbox refresh trigger can name. */
export interface TriggerSandbox {
  id: string;
  alias: string;
}

/** TriggerConfigPanel component props. */
export interface TriggerConfigPanelProps {
  triggers?: PipelineTrigger[];
  /**
   * What the extension says each saved schedule and sandbox refresh trigger
   * will do: its next start, or why it starts nothing.
   */
  statuses?: PipelineTriggerStatus[];
  /**
   * The triggers of the pipeline as it was last saved; absent for a pipeline
   * never saved. A trigger fires as saved, so an edit waits for the save.
   */
  savedTriggers?: PipelineTrigger[];
  /** The registered sandboxes a sandbox refresh trigger can name. */
  sandboxes?: TriggerSandbox[];
  /** Whether a step of the pipeline cannot run: no trigger starts it then. */
  pipelineBlocked?: boolean;
  onAddTrigger?: (type: TriggerType) => void;
  onRemoveTrigger?: (triggerId: string) => void;
  onToggleTrigger?: (triggerId: string, enabled: boolean) => void;
  onUpdateTriggerConfig?: (triggerId: string, config: Partial<TriggerConfig>) => void;
}

const TRIGGER_TYPES: TriggerType[] = [
  'manual',
  'schedule',
  'event',
  'webhook',
  'sandbox_refresh',
  'deployment_complete',
];

/** The types that start nothing yet; each card says why. */
type IdleTriggerType = 'event' | 'webhook' | 'deployment_complete';

function startsNothing(type: TriggerType): type is IdleTriggerType {
  return type === 'event' || type === 'webhook' || type === 'deployment_complete';
}

const TRIGGER_VARIANT: Record<TriggerType, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  manual: 'default',
  schedule: 'info',
  event: 'success',
  webhook: 'warning',
  sandbox_refresh: 'error',
  deployment_complete: 'success',
};

/** Whether a trigger on the canvas is the one the extension has saved. */
function sameAsSaved(trigger: PipelineTrigger, saved: PipelineTrigger | undefined): boolean {
  if (!saved) return false;
  const field = (t: PipelineTrigger, key: 'cron' | 'timezone' | 'orgId'): string =>
    (t.config[key] ?? '').trim();
  return (
    saved.type === trigger.type &&
    saved.enabled === trigger.enabled &&
    field(saved, 'cron') === field(trigger, 'cron') &&
    field(saved, 'timezone') === field(trigger, 'timezone') &&
    field(saved, 'orgId') === field(trigger, 'orgId')
  );
}

/**
 * A date and time in SandForge's language, in `timeZone` when it is one this
 * browser knows; null when the extension sent something that is not a date.
 * The zone's fallback formatted that value again, threw "Invalid time value"
 * a second time, and the trigger panel did not render.
 */
export function formatTriggerTime(iso: string, timeZone?: string): string | null {
  return formatStoredDate(iso, (date) => {
    try {
      return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
    } catch {
      return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }
  });
}

/** What a schedule or sandbox refresh trigger will do, as the page can tell it. */
const TriggerState: React.FC<{
  trigger: PipelineTrigger;
  status: PipelineTriggerStatus | undefined;
  unsaved: boolean;
  pipelineBlocked: boolean;
  sandboxName: string | undefined;
}> = ({ trigger, status, unsaved, pipelineBlocked, sandboxName }) => {
  const { t } = useTranslation();
  const line = 'text-xs text-[var(--sf-text-secondary)]';

  // The page knows before the extension does: a step it marks as one that
  // cannot run keeps every trigger from starting the pipeline.
  if (pipelineBlocked) {
    return (
      <p className={line} data-testid={`trigger-idle-${trigger.id}`}>
        {t('automation.triggerIdle.cannotRun')}
      </p>
    );
  }
  if (unsaved) {
    return (
      <p className={line} data-testid={`trigger-unsaved-${trigger.id}`}>
        {t('automation.triggerUnsaved')}
      </p>
    );
  }
  if (!status) return null;

  const last = status.lastFiredAt ? (
    <p className={line} data-testid={`trigger-last-${trigger.id}`}>
      {t(`automation.triggerLast.${status.lastOutcome ?? 'started'}`, {
        time: formatTriggerTime(status.lastFiredAt) ?? t('common.dateUnknown'),
      })}
    </p>
  ) : null;

  if (!status.armed) {
    return (
      <>
        <p className={line} data-testid={`trigger-idle-${trigger.id}`}>
          {t(`automation.triggerIdle.${status.idle ?? 'stopped'}`)}
          {status.detail && <span className="block font-mono">{status.detail}</span>}
        </p>
        {last}
      </>
    );
  }
  return (
    <>
      {status.type === 'schedule' && status.nextRunAt ? (
        <p className={line} data-testid={`trigger-next-run-${trigger.id}`}>
          {t('automation.triggerNextRun', {
            time: formatTriggerTime(status.nextRunAt, status.timezone) ?? t('common.dateUnknown'),
            timezone: status.timezone ?? '',
          })}
        </p>
      ) : (
        <p className={line} data-testid={`trigger-armed-${trigger.id}`}>
          {t('automation.triggerWatching', { sandbox: sandboxName ?? '' })}
        </p>
      )}
      {last}
    </>
  );
};

/**
 * Panel for configuring pipeline triggers.
 *
 * Three types start a run: Manual from the Run button, Schedule and Sandbox
 * Refresh from the extension, once the pipeline is saved. The other three
 * start nothing, and their cards say why.
 */
export const TriggerConfigPanel: React.FC<TriggerConfigPanelProps> = ({
  triggers = [],
  statuses = [],
  savedTriggers,
  sandboxes = [],
  pipelineBlocked = false,
  onAddTrigger,
  onRemoveTrigger,
  onToggleTrigger,
  onUpdateTriggerConfig,
}) => {
  const { t } = useTranslation();
  const [newTriggerType, setNewTriggerType] = React.useState<TriggerType>('manual');
  const timezones = React.useMemo(() => getTimezones(), []);

  /**
   * The time zones a schedule can be read in. One saved with none is read in
   * the extension host's, which its status names: that is the one shown.
   */
  const timezoneOptions = (
    current: string,
    status: PipelineTriggerStatus | undefined,
  ): Array<{ value: string; label: string }> => [
    ...(current === '' ? [{ value: '', label: status?.timezone ?? getLocalTimezone() }] : []),
    ...(current !== '' && !timezones.includes(current) ? [{ value: current, label: current }] : []),
    ...timezones.map((zone) => ({ value: zone, label: zone })),
  ];

  const sandboxOptions = (current: string): Array<{ value: string; label: string }> => [
    { value: '', label: t('automation.triggerChooseSandbox') },
    // A sandbox the trigger names but SandForge no longer lists stays shown,
    // so the choice is not changed behind the reader's back.
    ...(current !== '' && !sandboxes.some((sandbox) => sandbox.id === current)
      ? [{ value: current, label: t('automation.triggerUnknownSandbox') }]
      : []),
    ...sandboxes.map((sandbox) => ({ value: sandbox.id, label: sandbox.alias })),
  ];

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
            // The list says which choice starts nothing before it is made,
            // not after the trigger is added.
            options={TRIGGER_TYPES.map((type) => ({
              value: type,
              label: startsNothing(type)
                ? `${t(`automation.triggerTypes.${type}`)} (${t('common.comingSoon')})`
                : t(`automation.triggerTypes.${type}`),
            }))}
            aria-label={t('a11y.triggerType')}
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

      {/* What starts a pipeline, said where triggers are configured. */}
      <p className="text-xs text-[var(--sf-text-secondary)]" data-testid="trigger-note">
        {t('automation.triggerNote')}
      </p>

      {triggers.length === 0 && (
        <EmptyState
          icon="zap"
          title={t('automation.triggers')}
          description={t('automation.addTrigger')}
        />
      )}

      {triggers.map((trigger) => {
        const status = statuses.find((candidate) => candidate.triggerId === trigger.id);
        const saved = savedTriggers?.find((candidate) => candidate.id === trigger.id);
        const unsaved = !sameAsSaved(trigger, saved);
        const orgId = trigger.config.orgId ?? '';
        const timezone = trigger.config.timezone ?? '';
        return (
          <div key={trigger.id} data-testid={`trigger-${trigger.id}`}>
            <Card>
              <CardHeader
                title={t(`automation.triggerTypes.${trigger.type}`)}
                action={
                  <div className="flex items-center gap-2">
                    {startsNothing(trigger.type) && (
                      <span data-testid={`trigger-coming-soon-${trigger.id}`}>
                        <Badge variant="info">{t('common.comingSoon')}</Badge>
                      </span>
                    )}
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
              {startsNothing(trigger.type) && (
                <CardBody>
                  <p
                    className="text-xs text-[var(--sf-text-secondary)]"
                    data-testid={`trigger-soon-reason-${trigger.id}`}
                  >
                    {t(`automation.triggerSoon.${trigger.type}`)}
                  </p>
                </CardBody>
              )}
              {trigger.type === 'schedule' && (
                <CardBody>
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-[var(--sf-text-secondary)]">
                      {t('automation.triggerHint.schedule')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[var(--sf-text-secondary)]">
                        {t('automation.cronExpression')}:
                      </span>
                      <Input
                        value={trigger.config.cron ?? ''}
                        onChange={(e) =>
                          onUpdateTriggerConfig?.(trigger.id, { cron: e.target.value })
                        }
                        placeholder="0 0 * * *"
                        // The placeholder is an example, not a name: without this
                        // the field is announced as "0 0 * * *".
                        aria-label={t('automation.cronExpression')}
                        className="w-40"
                        data-testid={`cron-input-${trigger.id}`}
                      />
                      <Select
                        value={timezone}
                        onChange={(e) =>
                          onUpdateTriggerConfig?.(trigger.id, { timezone: e.target.value })
                        }
                        options={timezoneOptions(timezone, status)}
                        aria-label={t('automation.triggerTimezone')}
                        data-testid={`timezone-select-${trigger.id}`}
                      />
                    </div>
                    <TriggerState
                      trigger={trigger}
                      status={status}
                      unsaved={unsaved}
                      pipelineBlocked={pipelineBlocked}
                      sandboxName={undefined}
                    />
                  </div>
                </CardBody>
              )}
              {trigger.type === 'sandbox_refresh' && (
                <CardBody>
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-[var(--sf-text-secondary)]">
                      {t('automation.triggerHint.sandbox_refresh')}
                    </p>
                    <Select
                      value={orgId}
                      onChange={(e) =>
                        onUpdateTriggerConfig?.(trigger.id, { orgId: e.target.value })
                      }
                      options={sandboxOptions(orgId)}
                      aria-label={t('automation.triggerSandbox')}
                      data-testid={`sandbox-select-${trigger.id}`}
                    />
                    {sandboxes.length === 0 && (
                      <p
                        className="text-xs text-[var(--sf-text-secondary)]"
                        data-testid={`trigger-no-sandbox-${trigger.id}`}
                      >
                        {t('automation.triggerNoSandboxes')}
                      </p>
                    )}
                    <TriggerState
                      trigger={trigger}
                      status={status}
                      unsaved={unsaved}
                      pipelineBlocked={pipelineBlocked}
                      sandboxName={sandboxes.find((sandbox) => sandbox.id === orgId)?.alias}
                    />
                  </div>
                </CardBody>
              )}
            </Card>
          </div>
        );
      })}
    </div>
  );
};
