import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldRuleType } from '@sandforge/shared';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Skeleton } from '../../components/ui/Skeleton';
import { Accordion } from '../../components/ui/Accordion';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
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
 * sizes, relations, and PII toggles in the advanced accordion.
 * Subscribes to object/relation slices from `useSeedWizardStore`.
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
  const relations = useSeedWizardStore((s) => s.relations);
  const handleAddRelation = useSeedWizardStore((s) => s.handleAddRelation);
  const handleRemoveRelation = useSeedWizardStore((s) => s.handleRemoveRelation);

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
                  <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {t('seed.batchSize')}
                  </span>
                  {selectedObjects.map((obj) => (
                    <div key={obj} className="flex items-center gap-2 text-xs">
                      <span className="w-40 truncate text-[var(--vscode-editor-foreground,#d4d4d4)]">
                        {obj}
                      </span>
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
                  <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {t('seed.configureRelations')}
                  </span>
                  {relations.length === 0 && (
                    <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                      {t('seed.noDependencies')}
                    </p>
                  )}
                  {relations.map((rel, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                        {rel.childObject}.{rel.childField}
                      </span>
                      <Badge variant="default">{'→'}</Badge>
                      <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">
                        {rel.parentObject}.{rel.parentField}
                      </span>
                      <button
                        className="text-[var(--vscode-errorForeground,#f48771)] hover:opacity-70 px-1"
                        onClick={() => handleRemoveRelation(i)}
                        data-testid={`remove-relation-${i}`}
                      >
                        x
                      </button>
                    </div>
                  ))}
                  <button
                    className="text-xs text-[var(--vscode-focusBorder,#007fd4)] hover:underline self-start"
                    onClick={handleAddRelation}
                    data-testid="add-relation-btn"
                  >
                    + {t('seed.addObject')}
                  </button>
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
