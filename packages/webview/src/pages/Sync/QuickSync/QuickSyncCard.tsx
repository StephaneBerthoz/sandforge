import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Icon } from '../../../components/ui/Icon';

/** Props for the QuickSyncCard component. */
export interface QuickSyncCardProps {
  /** Callback when the user clicks the start button. */
  onStart: () => void;
}

/**
 * Quick Sync's entry point, above the wizard's first step: a lightning bolt,
 * what Quick Sync does, and the button that starts it. The only card there:
 * a second one, "Get Started with Sync", started the same flow under another
 * name, and this one stayed above every later step of the wizard.
 */
export const QuickSyncCard: React.FC<QuickSyncCardProps> = ({ onStart }) => {
  const { t } = useTranslation();

  return (
    <Card className="border-(--sf-accent)" data-testid="quick-sync-card">
      <CardBody>
        <div className="flex items-center gap-4">
          <Icon name="zap" className="text-2xl text-(--sf-text-link)" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">{t('quickSync.title')}</h3>
            <p className="text-xs text-text-secondary mt-0.5">{t('quickSync.subtitle')}</p>
          </div>
          <Button variant="primary" size="md" onClick={onStart} data-testid="quick-sync-start-btn">
            {t('quickSync.start')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
};
