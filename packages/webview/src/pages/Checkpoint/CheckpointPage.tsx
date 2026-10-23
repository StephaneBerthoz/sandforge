import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { isDevelopmentOrg } from '@sandforge/shared';
import type {
  CheckpointDeleteResponse,
  CheckpointKeepResponse,
  CheckpointListResponse,
  CheckpointRenameResponse,
  SalesforceOrg,
} from '@sandforge/shared';
import { useOrgStore, selectSelectedOrg } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { CheckpointList } from './CheckpointList';
import { TakeCheckpoint } from './checkpointParts';

/**
 * The Checkpoints page: the checkpoints of an org kept on this machine, read
 * without contacting the org, and Take a checkpoint.
 *
 * A checkpoint is the state of an org's data at a moment. It is offered for
 * a sandbox, a scratch org or a Developer Edition only: on a production org
 * the page says so and offers nothing — the extension refuses a take of one
 * whatever the registry says, after reading the org itself.
 */
export const CheckpointPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const currentOrg = useOrgStore(selectSelectedOrg);
  const selectOrgLocal = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);

  // Home's "Take a checkpoint" opens the page on a take of the org it named,
  // that once: the org picked here afterwards opens on its list.
  const [takeOnArrival, setTakeOnArrival] = useState(
    () => navigationIntent?.route === 'checkpoint' && navigationIntent.takeCheckpoint === true,
  );
  const [arrivedFor] = useState(currentOrg?.id);
  useEffect(() => {
    if (navigationIntent?.route === 'checkpoint') clearNavigationIntent();
  }, [navigationIntent, clearNavigationIntent]);
  const orgId = currentOrg?.id;
  useEffect(() => {
    if (orgId !== arrivedFor) setTakeOnArrival(false);
  }, [orgId, arrivedFor]);

  // The org picked here is the org picked everywhere: the status bar, the
  // sidebar and the other panels follow it, as they follow Monitor's.
  const selectOrg = useCallback(
    (id: string) => {
      selectOrgLocal(id);
      sendBridgeMessage('org:select', { orgId: id });
    },
    [selectOrgLocal],
  );

  if (orgs.length === 0) {
    return (
      <div className="p-(--sf-space-4)" data-testid="checkpoint-page">
        <EmptyState
          icon={<History className="h-8 w-8" aria-hidden="true" />}
          title={t('checkpoint.noOrgs')}
          description={t('checkpoint.concept')}
          actionLabel={t('emptyState.connectOrg')}
          onAction={() => navigate('orgs')}
        />
      </div>
    );
  }

  const connected = orgs.filter((org) => org.status === 'connected');
  let body: React.ReactNode;
  if (!currentOrg) {
    body = <p className="text-sm text-text-primary">{t('checkpoint.noOrg')}</p>;
  } else if (!isDevelopmentOrg(currentOrg)) {
    body = (
      <p
        className="rounded-sm border border-subtle bg-surface-1 p-3 text-sm text-text-primary"
        data-testid="checkpoint-production"
      >
        {t('checkpoint.production')}
      </p>
    );
  } else {
    // One org's checkpoints at a time, started over for another org: its
    // list, a take under way and their answers are that org's alone.
    body = (
      <OrgCheckpoints
        key={currentOrg.id}
        org={currentOrg}
        takeFirst={takeOnArrival && currentOrg.id === arrivedFor}
      />
    );
  }

  return (
    <div
      className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="checkpoint-page"
    >
      <PageHeader
        title={t('nav.checkpoint')}
        subtitle={t('moduleSummary.checkpoint')}
        icon="history"
        actions={
          connected.length > 0 ? (
            <OrgDropdown
              value={currentOrg?.id ?? ''}
              onChange={selectOrg}
              orgs={connected}
              ariaLabel={t('checkpoint.orgPicker')}
              testId="checkpoint-org"
            />
          ) : undefined
        }
      />
      {body}
    </div>
  );
};

