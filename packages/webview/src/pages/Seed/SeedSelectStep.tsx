import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { InfoTooltip } from '../../components/ui/InfoTooltip';
import type { useNL2SOQL } from '../../hooks/useAIFeatures';
import { Step2SelectObjects } from './Step2_SelectObjects';
import type { SeedObjectInfo } from './Step2_SelectObjects';
import type { PIIObjectResult } from './useSeedWizardState';

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
  /** Whether any object has PII warnings. */
  hasPiiWarnings: boolean;
  /** PII scan results per object. */
  piiResults: PIIObjectResult[];
  /** NL2SOQL query input value. */
  nl2soqlQuery: string;
  /** Update the NL2SOQL query input. */
  onNl2soqlQueryChange: (q: string) => void;
  /** Trigger NL2SOQL conversion. */
  onNl2soqlSubmit: () => void;
  /** NL2SOQL mutation state. */
  nl2soql: ReturnType<typeof useNL2SOQL>;
}

/**
 * Step 1 (Select) of the Seed wizard: org selector, object multi-select
 * with inline volumes, PII warnings, and the NL2SOQL helper.
 * Subscribes to org/object selection slices from `useSeedWizardStore`.
 */
export const SeedSelectStep: React.FC<SeedSelectStepProps> = ({
  availableObjects,
  loadingObjects,
  volumes,
  onChangeVolume,
  hasPiiWarnings,
  piiResults,
  nl2soqlQuery,
  onNl2soqlQueryChange,
  onNl2soqlSubmit,
  nl2soql,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useSeedWizardStore((s) => s.selectedOrgId);
  const handleOrgSelect = useSeedWizardStore((s) => s.handleOrgSelect);
  const selectedObjects = useSeedWizardStore((s) => s.selectedObjects);
  const handleToggleObject = useSeedWizardStore((s) => s.handleToggleObject);

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="seed-step-select-content">
      <div className="flex items-center gap-1.5">
        <InfoTooltip id="help.seed.selectObjects" content={t('help.seed.selectObjects')} />
      </div>
      {/* Org selector */}
      <Select
        label={t('seed.selectOrg')}
        options={orgs.map((org) => ({
          value: org.id,
          label: `${org.alias || org.username} ${String(org.orgType).toLowerCase().includes('production') ? '[PROD]' : '[SBX]'}`,
        }))}
        value={selectedOrgId}
        onChange={(e) => handleOrgSelect(e.target.value)}
        placeholder={t('seed.selectOrg')}
        data-testid="org-selector"
      />

      {/* Object multi-select with inline volume */}
      {selectedOrgId &&
        (loadingObjects ? (
          <div
            className="flex flex-col gap-[var(--sf-space-2)]"
            data-testid="seed-objects-skeleton"
          >
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
                      value={volumes[obj]?.count ?? 100}
                      onChange={(e) => onChangeVolume(obj, parseInt(e.target.value, 10) || 0)}
                      className="w-24"
                      data-testid={`volume-${obj}`}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* PII badge warnings on selected objects */}
            {hasPiiWarnings && (
              <div
                className="flex flex-col gap-[var(--sf-space-2)] p-[var(--sf-space-3)] rounded border border-amber-600 bg-amber-950/30"
                role="alert"
                data-testid="pii-scan-warning"
              >
                <span className="text-sm font-medium text-amber-400">
                  {t('seed.piiWarningTitle')}
                </span>
                {piiResults
                  .filter((r: PIIObjectResult) => r.piiFields.length > 0)
                  .map((r: PIIObjectResult) => (
                    <div key={r.objectName} className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-text-primary">{r.objectName}</span>
                      <div className="flex flex-wrap gap-1">
                        {r.piiFields.map((f: PIIObjectResult['piiFields'][number]) => (
                          <Badge key={`${r.objectName}-${f.fieldName}`} variant="warning">
                            {f.fieldName} ({f.piiType} -- {Math.round(f.confidence * 100)}%)
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                <span className="text-xs text-amber-400/80">{t('seed.piiWarningHint')}</span>
              </div>
            )}

            {/* NL2SOQL Helper */}
            <div
              className="flex flex-col gap-[var(--sf-space-2)] p-[var(--sf-space-3)] rounded border border-[var(--sf-border-input)] bg-[var(--sf-bg-primary)]"
              data-testid="nl2soql-helper"
            >
              <span className="text-xs font-medium text-text-primary">
                {t('seed.nl2soqlTitle')}
              </span>
              <div className="flex gap-[var(--sf-space-2)] items-end">
                <div className="flex-1">
                  <Input
                    placeholder={t('seed.nl2soqlPlaceholder')}
                    value={nl2soqlQuery}
                    onChange={(e) => onNl2soqlQueryChange(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && onNl2soqlSubmit()}
                    disabled={nl2soql.loading || !selectedOrgId}
                    data-testid="nl2soql-input"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={nl2soql.loading}
                  disabled={!nl2soqlQuery.trim() || !selectedOrgId}
                  onClick={onNl2soqlSubmit}
                  data-testid="nl2soql-button"
                >
                  {t('seed.nl2soqlGenerate')}
                </Button>
              </div>
              {nl2soql.data?.soql && (
                <div className="relative group" data-testid="nl2soql-result">
                  <pre className="text-xs p-2.5 rounded bg-[var(--sf-bg-input)] font-mono text-text-primary overflow-x-auto whitespace-pre-wrap">
                    {nl2soql.data.soql}
                  </pre>
                  <button
                    className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => navigator.clipboard.writeText(nl2soql.data?.soql ?? '')}
                    data-testid="nl2soql-copy"
                  >
                    {t('common.copy')}
                  </button>
                </div>
              )}
              {nl2soql.data?.explanation && (
                <span className="text-xs text-text-secondary">{nl2soql.data.explanation}</span>
              )}
              {(nl2soql.error ??
                (nl2soql.data && !nl2soql.data.success ? nl2soql.data.error : null)) && (
                <span
                  className="text-xs text-[var(--sf-error)]"
                  role="alert"
                  data-testid="nl2soql-error"
                >
                  {nl2soql.error ?? nl2soql.data?.error ?? t('seed.nl2soqlError')}
                </span>
              )}
            </div>
          </>
        ))}
    </div>
  );
};
