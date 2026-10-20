import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sprout } from 'lucide-react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { orgToFill } from '../../utils/orgToFill';

/** Props for SeedInsteadHint. */
export interface SeedInsteadHintProps {
  /** Test id of the hint. */
  testId: string;
}

/**
 * "Only one org? Generate realistic data with Seed", shown where a module that
 * copies between two orgs meets someone with one.
 *
 * Forge, Autopilot and Sync each stopped there: "Source and target must be
 * different", the one org disabled in the second list, "Connect a second
 * org". None pointed at the module that works with one empty org, which is
 * the case SandForge is for: a trailblazer alone with a Developer Edition.
 * The link opens Seed's template gallery on that org. Shown only when there is
 * an org to fill: a production org alone is not offered a seed.
 */
export const SeedInsteadHint: React.FC<SeedInsteadHintProps> = ({ testId }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);
  const target = orgToFill(orgs, selectedOrgId);
  if (!target) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-md text-xs bg-surface-1 border border-subtle"
      data-testid={testId}
    >
      <Sprout size={14} className="text-hue-green shrink-0" aria-hidden="true" />
      <button
        type="button"
        className="text-left text-(--sf-text-link) underline hover:no-underline"
        onClick={() => navigate('seed', { seedMode: 'quick-seed', targetOrgId: target.id })}
        data-testid={`${testId}-action`}
      >
        {t('emptyState.onlyOneOrgSeed')}
      </button>
    </div>
  );
};
