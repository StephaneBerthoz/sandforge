import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';

/** Props for the QuickSyncCard component. */
export interface QuickSyncCardProps {
  /** Callback when the user clicks the start button. */
  onStart: () => void;
}

/**
 * Quick Sync entry point card displayed on SyncPage above the wizard.
 *
 * Shows a prominent card with a lightning bolt icon, title, subtitle,
 * and a call-to-action button to start the Quick Sync flow.
 */
export const QuickSyncCard: React.FC<QuickSyncCardProps> = ({ onStart }) => {
  const { t } = useTranslation();

  return (
    <Card className="border-[var(--vscode-focusBorder,#007fd4)]" data-testid="quick-sync-card">
      <CardBody>
        <div className="flex items-center gap-4">
          <span
            className="codicon codicon-zap text-2xl text-[var(--vscode-focusBorder,#007fd4)]"
            aria-hidden="true"
          />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
              {t('quickSync.title')}
            </h3>
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-0.5">
              {t('quickSync.subtitle')}
            </p>
          </div>
          <Button variant="primary" size="md" onClick={onStart} data-testid="quick-sync-start-btn">
            {t('quickSync.start')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
};
