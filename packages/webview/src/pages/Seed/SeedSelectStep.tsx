import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Skeleton } from '../../components/ui/Skeleton';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
import { orgOptionLabel } from '../../utils/orgFormatters';
import { Step2SelectObjects } from './Step2_SelectObjects';
import type { SeedObjectInfo } from './Step2_SelectObjects';

/** Props for the SeedSelectStep section. */
export interface SeedSelectStepProps {
  /** List of objects available for seeding from the org describe. */
  availableObjects: SeedObjectInfo[];
  /** Whether the describe-global query is in flight. */
  loadingObjects: boolean;
  /** Volume configuration per object. */
  volumes: Record<string, { count: number; batchSize: number }>;
  /** Update the record count for an object. */
  onChangeVolume: (objectApiName: string, count: number) => void;
}

/**
 * Step 1 (Select) of the Seed wizard: org selector, then the object
 * multi-select with inline volumes.
 * Subscribes to org/object selection slices from `useSeedWizardStore`.
 *
 * It also showed a natural-language SOQL helper, whose query nothing in the
 * seed read — it could only be copied — and a warning that the objects held
 * personal data to anonymize before seeding, on a run whose every value is
 * generated. Both stood between the objects and the counts; both are gone.
 */
export const SeedSelectStep: React.FC<SeedSelectStepProps> = ({
  availableObjects,
  loadingObjects,
  volumes,
  onChangeVolume,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useSeedWizardStore((s) => s.selectedOrgId);
  const handleOrgSelect = useSeedWizardStore((s) => s.handleOrgSelect);
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const handleToggleObject = useSeedWizardStore((s) => s.handleToggleObject);

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="seed-step-select-content">
      <div className="flex items-center gap-1.5">
        <InfoTooltip id="help.seed.selectObjects" content={t('help.seed.selectObjects')} />
      </div>
      {/* Org selector */}
      <Select
        label={t('seed.selectOrg')}
        options={orgs.map((org) => ({
          value: org.id,
          label: orgOptionLabel(org, t),
        }))}
        value={selectedOrgId}
        onChange={(e) => handleOrgSelect(e.target.value)}
        placeholder={t('seed.selectOrg')}
        data-testid="org-selector"
      />

      {/* Object multi-select with inline volume */}
      {selectedOrgId &&
        (loadingObjects ? (
          <div className="flex flex-col gap-(--sf-space-2)" data-testid="seed-objects-skeleton">
            <Skeleton variant="text" width="30%" height="1em" />
            <Skeleton variant="rect" height="120px" />
            <Skeleton variant="text" width="50%" height="1em" />
          </div>
        ) : (
          <>
            <Step2SelectObjects
              availableObjects={availableObjects}
              selectedObjects={selectedObjects}
              onToggle={handleToggleObject}
            />

            {/* Inline volume inputs for selected objects */}
            {selectedObjects.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-text-primary">
                  {t('seed.recordCount')}
                </span>
                {selectedObjects.map((obj) => (
                  <div key={obj} className="flex items-center gap-2 text-xs">
                    <span className="w-40 truncate text-text-primary">{obj}</span>
                    <Input
                      type="number"
                      min={1}
                      // "Record count" heads the whole list; each row's own
                      // name is the object in the span beside the field.
                      aria-label={t('a11y.recordCountFor', { object: obj })}
                      value={volumes[obj]?.count ?? 100}
                      onChange={(e) => onChangeVolume(obj, parseInt(e.target.value, 10) || 0)}
                      className="w-24"
                      data-testid={`volume-${obj}`}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        ))}
    </div>
  );
};
