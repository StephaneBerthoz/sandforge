import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Copy, RefreshCw, HelpCircle } from 'lucide-react';
import type { SmartActionRecommendation, SmartActionType } from '@sandforge/shared';
import { Card, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Tooltip } from '../../components/ui/Tooltip';
import { Skeleton } from '../../components/ui/Skeleton';
import { cn } from '../../theme';

/** Props for the SmartActionCard component. */
export interface SmartActionCardProps {
  /** The recommendation to display. */
  recommendation: SmartActionRecommendation;
  /** Called when the user clicks Execute (opens confirmation). */
  onExecute: () => void;
  /** Whether the confirmation dialog is showing. */
  showConfirmation: boolean;
  /** Called when the user confirms execution. */
  onConfirm: () => void;
  /** Called when the user cancels confirmation. */
  onCancel: () => void;
  /** Whether the recommendation is loading. */
  loading?: boolean;
}

/** Map action type to icon component. */
const ACTION_ICONS: Record<SmartActionType, React.FC<{ className?: string }>> = {
  'quick-seed': Sparkles,
  clone: Copy,
  sync: RefreshCw,
  none: Sparkles,
};

/** Map confidence to badge variant. */
function confidenceBadgeVariant(confidence: number): 'success' | 'warning' | 'default' {
  if (confidence >= 0.85) return 'success';
  if (confidence >= 0.7) return 'warning';
  return 'default';
}

/**
 * Prominent recommendation card displayed above the BentoGrid on the HomePage.
 *
 * Shows the recommended action with an icon, translated reason text,
 * confidence badge, "Why?" tooltip, and an Execute button that triggers
 * a confirmation flow before routing to the appropriate module.
 *
 * Hidden (returns null) when the recommendation action is 'none'.
 */
export const SmartActionCard: React.FC<SmartActionCardProps> = ({
  recommendation,
  onExecute,
  showConfirmation,
  onConfirm,
  onCancel,
  loading,
}) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div data-testid="smart-action-loading">
        <Skeleton variant="rect" height="80px" />
      </div>
    );
  }

  if (recommendation.action === 'none') {
    return null;
  }

  const ActionIcon = ACTION_ICONS[recommendation.action];

  if (showConfirmation) {
    return (
      <Card data-testid="smart-action-card">
        <CardBody>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ActionIcon className="w-5 h-5 text-[var(--vscode-focusBorder,#007fd4)]" />
              <span className="text-sm text-text-primary font-medium">
                {t('home.smartAction.confirmMsg', {
                  action: t(`home.smartAction.action.${recommendation.action}`),
                  org: recommendation.details.targetOrgId,
                })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={onConfirm}
                data-testid="smart-action-confirm-btn"
              >
                {t('home.smartAction.confirm')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onCancel}
                data-testid="smart-action-cancel-btn"
              >
                {t('home.smartAction.cancel')}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card data-testid="smart-action-card">
      <CardBody>
        <div
          className={cn(
            'flex items-center justify-between gap-4',
            'border-l-4 border-l-[var(--vscode-focusBorder,#007fd4)] pl-3 -ml-4',
          )}
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <ActionIcon className="w-5 h-5 shrink-0 text-[var(--vscode-focusBorder,#007fd4)]" />
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary truncate">
                  {t('home.smartAction.title')}
                </span>
                <Badge variant={confidenceBadgeVariant(recommendation.confidence)}>
                  {t('home.smartAction.confidence', {
                    value: Math.round(recommendation.confidence * 100),
                  })}
                </Badge>
                <Tooltip content={recommendation.reason}>
                  <button
                    type="button"
                    className="text-text-muted hover:text-text-secondary"
                    aria-label={t('home.smartAction.whyTooltip')}
                    data-testid="smart-action-why-btn"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              </div>
              <span className="text-xs text-text-secondary truncate">
                {t(recommendation.reasonKey)}
              </span>
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={onExecute}
            data-testid="smart-action-execute-btn"
          >
            {t('home.smartAction.execute')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
};
