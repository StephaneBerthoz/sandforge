import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import { useSendMessage, useMessageListener } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import type { BaseMessage, ComplianceReport } from '@sandforge/shared';

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
 * Compliance tab within the Forge Review phase.
 *
 * Allows the user to select a regulatory framework and displays
 * the compliance report when available. Sends a compliance request
 * to the backend when a non-none framework is selected.
 */
export const ReviewComplianceTab: React.FC = () => {
  const { t } = useTranslation();
  const [framework, setFramework] = useState<string>('none');
  const [loading, setLoading] = useState(false);
  const complianceReport = useForgeStore((s) => s.complianceReport);
  const graph = useForgeStore((s) => s.graph);
  const config = useForgeStore((s) => s.config);
  const setComplianceReport = useForgeStore((s) => s.setComplianceReport);
  const sendMessage = useSendMessage();

  // Send compliance request when framework changes to a non-none value
  useEffect(() => {
    if (framework === 'none' || !graph || !config) {
      setLoading(false);
      return;
    }
    setLoading(true);
    sendMessage(
      buildMessage('forge:compliance:request', {
        framework,
        graph,
        config,
      }),
    );
  }, [framework, graph, config, sendMessage]);

  // Listen for compliance response from backend
  useMessageListener<BaseMessage & { payload: { report: ComplianceReport } }>(
    'forge:compliance:response',
    useCallback(
      (msg) => {
        setComplianceReport(msg.payload.report);
        setLoading(false);
      },
      [setComplianceReport],
    ),
  );

  return (
    <div data-testid="review-compliance-tab" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-text-muted">
          {t('forge.review.framework', 'Framework')}:
        </label>
        <select
          data-testid="framework-select"
          value={framework}
          onChange={(e) => setFramework(e.target.value)}
          className="bg-surface-3 text-text-primary text-xs rounded px-2 py-1 border border-subtle"
        >
          {FRAMEWORKS.map((f) => (
            <option key={f} value={f}>
              {FRAMEWORK_LABELS[f]}
            </option>
          ))}
        </select>
      </div>

      {framework === 'none' && (
        <p data-testid="no-compliance" className="text-xs text-text-muted py-4">
          {t(
            'forge.review.noCompliance',
            'No compliance framework selected. Select one to generate a report.',
          )}
        </p>
      )}

      {framework !== 'none' && loading && !complianceReport && (
        <p data-testid="compliance-loading" className="text-xs text-text-muted py-4">
          {t('forge.review.complianceLoading', 'Analyzing compliance...')}
        </p>
      )}

      {framework !== 'none' && !loading && !complianceReport && (
        <p data-testid="compliance-waiting" className="text-xs text-text-muted py-4">
          {t(
            'forge.review.complianceWaiting',
            'Select a framework and execute to generate compliance report.',
          )}
        </p>
      )}

      {complianceReport && (
        <div data-testid="compliance-report" className="rounded-lg border border-subtle p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text-primary">
              {t('forge.review.complianceStatus', 'Status')}: {complianceReport.overallStatus}
            </span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded ${
                complianceReport.overallStatus === 'pass'
                  ? 'bg-green-500/20 text-green-400'
                  : complianceReport.overallStatus === 'partial'
                    ? 'bg-orange-500/20 text-orange-400'
                    : 'bg-red-500/20 text-red-400'
              }`}
            >
              {complianceReport.overallStatus.toUpperCase()}
            </span>
          </div>
          <div className="text-[10px] text-text-muted space-y-0.5">
            <p>{complianceReport.piiFieldsDetected} PII fields detected</p>
            <p>{complianceReport.piiFieldsAnonymized} fields anonymized</p>
            <p>{complianceReport.totalFieldsScanned} total fields scanned</p>
          </div>
        </div>
      )}
    </div>
  );
};
