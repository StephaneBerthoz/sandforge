import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Sparkles, Copy, RefreshCw, HelpCircle } from 'lucide-react';
import type {
  OrgRecordCounts,
  SmartActionObject,
  SmartActionRecommendation,
  SmartActionType,
} from '@sandforge/shared';
import { SAMPLE_DATA_CEILING } from '@sandforge/shared';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Tooltip } from '../../components/ui/Tooltip';
import { Skeleton } from '../../components/ui/Skeleton';
import { useOrgStore } from '../../stores/useOrgStore';
import { cn } from '../../theme';

/** Props for the SmartActionCard component. */
export interface SmartActionCardProps {
  /** The recommendation to display. */
  recommendation: SmartActionRecommendation;
  /** Called when the user clicks Execute (opens confirmation). */
  onExecute: () => void;
  /** Whether the confirmation dialog is showing. */
  showConfirmation: boolean;
  /** Called when the user confirms execution, and for a fill, as the button is clicked. */
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

/** What the confirmation of a clone or a sync names the page it opens by. */
const CONFIRMED_ACTION_KEYS: Record<'clone' | 'sync', string> = {
  clone: 'home.smartAction.action.clone',
  sync: 'home.smartAction.action.sync',
};

/** Each counted object: its plural key, and its slot in the sentence that lists them. */
const COUNTED: ReadonlyArray<{ object: SmartActionObject; key: string; slot: string }> = [
  { object: 'Account', key: 'home.smartAction.count.Account', slot: 'accounts' },
  { object: 'Contact', key: 'home.smartAction.count.Contact', slot: 'contacts' },
  { object: 'Opportunity', key: 'home.smartAction.count.Opportunity', slot: 'opportunities' },
  { object: 'Case', key: 'home.smartAction.count.Case', slot: 'cases' },
  { object: 'Lead', key: 'home.smartAction.count.Lead', slot: 'leads' },
];

/**
 * What was counted in one org, in the panel's language: "DevSandbox: 13
 * accounts, 20 contacts, …", and "fewer than 50 of each" when it holds sample
 * data at most and something at all.
 */
function countsOf(t: TFunction, org: string, counts: OrgRecordCounts): string {
  const values = COUNTED.map(({ object }) => counts[object] ?? 0);
  const vars: Record<string, string | number> = { org, ceiling: SAMPLE_DATA_CEILING };
  COUNTED.forEach(({ key, slot }, i) => {
    vars[slot] = t(key, { count: values[i] });
  });
  const sampleOnly = values.some((n) => n > 0) && values.every((n) => n < SAMPLE_DATA_CEILING);
  return t(sampleOnly ? 'home.smartAction.countsUnderCeiling' : 'home.smartAction.counts', vars);
}

/**
 * Prominent recommendation card displayed above the BentoGrid on the HomePage.
 *
 * Shows the recommended action with an icon, its translated reason, a "Why?"
 * tooltip saying what was counted in each org, and the button that acts on
 * it. A fill reads "Fill <org> with demo data", the words the side panel,
 * Organizations and Home's Quick Actions give the same act, and opens Seed's
 * gallery at once as they do: it read "Set it up", then asked "Open Quick
 * Seed for <org>?", three names for one act that writes nothing before
 * Seed's own confirmation. A clone or a sync still asks which page opens.
 *
 * It showed an "NN% confidence" badge, a fixed number per rule rather than a
 * measurement, and a tooltip in English whatever the language.
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
  // The recommendation carries the org ids. The confirmation is read by
  // somebody who picked that org by its alias and has never seen its id, so
  // the name is resolved here and the id is only the last resort.
  const { targetOrgId, sourceOrgId, recordCounts, sourceRecordCounts } = recommendation.details;
  const orgs = useOrgStore((state) => state.orgs);
  const nameOf = (id: string): string => {
    const org = orgs.find((candidate) => candidate.id === id);
    return org?.alias || org?.username || id;
  };
  const targetOrgName = nameOf(targetOrgId);

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

  const action = recommendation.action;
  const ActionIcon = ACTION_ICONS[action];

  if (showConfirmation && action !== 'quick-seed') {
    return (
      <Card data-testid="smart-action-card">
        <CardBody>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ActionIcon className="w-5 h-5 text-(--sf-text-link)" />
              <span className="text-sm text-text-primary font-medium">
                {t('home.smartAction.confirmMsg', {
                  action: t(CONFIRMED_ACTION_KEYS[action]),
                  org: targetOrgName,
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

  const why = [
    countsOf(t, targetOrgName, recordCounts),
    ...(sourceOrgId && sourceRecordCounts
      ? [countsOf(t, nameOf(sourceOrgId), sourceRecordCounts)]
      : []),
  ].join('\n');

  return (
    <Card data-testid="smart-action-card">
      <CardBody>
        <div
          className={cn(
            'flex items-center justify-between gap-4',
            'border-l-4 border-l-(--sf-accent) pl-3 -ml-4',
          )}
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <ActionIcon className="w-5 h-5 shrink-0 text-(--sf-text-link)" />
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary truncate">
                  {t('home.smartAction.title')}
                </span>
                <Tooltip content={why} className="whitespace-pre-line">
                  <button
                    type="button"
                    className="text-text-secondary hover:text-text-primary"
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
            onClick={action === 'quick-seed' ? onConfirm : onExecute}
            data-testid="smart-action-execute-btn"
          >
            {action === 'quick-seed'
              ? t('home.fillOrg', { alias: targetOrgName })
              : t('home.smartAction.execute')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
};
