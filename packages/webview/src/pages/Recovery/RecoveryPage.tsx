import React from 'react';
import { useTranslation } from 'react-i18next';
import { orgDisplayName } from '@sandforge/shared';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PageHeader } from '../../components/ui/PageHeader';
import { selectSelectedOrg, useOrgStore } from '../../stores/useOrgStore';

/**
 * Back into service: the steps that bring a sandbox back into use after its
 * refresh, for the org selected. Titled after that org; its steps are not
 * listed yet.
 */
export const RecoveryPage: React.FC = () => {
  const { t } = useTranslation();
  const org = useOrgStore(selectSelectedOrg);
  const title = org ? t('recovery.title', { alias: orgDisplayName(org) }) : t('nav.recovery');

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="recovery-page">
      <PageHeader title={title} icon="checklist" />
      <EmptyState
        icon={<Icon name="checklist" />}
        title={t('recovery.emptyTitle')}
        description={t('recovery.emptyDesc')}
      />
    </div>
  );
};
