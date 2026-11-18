import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/**
 * How the fields of the object picked on the graph are anonymized, under its
 * details. Nothing when no object is picked, or none of its fields is: the
 * details above say the first, and it was a tab of its own that said "Select
 * a node to view details" as the details did.
 */
export const AnonymizationPreview: React.FC = () => {
  const { t } = useTranslation();
  const selectedNode = useAutopilotStore((s) => s.selectedNode());
  const rules = useAutopilotStore((s) => s.rules);

  const nodeRules = selectedNode
    ? rules.filter((r) => r.objectApiName === selectedNode.objectApiName)
    : [];
  if (nodeRules.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" data-testid="anonymization-preview">
      <h4 className="text-xs font-semibold text-(--sf-text-primary)">
        {t('autopilot.control.anonymization')}
      </h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-(--sf-text-secondary)">
            <th className="py-1 px-2 font-medium">{t('autopilot.report.field')}</th>
            <th className="py-1 px-2 font-medium">{t('autopilot.report.method')}</th>
            <th className="py-1 px-2 font-medium">{t('autopilot.report.category')}</th>
          </tr>
        </thead>
        <tbody>
          {nodeRules.map((rule) => (
            <tr
              key={`${rule.objectApiName}-${rule.fieldApiName}`}
              className="border-t border-(--sf-border)"
            >
              <td className="py-1 px-2 text-(--sf-text-primary)">{rule.fieldApiName}</td>
              <td className="py-1 px-2 text-(--sf-text-primary)">{rule.method}</td>
              <td className="py-1 px-2 text-(--sf-text-primary)">{rule.piiCategory}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};