/** Props for {@link OrgCheckpoints}. */
interface OrgCheckpointsProps {
  /** A sandbox, a scratch org or a Developer Edition. */
  org: SalesforceOrg;
  /** Open on a take rather than on the list. */
  takeFirst: boolean;
}

/**
 * The checkpoints of one org: its list, read from this machine, what can be
 * done to each — kept, renamed, deleted — and a take.
 */
const OrgCheckpoints: React.FC<OrgCheckpointsProps> = ({ org, takeFirst }) => {
  const { t } = useTranslation();
  const orgName = org.alias || org.username;
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const [taking, setTaking] = useState(takeFirst);

  const listQuery = useBridgeQuery<CheckpointListResponse['payload']>('checkpoint:list', {
    orgId: org.id,
  });
  const deletion = useBridgeMutation<CheckpointDeleteResponse['payload']>('checkpoint:delete');
  const keeping = useBridgeMutation<CheckpointKeepResponse['payload']>('checkpoint:keep');
  const renaming = useBridgeMutation<CheckpointRenameResponse['payload']>('checkpoint:rename');

  // Each change is read back from the store, which is what lists it: a
  // checkpoint deleted, kept or renamed elsewhere meanwhile shows too.
  const refetchList = useLatestRef(() => listQuery.refetch());
  useEffect(() => {
    if (deletion.data || keeping.data || renaming.data) refetchList.current();
  }, [deletion.data, keeping.data, renaming.data, refetchList]);
  // A deleted row takes the focus its Delete held with it: the list's heading
  // takes it, so the keyboard stays in the list.
  const deleted = deletion.data;
  useEffect(() => {
    if (deleted) listHeadingRef.current?.focus();
  }, [deleted]);

  const failed = [deletion, keeping, renaming].find((mutation) => mutation.error !== null);
  const changeError = failed ? (
    <ErrorBanner
      message={failed.error ?? ''}
      code={failed.errorCode}
      onDismiss={failed.reset}
      data-testid="checkpoint-change-error"
    />
  ) : null;

  if (taking) {
    return (
      <TakeCheckpoint
        org={org}
        onClose={() => setTaking(false)}
        onTaken={() => refetchList.current()}
      />
    );
  }
  if (listQuery.data === null && listQuery.error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorBanner
          message={listQuery.error}
          code={listQuery.errorCode}
          data-testid="checkpoint-list-error"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={listQuery.refetch}
          data-testid="checkpoint-list-retry"
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (listQuery.data === null) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" data-testid="checkpoint-list-loading">
        <Skeleton variant="rect" height="64px" />
        <Skeleton variant="rect" height="64px" />
      </div>
    );
  }

  const entries = listQuery.data.checkpoints;
  if (entries.length === 0) {
    return (
      <>
        {changeError}
        <EmptyState
          icon={<History className="h-8 w-8" aria-hidden="true" />}
          title={t('checkpoint.empty.title', { org: orgName })}
          description={t('checkpoint.empty.description', { org: orgName })}
          actionLabel={t('checkpoint.take.open')}
          onAction={() => setTaking(true)}
        />
      </>
    );
  }
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="checkpoint-list-heading"
      aria-busy={listQuery.loading || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="checkpoint-list-heading"
          ref={listHeadingRef}
          tabIndex={-1}
          className="text-base font-semibold text-text-primary"
        >
          {t('checkpoint.list.title', { org: orgName })}
        </h2>
        <Button
          variant="primary"
          onClick={() => setTaking(true)}
          data-testid="checkpoint-take-open"
        >
          {t('checkpoint.take.open')}
        </Button>
      </div>
      {changeError}
      <CheckpointList
        entries={entries}
        orgName={orgName}
        onRename={(checkpointId, name) => renaming.mutate({ checkpointId, name })}
        onKeep={(checkpointId, keep) => keeping.mutate({ checkpointId, keep })}
        onDelete={(checkpointId) => deletion.mutate({ checkpointIds: [checkpointId] })}
      />
    </section>
  );
};
