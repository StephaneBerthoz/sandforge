import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { isDevelopmentOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { cn } from '../../theme';
import { Button } from './Button';

/** Props for {@link TakeCheckpointNow}. */
export interface TakeCheckpointNowProps {
  /** The org the run wrote to, by its id in this machine's org registry. */
  orgId: string | undefined;
  /** Whether the run wrote anything there: one that wrote nothing left the org as it was. */
  wrote: boolean;
  /** Test id of the part; its button's is `${testId}-action`. */
  testId: string;
  /** Where the page sets it in its layout. */
  className?: string;
}

/**
 * "Take a checkpoint now", on the result of a run that filled an org: Seed,
 * Forge and Frozen. The moment worth keeping is right after the fill and
 * before the testers start. The run itself can be taken back from its own
 * files; a checkpoint is what undoes what everyone else does next.
 *
 * It opens Checkpoints on a take of that org, through the intent Home's tile
 * uses: the org is selected first, as the Checkpoints page's own picker
 * selects one, so the page opens on it, and the intent names it, so the take
 * is ready for that org and no other. Shown for a connected sandbox, scratch
 * org or Developer Edition only: a checkpoint of a production org is refused.
 */
export const TakeCheckpointNow: React.FC<TakeCheckpointNowProps> = ({
  orgId,
  wrote,
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const whyId = useId();
  const org = useOrgStore((s) => s.orgs.find((candidate) => candidate.id === orgId));
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  if (!wrote || !org || org.status !== 'connected' || !isDevelopmentOrg(org)) return null;

  const take = (): void => {
    selectOrg(org.id);
    sendBridgeMessage('org:select', { orgId: org.id });
    navigate('checkpoint', { takeCheckpoint: true, targetOrgId: org.id });
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs',
        className,
      )}
      data-testid={testId}
    >
      <History size={14} className="shrink-0 text-hue-indigo" aria-hidden="true" />
      <p id={whyId} className="min-w-0 flex-1 text-text-primary">
        {t('runResults.checkpointNow.why', { org: org.alias || org.username })}
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={take}
        aria-describedby={whyId}
        data-testid={`${testId}-action`}
      >
        {t('runResults.checkpointNow.take')}
      </Button>
    </div>
  );
};
