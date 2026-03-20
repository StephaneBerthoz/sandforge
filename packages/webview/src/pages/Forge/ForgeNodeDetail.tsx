import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Shield, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import type { ForgeGraphNode } from '../../stores/useForgeStore';
import { cn } from '../../theme';
import { slideUp, staggerContainer } from '../../motion/presets';

/** Props for the ForgeNodeDetail component. */
export interface ForgeNodeDetailProps {
  /** The graph node to display details for. */
  node: ForgeGraphNode;
  /** Callback to toggle the node's inclusion in execution. */
  onToggleIncluded: () => void;
  /** Callback to toggle anonymization for a specific field. */
  onToggleAnonymize: (fieldName: string) => void;
}

/** Status badge color map. */
const statusColors: Record<ForgeGraphNode['status'], string> = {
  idle: 'bg-gray-500/20 text-gray-400',
  scanning: 'bg-blue-500/20 text-blue-400',
  running: 'bg-amber-500/20 text-amber-400',
  done: 'bg-green-500/20 text-green-400',
  error: 'bg-red-500/20 text-red-400',
  skipped: 'bg-gray-500/20 text-gray-300',
};

/** Sample anonymization preview data. */
const ANONYMIZATION_PREVIEW: Record<string, { before: string; after: string }> = {
  Email: { before: 'john.doe@acme.com', after: 'u***@***.com' },
  Phone: { before: '+1-555-0123', after: '+1-***-****' },
  FirstName: { before: 'John', after: 'Alex' },
  LastName: { before: 'Doe', after: 'Smith' },
  SSN: { before: '123-45-6789', after: '***-**-****' },
};

/**
 * Right-panel component showing selected object details in the
 * Forge discovery phase. Displays object name, stats, PII fields,
 * anonymization toggles, and error messages.
 */
export const ForgeNodeDetail: React.FC<ForgeNodeDetailProps> = ({
  node,
  onToggleIncluded,
  onToggleAnonymize,
}) => {
  const { t } = useTranslation();

  return (
    <motion.div
      data-testid="forge-node-detail"
      className="flex flex-col gap-4 p-4 h-full overflow-y-auto"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* Header: object name + status badge */}
      <motion.div variants={slideUp} className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-text-primary">{node.objectApiName}</h3>
        <span
          data-testid="node-status-badge"
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            statusColors[node.status],
          )}
        >
          {node.status}
        </span>
      </motion.div>

      {/* Stats row */}
      <motion.div variants={slideUp} className="flex gap-4 text-sm text-text-secondary">
        <span data-testid="node-record-count">
          {node.recordCount} {t('forge.records')}
        </span>
        <span data-testid="node-field-count">
          {node.fieldCount} {t('forge.fields')}
        </span>
      </motion.div>

      {/* Include toggle */}
      <motion.div variants={slideUp} className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">
          {t('forge.includeNode')}
        </span>
        <button
          type="button"
          data-testid="node-include-toggle"
          role="switch"
          aria-checked={node.included}
          onClick={onToggleIncluded}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            node.included
              ? 'bg-[var(--sf-accent,#F97316)]'
              : 'bg-[var(--vscode-input-background,#3c3c3c)]',
          )}
        >
          <span
            className={cn(
              'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
              node.included ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </button>
      </motion.div>

      {/* PII Fields section */}
      {node.piiFields.length > 0 && (
        <motion.div variants={slideUp} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-amber-400">
            <Shield size={14} />
            <span>{t('forge.piiFields')}</span>
          </div>
          <ul className="flex flex-col gap-1" data-testid="pii-fields-list">
            {node.piiFields.map((field) => (
              <li key={field} className="flex items-center justify-between rounded bg-surface-1 px-2 py-1.5 text-sm">
                <span className="text-text-primary">{field}</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <span className="text-xs text-text-secondary">{t('forge.anonymize')}</span>
                  <input
                    type="checkbox"
                    data-testid={`anonymize-toggle-${field}`}
                    checked={node.anonymizeFields.includes(field)}
                    onChange={() => onToggleAnonymize(field)}
                    className="accent-[var(--sf-accent,#F97316)]"
                  />
                </label>
              </li>
            ))}
          </ul>
        </motion.div>
      )}

      {/* Anonymization preview */}
      {node.anonymizeFields.length > 0 && (
        <motion.div variants={slideUp} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <CheckCircle size={14} className="text-green-400" />
            <span>{t('forge.anonymizationPreview')}</span>
          </div>
          <div
            data-testid="anonymization-preview"
            className="rounded border border-subtle bg-surface-1 p-2 text-xs"
          >
            <table className="w-full">
              <thead>
                <tr className="text-text-secondary">
                  <th className="text-left pb-1">{t('forge.fieldName')}</th>
                  <th className="text-left pb-1">{t('forge.before')}</th>
                  <th className="text-left pb-1">{t('forge.after')}</th>
                </tr>
              </thead>
              <tbody>
                {node.anonymizeFields.map((field) => {
                  const preview = ANONYMIZATION_PREVIEW[field] ?? {
                    before: 'value',
                    after: '***',
                  };
                  return (
                    <tr key={field} className="text-text-primary">
                      <td className="py-0.5 font-medium">{field}</td>
                      <td className="py-0.5 text-red-400 line-through">{preview.before}</td>
                      <td className="py-0.5 text-green-400">{preview.after}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* Errors section */}
      {node.errors.length > 0 && (
        <motion.div variants={slideUp} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-red-400">
            <XCircle size={14} />
            <span>{t('common.error')}</span>
          </div>
          <ul data-testid="node-errors-list" className="flex flex-col gap-1">
            {node.errors.map((err, idx) => (
              <li
                key={idx}
                className="flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-300"
              >
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </motion.div>
  );
};
