import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { isDevelopmentOrg } from '@sandforge/shared';
import type {
  CheckpointKeepResponse,
  CheckpointListResponse,
  SalesforceOrg,
} from '@sandforge/shared';
import { useAppStore } from '../../stores/useAppStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { BentoTile } from '../../components/ui/BentoGrid';
import { Button } from '../../components/ui/Button';
import { formatRelativeTime, formatStoredDate } from '../../utils/formatters';
import { usableCheckpoints } from '../Checkpoint/checkpointFacts';

/** Props for {@link CheckpointTile}. */
export interface CheckpointTileProps {
  /** The org Home is about: the one selected. */
  org: SalesforceOrg | undefined;
}

/**
 * Home's word on the selected org's checkpoints: its latest, with Rewind…,
 * or the offer to take one before the next test session; and a checkpoint
 * that expires within three days, with Keep. Read from this machine, never
 * from the org. Nothing for a production org, of which none is ever taken,
 * nor before the list has answered.
 */
export const CheckpointTile: React.FC<CheckpointTileProps> = ({ org }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const offered = org !== undefined && org.status === 'connected' && isDevelopmentOrg(org);

  const listQuery = useBridgeQuery<CheckpointListResponse['payload']>(
    'checkpoint:list',
    org ? { orgId: org.id } : undefined,
    { skip: !offered },
  );
  const keeping = useBridgeMutation<CheckpointKeepResponse['payload']>('checkpoint:keep');
  const kept = keeping.data;
  const { refetch } = listQuery;
  useEffect(() => {
    if (kept) refetch();
  }, [kept, refetch]);

  const listed = listQuery.data?.checkpoints;
  if (!offered || !Array.isArray(listed)) return null;

  const orgName = org.alias || org.username;
  const usable = usableCheckpoints(listed);
  const latest = usable[0];
  const expiring = usable.find(
    (entry) => entry.expiresSoon === true && entry.checkpoint.expiresAt !== null,
  );
  const age = latest
    ? formatStoredDate(latest.checkpoint.takenAt, (d) => formatRelativeTime(d))
    : null;
  const expiresIn = expiring?.checkpoint.expiresAt
    ? formatStoredDate(expiring.checkpoint.expiresAt, (d) => formatRelativeTime(d))
    : null;

  return (
    <BentoTile colSpan={1} rowSpan={1}>
      <div className="flex h-full flex-col gap-3" data-testid="checkpoint-tile">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <History className="h-4 w-4 text-hue-indigo" aria-hidden="true" />
          {t('nav.checkpoint')}
        </h3>
        {latest ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-xs text-text-primary" data-testid="checkpoint-tile-latest">
              {t('home.checkpoint.latest', {
                name: latest.checkpoint.name,
                age: age ?? t('common.dateUnknown'),
              })}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('checkpoint')}
              data-testid="checkpoint-tile-rewind"
            >
              {t('home.checkpoint.rewind')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-xs text-text-primary" data-testid="checkpoint-tile-none">
              {t('home.checkpoint.none', { org: orgName })}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate('checkpoint', { takeCheckpoint: true })}
              data-testid="checkpoint-tile-take"
            >
              {t('home.checkpoint.take')}
            </Button>
          </div>
        )}
        {expiring && expiresIn && (
          <div className="flex flex-wrap items-center gap-2" data-testid="checkpoint-tile-expiring">
            <p className="text-xs text-text-primary">
              {t('home.checkpoint.expiresSoon', {
                name: expiring.checkpoint.name,
                when: expiresIn,
              })}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => keeping.mutate({ checkpointId: expiring.checkpointId, keep: true })}
              disabled={keeping.loading}
              data-testid="checkpoint-tile-keep"
            >
              {t('home.checkpoint.keep')}
            </Button>
          </div>
        )}
      </div>
    </BentoTile>
  );
};
