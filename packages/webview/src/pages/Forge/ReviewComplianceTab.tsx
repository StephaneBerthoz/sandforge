import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { ComplianceReport } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';

/** What `forge:compliance:response` carries: no report for the framework `none`. */
interface CompliancePayload {
  report: ComplianceReport | null;
}

/** Supported compliance frameworks. */
const FRAMEWORKS = ['none', 'gdpr', 'ccpa', 'hipaa', 'pci_dss'] as const;

/** Human-readable labels per framework. */
const FRAMEWORK_LABELS: Record<string, string> = {
  none: 'None',
  gdpr: 'GDPR',
  ccpa: 'CCPA',
  hipaa: 'HIPAA',
  pci_dss: 'PCI-DSS',
};

/**
 * The word each status of a report is said in. The badge printed the code
 * itself, upper-cased — "PARTIAL" — in every language.
 */
const STATUS_KEYS: Record<ComplianceReport['overallStatus'], string> = {
  pass: 'forge.review.compliancePass',
  partial: 'forge.review.compliancePartial',
  fail: 'forge.review.complianceFail',
};

/**
 * Compliance tab within the Forge Review phase.
 *
 * Allows the user to select a regulatory framework and displays the report
 * the extension makes of the run as it stands: its anonymize toggle, the
 * fields selected on each object and the method Review holds per category,
 * sent as the run itself sends them. A change to any of them, or to the
 * framework, asks for the report again.
 *
 * It listened for the report alone: a refusal or a failure, which the handler
 * answers on `forge:compliance:error`, left the tab on "Analyzing
 * compliance..." for good. It says what went wrong now, with a retry.
 */
export const ReviewComplianceTab: React.FC = () => {
  const { t } = useTranslation();
  const [framework, setFramework] = useState<string>('none');
  const complianceReport = useForgeStore((s) => s.complianceReport);
  const graph = useForgeStore((s) => s.graph);
  const config = useForgeStore((s) => s.config);
  const anonymizationRules = useForgeStore((s) => s.anonymizationRules);
  const setComplianceReport = useForgeStore((s) => s.setComplianceReport);
  const compliance = useBridgeMutation<CompliancePayload>('forge:compliance:request', {
    responseType: 'forge:compliance:response',
    errorType: 'forge:compliance:error',
  });
  const { mutate, reset } = compliance;

  const requestReport = useCallback(() => {
    if (framework === 'none' || !graph || !config) {
      reset();
      return;
    }
    mutate({ framework, graph, config, anonymizationRules });
  }, [framework, graph, config, anonymizationRules, mutate, reset]);

  useEffect(() => {
    requestReport();
  }, [requestReport]);

  useEffect(() => {
    if (compliance.data) setComplianceReport(compliance.data.report);
  }, [compliance.data, setComplianceReport]);

  const loading = framework !== 'none' && compliance.loading;
  const error = framework !== 'none' && !compliance.loading ? compliance.error : null;
  // A report on another framework, or kept from an earlier run, is not shown
  // as this one's.
  const report =
    framework !== 'none' && !loading && !error && complianceReport?.framework === framework
      ? complianceReport
      : null;

  return (
    <div data-testid="review-compliance-tab" className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        {t('forge.review.framework', 'Framework')}:
        <select
          data-testid="framework-select"
          value={framework}
          onChange={(e) => setFramework(e.target.value)}
          className="bg-surface-3 text-text-primary text-xs rounded-sm px-2 py-1 border border-subtle"
        >
          {FRAMEWORKS.map((f) => (
            <option key={f} value={f}>
              {FRAMEWORK_LABELS[f]}
            </option>
          ))}
        </select>
      </label>

      {framework === 'none' && (
        <p data-testid="no-compliance" className="text-xs text-text-secondary py-4">
          {t(
            'forge.review.noCompliance',
            'No compliance framework selected. Select one to generate a report.',
          )}
        </p>
      )}

      {loading && (
        <p data-testid="compliance-loading" className="text-xs text-text-secondary py-4">
          {t('forge.review.complianceLoading', 'Analyzing compliance...')}
        </p>
      )}

      {error && (
        <div data-testid="compliance-error" className="flex flex-col gap-2 py-2">
          <ErrorBanner
            data-testid="compliance-error-message"
            message={t('forge.review.complianceError', { error })}
          />
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={requestReport}
            data-testid="compliance-retry"
          >
            {t('common.retry')}
          </Button>
        </div>
      )}

      {/* Said it came once the run was executed: the report is asked for as
          soon as a framework is selected. */}
      {framework !== 'none' && !loading && !error && !report && (
        <p data-testid="compliance-waiting" className="text-xs text-text-secondary py-4">
          {t('forge.review.complianceWaiting')}
        </p>
      )}

      {report && (
        <div data-testid="compliance-report" className="rounded-lg border border-subtle p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text-primary">
              {t('forge.review.complianceStatus', 'Status')}
            </span>
            <span
              data-testid="compliance-status"
              className={`text-[10px] px-2 py-0.5 rounded ${
                report.overallStatus === 'pass'
                  ? 'bg-status-success/10 text-status-success'
                  : report.overallStatus === 'partial'
                    ? 'bg-status-warning/10 text-status-warning'
                    : 'bg-status-error/10 text-status-error'
              }`}
            >
              {t(STATUS_KEYS[report.overallStatus])}
            </span>
          </div>
          <div className="text-[10px] text-text-secondary space-y-0.5">
            {/* English whatever the language, and "1 fields anonymized". */}
            <p>{t('forge.piiWarning', { count: report.piiFieldsDetected })}</p>
            <p>{t('forge.review.fieldsAnonymized', { count: report.piiFieldsAnonymized })}</p>
            <p>{t('forge.review.fieldsScanned', { count: report.totalFieldsScanned })}</p>
          </div>
        </div>
      )}
    </div>
  );
};
