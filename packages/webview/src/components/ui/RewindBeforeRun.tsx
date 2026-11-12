import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { isDevelopmentOrg, type RunCheckpointInfo } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { cn } from '../../theme';
import { formatNumber, formatStoredDate } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';
import { Button } from './Button';

/** The objects a line names before it says how many more it holds. */
const NAMED_OBJECTS = 5;

/**
 * Objects named as the interface language lists them, the first five and how
 * many more: a checkpoint of a run's objects and of what its flows create
 * can hold twenty.
 *
 * @param t - Translates a key in the interface language.
 */
export function namedObjects(
  names: readonly string[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const named = names.slice(0, NAMED_OBJECTS);
  const more = names.length - named.length;
  return listWords(
    more > 0
      ? [
          ...named,
          t('runResults.checkpoint.moreObjects', { count: more, formatted: formatNumber(more) }),
        ]
      : named,
    (key) => t(key),
  );
}

/**
 * What the way back of a run is beside its checkpoint: a removal of the
 * run's records (Forge's, Sync's, Seed's), of the load's (Frozen Dataset's),
 * or none (Autopilot), whose checkpoint is then the only way back.
 */
export type RewindBeside = 'run' | 'load' | 'none';

const BESIDE_KEYS: Readonly<Record<RewindBeside, string>> = {
  run: 'runResults.checkpoint.besideRemoval',
  load: 'runResults.checkpoint.besideLoadRemoval',
  none: 'runResults.checkpoint.noRemoval',
};

/** Props for {@link RewindBeforeRun}. */
export interface RewindBeforeRunProps {
  /**
   * What the run's result or its history line says of the checkpoint it took
   * before its first write; nothing shown when it took none.
   */
  checkpoint: RunCheckpointInfo | undefined;
  /** The org the run wrote to, by its id in this machine's registry. */
  orgId: string | undefined;
  /** The run's other way back, which the line says what the rewind does beyond. */
  beside: RewindBeside;
  /**
   * A history line's: the checkpoint and the way to it, without what the
   * rewind does beside the removal, which the run's result says.
   */
  compact?: boolean;
  /**
   * A removal of the run left records in the org: the platform rewrote them
   * under it, or they changed since. Said on its line: a rewind takes them.
   */
  leftByRemoval?: boolean;
  /**
   * The run muted the target's automation (its result's `mutedAutomation`):
   * the preview the button opens has its mute ticked, as the rewind fires
   * the automation the run kept quiet.
   */
  muted?: boolean;
  /** Test id of the part; its button's is `${testId}-action`, a deleted checkpoint's line `${testId}-deleted`. */
  testId: string;
  className?: string;
}

/**
 * The checkpoint a run took of what it writes before its first write, on the
 * run's result and its history line: its name, what it holds and until when,
 * what it leaves out, and "Rewind to before this run…", under the run's
 * removal, which opens Checkpoints on the preview of a rewind to it — the
 * removal takes back what the run wrote and nothing else; the rewind takes
 * every held object back to how it was before the run, whoever changed it
 * since, the target's automation included. A run that wrote nothing deleted
 * its checkpoint, and says so.
 *
 * The preview opens through the intent Home's "Rewind…" uses, the org
 * selected first as "Take a checkpoint now" selects it: Checkpoints opens on
 * that org's preview and no other's, its mute ticked when the run muted.
 * Offered for a connected sandbox,
 * scratch org or Developer Edition only, as a rewind of any other is refused.
 */
export const RewindBeforeRun: React.FC<RewindBeforeRunProps> = ({
  checkpoint,
  orgId,
  beside,
  compact = false,
  leftByRemoval = false,
  muted = false,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const whatId = useId();
  const org = useOrgStore((s) => s.orgs.find((candidate) => candidate.id === orgId));
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  if (!checkpoint) return null;
  const subject = beside === 'load' ? 'load' : 'run';
  if (checkpoint.state === 'deleted') {
    return (
      <p
        data-testid={`${testId}-deleted`}
        className={cn('flex items-start gap-1 text-[11px] text-text-primary', className)}
      >
        <History size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>
          {subject === 'load'
            ? t('runResults.checkpoint.deletedLoad')
            : t('runResults.checkpoint.deleted')}
        </span>
      </p>
    );
  }

  const name = org?.alias || org?.username || orgId || '';
  const dated = (iso: string): string =>
    formatStoredDate(iso, 'yyyy-MM-dd HH:mm') ?? t('common.dateUnknown');
  const list = (names: readonly string[]): string => namedObjects(names, t);
  const rewindable = org !== undefined && org.status === 'connected' && isDevelopmentOrg(org);
  const open = (): void => {
    if (!org) return;
    selectOrg(org.id);
    sendBridgeMessage('org:select', { orgId: org.id });
    navigate('checkpoint', {
      previewCheckpointId: checkpoint.checkpointId,
      targetOrgId: org.id,
      ...(muted ? { previewMuted: true as const } : {}),
    });
  };

  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col gap-1.5 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary',
        compact && 'px-2 py-1.5 text-[11px]',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <History size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-hue-indigo" />
        <div id={whatId} className="flex min-w-0 flex-1 flex-col gap-1">
          <p data-testid={`${testId}-taken`}>
            {t('runResults.checkpoint.taken', {
              name: checkpoint.name,
              count: checkpoint.records,
              formatted: formatNumber(checkpoint.records),
              objects: list(checkpoint.objects),
            })}{' '}
            {checkpoint.expiresAt === null
              ? t('runResults.checkpoint.keptUntilDeleted')
              : t('runResults.checkpoint.keptUntil', { until: dated(checkpoint.expiresAt) })}
          </p>
          {!compact && (
            <p data-testid={`${testId}-beside`} className="text-text-secondary">
              {t(BESIDE_KEYS[beside], {
                objects: list(checkpoint.objects),
                org: name,
                time: dated(checkpoint.takenAt),
              })}
            </p>
          )}
          {leftByRemoval && (
            <p data-testid={`${testId}-after-removal`}>{t('runResults.checkpoint.afterRemoval')}</p>
          )}
          {checkpoint.notHeld.length > 0 && (
            <p data-testid={`${testId}-not-held`} className="text-text-secondary">
              {t('runResults.checkpoint.notHeld', {
                objects: list(checkpoint.notHeld.map((note) => note.objectApiName)),
              })}
            </p>
          )}
        </div>
      </div>
      {rewindable && (
        <Button
          variant="secondary"
          size="sm"
          onClick={open}
          aria-describedby={whatId}
          data-testid={`${testId}-action`}
          className="self-start"
        >
          {subject === 'load'
            ? t('runResults.checkpoint.rewindLoad')
            : t('runResults.checkpoint.rewind')}
        </Button>
      )}
    </div>
  );
};
