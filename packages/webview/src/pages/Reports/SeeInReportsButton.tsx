import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { useAppStore } from '../../stores/useAppStore';
import type { NavigationIntent } from '../../stores/useAppStore';

/** Props for {@link SeeInReportsButton}. */
export interface SeeInReportsButtonProps {
  /** The Reports tab that lists what the history it sits in lists. */
  tab: NonNullable<NavigationIntent['reportsTab']>;
  testId: string;
}

/**
 * Opens Reports where the runs of a module's history are kept across
 * modules: Sync's on Executions, beside Forge's, Automation's on the Audit
 * trail, where the writes of each step are. No page led there: Reports was
 * reached from the command palette alone.
 */
export const SeeInReportsButton: React.FC<SeeInReportsButtonProps> = ({ tab, testId }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<Icon name="graph" />}
      onClick={() => navigate('reports', { reportsTab: tab })}
      data-testid={testId}
    >
      {t('common.seeInReports')}
    </Button>
  );
};
