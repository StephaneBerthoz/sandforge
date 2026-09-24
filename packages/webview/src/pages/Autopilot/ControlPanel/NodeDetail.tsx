import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AutopilotRefusal } from '@sandforge/shared';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import { ProgressBar } from '../../../components/ui/ProgressBar';
import { uiLocale } from '../../../utils/formatters';

/**
 * Why the target refused records: one line per status code and fields, with
 * how many records and the message as the target wrote it. The code comes
 * first because it is what names the problem in every language; the message
 * is in the language of the org's running user.
 */
const RefusalList: React.FC<{ title: string; refusals: AutopilotRefusal[]; testId: string }> = ({
  title,
  refusals,
  testId,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <h5 className="text-xs text-text-secondary">{title}</h5>
      <ul className="flex flex-col gap-1.5">
        {refusals.map((refusal) => (
          <li
            key={`${refusal.statusCode}|${refusal.fields.join(',')}`}
            className="flex flex-col gap-0.5 text-xs"
          >
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <code className="font-mono font-semibold text-text-primary">
                {refusal.statusCode}
              </code>
              {refusal.fields.length > 0 && (
                <span className="text-text-primary">{refusal.fields.join(', ')}</span>
              )}
              <span className="text-text-secondary">
                {t('common.recordCount', { count: refusal.count })}
              </span>
            </span>
            <span className="break-words text-text-secondary">{refusal.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Shows details of the selected node in the dependency graph. */
export const NodeDetail: React.FC = () => {
  const { t } = useTranslation();
  const selectedNode = useAutopilotStore((s) => s.selectedNode());
  const rules = useAutopilotStore((s) => s.rules);

  if (!selectedNode) {
    return (
      <div
        className="flex items-center justify-center py-8 text-sm text-text-secondary"
        data-testid="node-detail-empty"
      >
        {t('autopilot.control.noNodeSelected')}
      </div>
    );
  }

  const nodeRules = rules.filter((r) => r.objectApiName === selectedNode.objectApiName);
  const piiFields = nodeRules.map((r) => r.fieldApiName);

  return (
    <div className="flex flex-col gap-3" data-testid="node-detail">
      {/* Object Name */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text-primary">{selectedNode.objectApiName}</h4>
        <span
          className="px-2 py-0.5 text-[10px] rounded-full font-medium uppercase"
          data-testid="node-status-badge"
        >
          {t(`autopilot.graph.${selectedNode.status}`)}
        </span>
      </div>

      {/* Progress */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-text-secondary">
          <span>{t('common.progress')}</span>
          <span>{selectedNode.progress}%</span>
        </div>
        <ProgressBar value={selectedNode.progress} ariaLabel={t('common.progress')} />
      </div>

      {/* Record Count */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-text-secondary">{t('autopilot.control.recordsProcessed')}</span>
          <span className="font-medium text-text-primary">
            {selectedNode.successCount?.toLocaleString(uiLocale()) ?? 0} /{' '}
            {selectedNode.recordCount.toLocaleString(uiLocale())}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-secondary">{t('autopilot.control.errors')}</span>
          <span className="font-medium text-status-error">{selectedNode.failureCount ?? 0}</span>
        </div>
      </div>

      {(selectedNode.linkedCount ?? 0) > 0 && (
        <div className="flex flex-col gap-0.5 text-xs" data-testid="node-linked">
          <span className="text-text-secondary">{t('autopilot.control.linked')}</span>
          <span className="font-medium text-text-primary">
            {(selectedNode.linkedCount ?? 0).toLocaleString(uiLocale())}
          </span>
        </div>
      )}

      {(selectedNode.leftToThePlatform ?? 0) > 0 && (
        <div className="flex flex-col gap-0.5 text-xs" data-testid="node-left-to-the-platform">
          <span className="text-text-secondary">{t('autopilot.control.leftToThePlatform')}</span>
          <span className="font-medium text-text-primary">
            {(selectedNode.leftToThePlatform ?? 0).toLocaleString(uiLocale())}
          </span>
        </div>
      )}

      {selectedNode.refusals && selectedNode.refusals.length > 0 && (
        <RefusalList
          title={t('autopilot.control.refusals')}
          refusals={selectedNode.refusals}
          testId="node-refusals"
        />
      )}

      {selectedNode.statusesApplied !== undefined && (
        <div className="flex flex-col gap-0.5 text-xs" data-testid="node-statuses">
          <span className="text-text-secondary">{t('autopilot.control.statusesApplied')}</span>
          <span className="font-medium text-text-primary">
            {selectedNode.statusesApplied.toLocaleString(uiLocale())}
          </span>
        </div>
      )}

      {selectedNode.statusRefusals && selectedNode.statusRefusals.length > 0 && (
        <RefusalList
          title={t('autopilot.control.statusRefusals')}
          refusals={selectedNode.statusRefusals}
          testId="node-status-refusals"
        />
      )}

      {/* PII Fields */}
      {piiFields.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-secondary">
            {t('autopilot.control.piiFields')} ({piiFields.length})
          </span>
          <div className="flex flex-wrap gap-1">
            {piiFields.map((field) => (
              <span
                key={field}
                className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--sf-badge-bg)] text-[var(--sf-badge-fg)]"
              >
                {field}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
