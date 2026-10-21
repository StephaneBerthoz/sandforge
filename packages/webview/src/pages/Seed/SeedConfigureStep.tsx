import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldRuleType } from '@sandforge/shared';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { Input } from '../../components/ui/Input';
import { Accordion } from '../../components/ui/Accordion';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
import { Step3ConfigureFields } from './Step3_ConfigureFields';
import { SeedRelationsEditor } from './SeedRelationsEditor';
import { SeedRecordTypePicker } from './SeedRecordTypePicker';
import { fieldsForAccountKind } from './seedRecordTypeChoices';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

/** Props for the SeedConfigureStep section. */
export interface SeedConfigureStepProps {
  /** Per-object field configurations. */
  fieldConfigs: ObjectFieldConfig[];
  /** Change the generation rule type for a specific field. */
  onChangeRule: (objectApiName: string, fieldApiName: string, ruleType: FieldRuleType) => void;
  /** Change a configuration parameter for a specific field rule. */
  onChangeConfig: (objectApiName: string, fieldApiName: string, key: string, value: string) => void;
  /** Volume configuration per object. */
  volumes: Record<string, { count: number; batchSize: number }>;
  /** Update the batch size for an object. */
  onChangeBatchSize: (objectApiName: string, size: number) => void;
}

/**
 * Step 2 (Configure) of the Seed wizard: per-object field rules, then batch
 * sizes and relations in the advanced accordion.
 * Subscribes to the object slice of `useSeedWizardStore`.
 */
export const SeedConfigureStep: React.FC<SeedConfigureStepProps> = ({
  fieldConfigs,
  onChangeRule,
  onChangeConfig,
  volumes,
  onChangeBatchSize,
}) => {
  const { t } = useTranslation();
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const recordTypeChoices = useSeedWizardStore((s) => s.recordTypeChoices);

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="seed-step-configure-content">
      <div className="flex items-center gap-1.5">
        <InfoTooltip
          id="seed.stepHelp.configureFields"
          content={t('seed.stepHelp.configureFields')}
        />
      </div>
      {/* The record types the records take: outside the advanced settings,
          as a person account type changes what the accounts are. */}
      <SeedRecordTypePicker fieldConfigs={fieldConfigs} />

      {/* Each account's fields as the run sends them for the record types
          chosen above: a person account's or a business account's. */}
      <Step3ConfigureFields
        objectConfigs={fieldConfigs
          .filter((c) => selectedObjects.includes(c.objectApiName))
          .map((c) => fieldsForAccountKind(c, recordTypeChoices[c.objectApiName] ?? []))}
        onChangeRule={onChangeRule}
        onChangeConfig={onChangeConfig}
      />

      {/* Advanced section (Accordion) */}
      <Accordion
        items={[
          {
            title: t('seed.advancedSettings'),
            content: (
              <div className="flex flex-col gap-3" data-testid="seed-advanced-settings">
                {/* Batch size per object */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-(--sf-text-primary)">
                    {t('seed.batchSize')}
                  </span>
                  {selectedObjects.map((obj) => (
                    <div key={obj} className="flex items-center gap-2 text-xs">
                      <span className="w-40 truncate text-(--sf-text-primary)">{obj}</span>
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        // Same shape as the record counts: one field per
                        // object, named only by the span beside it.
                        aria-label={t('a11y.batchSizeFor', { object: obj })}
                        value={volumes[obj]?.batchSize ?? 200}
                        onChange={(e) =>
                          onChangeBatchSize(obj, parseInt(e.target.value, 10) || 200)
                        }
                        className="w-24"
                        data-testid={`batch-${obj}`}
                      />
                    </div>
                  ))}
                </div>

                {/* Relations handling */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-(--sf-text-primary)">
                    {t('seed.configureRelations')}
                  </span>
                  <SeedRelationsEditor fieldConfigs={fieldConfigs} volumes={volumes} />
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};
