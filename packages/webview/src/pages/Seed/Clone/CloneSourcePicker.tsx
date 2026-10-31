import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Select } from '../../../components/ui/Select';
import { OrgBadge } from '../../../components/ui/OrgBadge';
import { Badge } from '../../../components/ui/Badge';
import { Skeleton } from '../../../components/ui/Skeleton';
import { ArrowRight } from 'lucide-react';
import { orgOptionLabel } from '../../../utils/orgFormatters';

/** Props for the CloneSourcePicker component. */
export interface CloneSourcePickerProps {
  /** Currently selected source org ID. */
  sourceOrgId: string;
  /** Selected target org ID, excluded from the source list. */
  targetOrgId: string;
  /** All connected orgs. */
  orgs: SalesforceOrg[];
  /** Callback when a source org is selected. */
  onSourceSelected: (orgId: string) => void;
  /** Callback when a target org is selected. */
  onTargetSelected: (orgId: string) => void;
  /** Whether source objects are being loaded. */
  loading?: boolean;
}

/**
 * Two-column picker of the source org and the target org, each offering every
 * org but the other one, with a directional arrow between them indicating
 * clone direction.
 *
 * The target was read-only, under a title that said to select it: with none
 * selected, the step sent the user out of the wizard to the Organizations
 * page, where Quick Seed, CSV Upload and Sync pick theirs in place.
 */
export const CloneSourcePicker: React.FC<CloneSourcePickerProps> = ({
  sourceOrgId,
  targetOrgId,
  orgs,
  onSourceSelected,
  onTargetSelected,
  loading = false,
}) => {
  const { t } = useTranslation();
  const targetHintId = useId();

  const availableSourceOrgs = orgs.filter((org) => org.id !== targetOrgId);
  const availableTargetOrgs = orgs.filter((org) => org.id !== sourceOrgId);
  const selectedSourceOrg = orgs.find((org) => org.id === sourceOrgId);
  const targetOrg = orgs.find((org) => org.id === targetOrgId);

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="clone-source-picker">
      <span className="text-sm font-semibold text-(--sf-text-primary)">
        {t('seed.clone.sourcePicker.title')}
      </span>

      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-(--sf-space-4)">
        {/* Source org column. The Select's label names it: a span above it
            said the same words a second time. */}
        <div className="flex flex-col gap-(--sf-space-2)" data-testid="clone-source-column">
          <Select
            label={t('seed.clone.sourcePicker.sourceLabel')}
            // Named as every other picker names an org. It read "DevSandbox
            // (sandbox)" here and "DevSandbox [SANDBOX]" on Sync, in English
            // whatever the language, a Developer Edition org as production.
            options={availableSourceOrgs.map((org) => ({
              value: org.id,
              label: orgOptionLabel(org, t),
            }))}
            value={sourceOrgId}
            onChange={(e) => onSourceSelected(e.target.value)}
            placeholder={t('seed.clone.sourcePicker.selectSource')}
            data-testid="clone-source-select"
          />
          {loading && <Skeleton variant="text" width="60%" height="1em" />}
          {selectedSourceOrg && <OrgBadge org={selectedSourceOrg} />}
        </div>

        {/* Direction arrow. A bare div may not carry a label: axe refused it
            as soon as this step was scanned. As an image, its label is read. */}
        <div
          className="flex items-center justify-center pt-6"
          data-testid="clone-direction-arrow"
          role="img"
          aria-label={t('seed.clone.sourcePicker.direction')}
        >
          <ArrowRight size={24} className="text-(--sf-text-link)" />
        </div>

        {/* Target org column: the org selected in SandForge, which the clone
            writes to, chosen here as it is on the Organizations page. */}
        <div className="flex flex-col gap-(--sf-space-2)" data-testid="clone-target-column">
          <Select
            label={t('seed.clone.sourcePicker.targetLabel')}
            options={availableTargetOrgs.map((org) => ({
              value: org.id,
              label: orgOptionLabel(org, t),
            }))}
            value={targetOrgId}
            onChange={(e) => onTargetSelected(e.target.value)}
            placeholder={t('seed.clone.sourcePicker.selectTarget')}
            aria-describedby={targetHintId}
            data-testid="clone-target-select"
          />
          <span id={targetHintId} className="text-xs text-(--sf-text-secondary)">
            {t('seed.clone.sourcePicker.targetHint')}
          </span>
          {targetOrg && <OrgBadge org={targetOrg} />}
        </div>
      </div>

      {/* Same-org warning (defensive) */}
      {sourceOrgId && sourceOrgId === targetOrgId && (
        <span data-testid="clone-same-org-warning">
          <Badge variant="warning">{t('seed.clone.sourcePicker.sameOrgWarning')}</Badge>
        </span>
      )}
    </div>
  );
};
