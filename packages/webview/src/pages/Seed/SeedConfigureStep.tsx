import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldRuleType } from '@sandforge/shared';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Skeleton } from '../../components/ui/Skeleton';
import { Accordion } from '../../components/ui/Accordion';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
import { ComingSoon } from '../../components/ui/ComingSoon';
import { Step3ConfigureFields } from './Step3_ConfigureFields';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { PIIObjectResult } from './useSeedWizardState';

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
  /** Whether the PII scan is in progress. */
  piiLoading: boolean;
  /** Whether any object has PII warnings. */
  hasPiiWarnings: boolean;
  /** PII scan results per object. */
  piiResults: PIIObjectResult[];
}

/**
 * Step 2 (Configure) of the Seed wizard: per-object field rules, batch
 * sizes and PII toggles in the advanced accordion. Relations are announced
 * as not yet wired -- nothing carries them into the seed payload.
 * Subscribes to the object slice of `useSeedWizardStore`.
 */
export const SeedConfigureStep: React.FC<SeedConfigureStepProps> = ({
  fieldConfigs,
  onChangeRule,
  onChangeConfig,
  volumes,
  onChangeBatchSize,
  piiLoading,
  hasPiiWarnings,
  piiResults,
}) => {
  const { t } = useTranslation();
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-3)]"
      data-testid="seed-step-configure-content"
    >
      <div className="flex items-center gap-1.5">
        <InfoTooltip id="help.seed.configureFields" content={t('help.seed.configureFields')} />
      </div>
      {/* Collapsible field tree per object */}
      {piiLoading && (
        <div className="flex flex-col gap-[var(--sf-space-2)]" data-testid="pii-scan-loading">
          <Skeleton variant="text" width="40%" height="1em" />
          <Skeleton variant="rect" height="80px" />
        </div>
      )}

      <Step3ConfigureFields
        objectConfigs={fieldConfigs.filter((c) => selectedObjects.includes(c.objectApiName))}
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
                  <span className="text-xs font-medium text-[var(--sf-text-primary)]">
                    {t('seed.batchSize')}
                  </span>
                  {selectedObjects.map((obj) => (
                    <div key={obj} className="flex items-center gap-2 text-xs">
                      <span className="w-40 truncate text-[var(--sf-text-primary)]">{obj}</span>
                      <Input
                        type="number"
                        min={1}
                        max={10000}
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
                  <span className="text-xs font-medium text-[var(--sf-text-primary)]">
                    {t('seed.configureRelations')}
                  </span>
                  {/* "+ Add relation" appended an empty row rendered as
                      ". → .Id": the editor (Step4ConfigureRelations) is never
                      mounted, so no field could be filled in, and
                      useSeedExecution.handleExecute never puts relations in the
                      seed payload. Saying the capability is not wired beats a
                      row nobody can complete. */}
                  <ComingSoon
                    data-testid="seed-relations-soon"
                    description={t('seed.configureRelationsDesc')}
                  />
                </div>

                {/* PII toggles */}
                {hasPiiWarnings && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-amber-400">
                      {t('seed.piiWarningTitle')}
                    </span>
                    {piiResults
                      .filter((r: PIIObjectResult) => r.piiFields.length > 0)
                      .map((r: PIIObjectResult) => (
                        <div key={r.objectName} className="flex flex-wrap gap-1">
                          {r.piiFields.map((f: PIIObjectResult['piiFields'][number]) => (
                            <Badge key={`${r.objectName}-${f.fieldName}`} variant="warning">
                              {f.fieldName} ({f.piiType})
                            </Badge>
                          ))}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};
