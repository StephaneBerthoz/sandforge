import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ComplianceFrameworkType } from '@sandforge/shared';
import { Button } from '../../../components/ui/Button';

/** Step4Review component props. */
export interface Step4ReviewProps {
  /** Source org ID */
  readonly sourceOrgId: string;
  /** Target org ID */
  readonly targetOrgId: string;
  /** Selected object API names */
  readonly selectedObjects: string[];
  /** Total records to transfer */
  readonly totalRecords: number;
  /** Estimated API calls */
  readonly estimatedApiCalls: number;
  /** Estimated duration in minutes */
  readonly estimatedDurationMin: number;
  /** Selected compliance framework */
  readonly complianceFramework: ComplianceFrameworkType;
  /** Whether execution is in progress */
  readonly isExecuting: boolean;
  /** Callback to start execution */
  readonly onExecute: () => void;
}

/** Step 4: Review execution plan and start. */
export const Step4Review: React.FC<Step4ReviewProps> = ({
  sourceOrgId,
  targetOrgId,
  selectedObjects,
  totalRecords,
  estimatedApiCalls,
  estimatedDurationMin,
  complianceFramework,
  isExecuting,
  onExecute,
}) => {
  const { t } = useTranslation();

  /** Format numbers with locale separators. */
  const fmt = (n: number): string => n.toLocaleString();

  /** Map compliance framework to display label. */
  const frameworkLabel = (fw: ComplianceFrameworkType): string => {
    const labels: Record<ComplianceFrameworkType, string> = {
      gdpr: 'GDPR',
      ccpa: 'CCPA',
      hipaa: 'HIPAA',
      pci_dss: 'PCI-DSS',
      custom: 'Custom',
      none: 'None',
    };
    return labels[fw];
  };

  return (
    <div className="flex flex-col gap-[var(--sf-space-4)]" data-testid="step4-review">
      <p className="text-sm text-[var(--vscode-descriptionForeground,#868686)]">
        {t('autopilot.step4.description')}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard
          label={t('autopilot.step4.totalObjects')}
          value={String(selectedObjects.length)}
          testId="stat-objects"
        />
        <StatCard
          label={t('autopilot.step4.totalRecords')}
          value={fmt(totalRecords)}
          testId="stat-records"
        />
        <StatCard
          label={t('autopilot.step4.estimatedDuration')}
          value={`~${estimatedDurationMin} min`}
          testId="stat-duration"
        />
        <StatCard
          label={t('autopilot.step4.estimatedApiCalls')}
          value={fmt(estimatedApiCalls)}
          testId="stat-api-calls"
        />
        <StatCard
          label={t('autopilot.step4.complianceFramework')}
          value={frameworkLabel(complianceFramework)}
          testId="stat-compliance"
        />
        <StatCard
          label={t('autopilot.step4.anonymization')}
          value={
            complianceFramework === 'none'
              ? t('autopilot.step4.noAnonymization')
              : t('autopilot.step4.autoDetect')
          }
          testId="stat-anonymization"
        />
      </div>

      <div className="flex flex-col gap-2 p-3 rounded border border-[var(--vscode-panel-border,#3c3c3c)] bg-[var(--vscode-editor-background,#1e1e1e)]">
        <span className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('autopilot.step4.connectionSummary')}
        </span>
        <div className="flex items-center gap-2 text-xs text-[var(--vscode-descriptionForeground,#868686)]">
          <span>
            {t('autopilot.step4.source')}: {sourceOrgId}
          </span>
          <span className="text-[var(--vscode-editor-foreground,#d4d4d4)]">&rarr;</span>
          <span>
            {t('autopilot.step4.target')}: {targetOrgId}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3 rounded border border-[var(--vscode-panel-border,#3c3c3c)] bg-[var(--vscode-editor-background,#1e1e1e)]">
        <span className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('autopilot.step4.selectedObjects')}
        </span>
        <div className="flex flex-wrap gap-1">
          {selectedObjects.map((obj) => (
            <span
              key={obj}
              className="px-2 py-0.5 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-editor-foreground,#d4d4d4)]"
            >
              {obj}
            </span>
          ))}
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button
          variant="primary"
          size="md"
          onClick={onExecute}
          loading={isExecuting}
          disabled={isExecuting}
          data-testid="execute-button"
        >
          {isExecuting ? t('autopilot.step4.executing') : t('autopilot.step4.execute')}
        </Button>
      </div>
    </div>
  );
};

/** StatCard — displays a single stat value with label. */
interface StatCardProps {
  /** Stat label */
  readonly label: string;
  /** Stat value */
  readonly value: string;
  /** Test ID */
  readonly testId: string;
}

/** Stat card component for the review step. */
const StatCard: React.FC<StatCardProps> = ({ label, value, testId }) => (
  <div
    className="flex flex-col gap-1 p-3 rounded bg-[var(--vscode-input-background,#3c3c3c)]"
    data-testid={testId}
  >
    <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">{label}</span>
    <span className="text-lg font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
      {value}
    </span>
  </div>
);
