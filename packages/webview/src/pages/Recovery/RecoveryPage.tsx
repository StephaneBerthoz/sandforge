import React from 'react';
import { useTranslation } from 'react-i18next';
import { isDevelopmentOrg, orgDisplayName } from '@sandforge/shared';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';
import { PageHeader } from '../../components/ui/PageHeader';
import { useAppStore } from '../../stores/useAppStore';
import { selectSelectedOrg, useOrgStore } from '../../stores/useOrgStore';
import { SandboxRecovery } from './SandboxRecovery';

/**
 * Back into service: the steps that bring a sandbox back into use after its
 * refresh, for the org selected, titled after it. A production org is refused
 * before anything of it is asked: the page brings back a sandbox, a scratch
 * org or a Developer Edition org, and the extension refuses one too.
 *
 * Its first screen opens neither the replay nor DataOps: the steps that run
 * there open their page with what it needs, as a navigation.
 */
export const RecoveryPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const org = useOrgStore(selectSelectedOrg);
  const navigate = useAppStore((s) => s.navigate);
  const title = org ? t('recovery.title', { alias: orgDisplayName(org) }) : t('nav.recovery');

  let body: React.ReactNode;
  if (orgs.length === 0) {
    body = (
      <EmptyState
        icon={<Icon name="checklist" />}
        title={t('recovery.noOrgs')}
        description={t('recovery.concept')}
        actionLabel={t('emptyState.connectOrg')}
        onAction={() => navigate('orgs')}
      />
    );
  } else if (!org) {
    body = (
      <p className="text-sm text-text-primary" data-testid="recovery-no-org">
        {t('recovery.noOrg')}
      </p>
    );
  } else if (!isDevelopmentOrg(org)) {
    body = (
      <p
        className="rounded-sm border border-subtle bg-surface-1 p-3 text-sm text-text-primary"
        data-testid="recovery-production"
      >
        {t('recovery.production', { alias: orgDisplayName(org) })}
      </p>
    );
  } else {
    // One org's recovery at a time, started over for another: its status,
    // its users and its audits are that org's alone.
    body = <SandboxRecovery key={org.id} org={org} />;
  }

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="recovery-page">
      <PageHeader title={title} subtitle={t('recovery.subtitle')} icon="checklist" />
      <ModuleHowTo module="recovery" />
      {body}
    </div>
  );
};
