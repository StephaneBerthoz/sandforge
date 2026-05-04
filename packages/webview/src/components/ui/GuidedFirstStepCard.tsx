import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody } from './Card';
import { Button } from './Button';
import { Icon } from './Icon';
import { cn } from '../../theme';

/** Props for the GuidedFirstStepCard component. */
export interface GuidedFirstStepCardProps {
  /** Codicon name for the icon. */
  icon: string;
  /** i18n key for the card title. */
  titleKey: string;
  /** i18n key for the card description. */
  descKey: string;
  /** i18n key for the action button label. */
  actionKey: string;
  /** Callback when the action button is clicked. */
  onAction: () => void;
  /** Visual variant controlling the left border color. */
  variant?: 'seed' | 'sync';
}

/**
 * Guided first-step card for onboarding empty states.
 * Renders a Card with colored left border, icon, title, description, and action button.
 * Used on SyncPage and SeedPage to guide new users through their first action.
 */
export const GuidedFirstStepCard: React.FC<GuidedFirstStepCardProps> = ({
  icon,
  titleKey,
  descKey,
  actionKey,
  onAction,
  variant = 'seed',
}) => {
  const { t } = useTranslation();

  const borderColor = variant === 'sync' ? 'border-l-blue-500' : 'border-l-green-500';

  return (
    <Card className={cn('border-l-4', borderColor)} data-testid="guided-first-step-card">
      <CardBody>
        <div className="flex items-start gap-3">
          <Icon
            name={icon}
            className={cn(
              'text-lg mt-0.5',
              variant === 'sync' ? 'text-blue-400' : 'text-green-400',
            )}
          />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)] mb-1">
              {t(titleKey)}
            </h3>
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mb-3">
              {t(descKey)}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={onAction}
              data-testid="guided-first-step-action"
            >
              {t(actionKey)}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
};
