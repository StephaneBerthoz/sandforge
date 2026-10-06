import React from 'react';
import { useTranslation } from 'react-i18next';
import { m } from 'framer-motion';
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
  /** Whether the run anonymizes (`ForgeConfig.anonymizePII`); off by default, as the run's is. */
  anonymize?: boolean;
  /** Whether the run writes emails and phone numbers as the source holds them (`ForgeConfig.keepContactPoints`). */
  keepContactPoints?: boolean;
}

/** Status badge color map. */
const statusColors: Record<ForgeGraphNode['status'], string> = {
  idle: 'bg-[color-mix(in_srgb,var(--sf-text-secondary)_10%,transparent)] text-text-primary',
  scanning: 'bg-status-info/10 text-status-info',
  running: 'bg-status-warning/10 text-status-warning',
  done: 'bg-status-success/10 text-status-success',
  error: 'bg-status-error/10 text-status-error',
  skipped: 'bg-[color-mix(in_srgb,var(--sf-text-secondary)_10%,transparent)] text-text-primary',
  stopped: 'bg-status-warning/10 text-status-warning',
};

/** A sample value, and what the run writes in its place. */
interface PreviewSample {
  before: string;
  after: string;
}

/** The sample address and number the preview shows the run's writing of. */
const SAMPLE_EMAIL = 'john.doe@acme.com';
const SAMPLE_PHONE = '+1-555-0123';

/**
 * A number of the mobile range the French regulator keeps for fiction,
 * +33 6 39 98 XX XX, written as the run writes it: no line is ever given one.
 */
const FICTIONAL_PHONE = '+33639981234';

/**
 * What every run writes in an email or a phone field unless told to keep them
 * (`ContactPointNeutralizer` in the extension), anonymizing or not: the
 * address under `.invalid`, which never resolves, and a fictional number.
 * The preview said `u***@***.com` and `+1-***-****`, which no run wrote, and
 * said nothing at all with anonymization off, when every address and number
 * is changed all the same.
 */
const NEUTRALIZED: Record<ContactPoint, PreviewSample> = {
  email: { before: SAMPLE_EMAIL, after: `${SAMPLE_EMAIL}.invalid` },
  phone: { before: SAMPLE_PHONE, after: FICTIONAL_PHONE },
};

/** A persona's address, which an anonymizing run puts under `example.invalid`. */
const ANONYMIZED_EMAIL: PreviewSample = {
  before: SAMPLE_EMAIL,
  after: 'alex.smith@example.invalid',
};

/**
 * What an anonymizing run writes, with Review's default methods: a persona,
 * whose address goes under `example.invalid`, a fictional number, a national
 * id redacted.
 */
const ANONYMIZATION_PREVIEW: ReadonlyMap<string, PreviewSample> = new Map([
  ['Email', ANONYMIZED_EMAIL],
  ['Phone', NEUTRALIZED.phone],
  ['FirstName', { before: 'John', after: 'Alex' }],
  ['LastName', { before: 'Doe', after: 'Smith' }],
  ['SSN', { before: '123-45-6789', after: '[REDACTED]' }],
]);

/** What an email or a phone field anonymized takes, whatever its name. */
const ANONYMIZED: Record<ContactPoint, PreviewSample> = {
  email: ANONYMIZED_EMAIL,
  phone: NEUTRALIZED.phone,
};

type ContactPoint = 'email' | 'phone';

/** Words of an API name that give a field to an email address, as the run reads them. */
const EMAIL_WORDS: ReadonlySet<string> = new Set([
  'email',
  'emails',
  'mail',
  'mails',
  'courriel',
  'courriels',
]);

/** Words of an API name that give a field to a phone number, as the run reads them. */
const PHONE_WORDS: ReadonlySet<string> = new Set([
  'phone',
  'phones',
  'telephone',
  'tel',
  'mobile',
  'cell',
  'fax',
  'sms',
  'gsm',
  'whatsapp',
  'portable',
]);

/**
 * Whether a personal field holds an email address or a phone number, read
 * from the words of its API name as the run reads a text field's — the last
 * word that names one. The node carries its personal fields by name alone:
 * the run itself goes by the field's type, which gives `Email` and
 * `MobilePhone` the same answer.
 */
function contactPointByName(apiName: string): ContactPoint | undefined {
  const words = apiName
    .replace(/__[a-z]+$/i, '')
    .replace(/^[a-z0-9]+__/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase());
  let kind: ContactPoint | undefined;
  for (const word of words) {
    if (EMAIL_WORDS.has(word) || word.endsWith('email')) kind = 'email';
    else if (PHONE_WORDS.has(word) || word.endsWith('phone')) kind = 'phone';
  }
  return kind;
}

/** One row of the preview. */
interface PreviewRow extends PreviewSample {
  field: string;
  /** Whether the run anonymizes the field, rather than only neutralizing it. */
  anonymized: boolean;
}

/**
 * The node's personal fields as the run writes them: each one it anonymizes,
 * and each email or phone field it neutralizes. A field the run writes as the
 * source holds it has no row.
 */
function previewRows(
  node: Pick<ForgeGraphNode, 'piiFields' | 'anonymizeFields'>,
  anonymize: boolean,
  keepContactPoints: boolean,
): PreviewRow[] {
  const fields = [...new Set([...node.piiFields, ...node.anonymizeFields])];
  const rows: PreviewRow[] = [];
  for (const field of fields) {
    const kind = contactPointByName(field);
    if (anonymize && node.anonymizeFields.includes(field)) {
      const sample = ANONYMIZATION_PREVIEW.get(field) ??
        (kind ? ANONYMIZED[kind] : undefined) ?? { before: 'value', after: '***' };
      rows.push({ field, ...sample, anonymized: true });
    } else if (kind && !keepContactPoints) {
      rows.push({ field, ...NEUTRALIZED[kind], anonymized: false });
    }
  }
  return rows;
}

/**
 * Right-panel component showing selected object details in the
 * Forge discovery phase. Displays object name, stats, PII fields,
 * anonymization toggles, and error messages.
 */
export const ForgeNodeDetail: React.FC<ForgeNodeDetailProps> = ({
  node,
  onToggleIncluded,
  onToggleAnonymize,
  anonymize = false,
  keepContactPoints = false,
}) => {
  const { t } = useTranslation();
  const preview = previewRows(node, anonymize, keepContactPoints);

  return (
    <m.div
      data-testid="forge-node-detail"
      className="flex flex-col gap-4 p-4 h-full overflow-y-auto"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* Header: object name + status badge */}
      <m.div variants={slideUp} className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-text-primary">{node.objectApiName}</h3>
        {/* In words: the badge printed the code — "done", "error" — in every language. */}
        <span
          data-testid="node-status-badge"
          className={cn('rounded-full px-2 py-0.5 text-xs font-medium', statusColors[node.status])}
        >
          {t(`forge.nodeStatus.${node.status}`)}
        </span>
      </m.div>

      {/* Stats row */}
      <m.div variants={slideUp} className="flex gap-4 text-sm text-text-secondary">
        <span data-testid="node-record-count">
          {t('common.recordCount', { count: node.recordCount })}
        </span>
        <span data-testid="node-field-count">
          {t('common.fieldCount', { count: node.fieldCount })}
        </span>
      </m.div>

      {/* Include toggle */}
      <m.div variants={slideUp} className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{t('forge.includeNode')}</span>
        <button
          type="button"
          data-testid="node-include-toggle"
          role="switch"
          aria-label={t('forge.includeNode')}
          aria-checked={node.included}
          onClick={onToggleIncluded}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            node.included ? 'bg-(--sf-accent,#F97316)' : 'bg-(--sf-bg-input)',
          )}
        >
          <span
            className={cn(
              'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
              node.included ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </button>
      </m.div>

      {/* PII Fields section */}
      {node.piiFields.length > 0 && (
        <m.div variants={slideUp} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-status-warning">
            <Shield size={14} />
            <span>{t('forge.piiFields')}</span>
          </div>
          <ul className="flex flex-col gap-1" data-testid="pii-fields-list">
            {node.piiFields.map((field) => (
              <li
                key={field}
                className="flex items-center justify-between rounded-sm bg-surface-1 px-2 py-1.5 text-sm"
              >
                <span className="text-text-primary">{field}</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <span className="text-xs text-text-secondary">{t('forge.anonymize')}</span>
                  <input
                    type="checkbox"
                    data-testid={`anonymize-toggle-${field}`}
                    checked={node.anonymizeFields.includes(field)}
                    onChange={() => onToggleAnonymize(field)}
                    className="accent-(--sf-accent,#F97316)"
                  />
                </label>
              </li>
            ))}
          </ul>
        </m.div>
      )}

      {/* What the run writes in the node's personal fields: shown for the
          fields it anonymizes, and for the emails and phone numbers every run
          neutralizes, anonymizing or not. */}
      {preview.length > 0 && (
        <m.div variants={slideUp} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <CheckCircle size={14} className="text-status-success" />
            <span data-testid="anonymization-preview-title">
              {preview.some((row) => row.anonymized)
                ? t('forge.anonymizationPreview')
                : t('forge.contactPointsPreview')}
            </span>
          </div>
          <div
            data-testid="anonymization-preview"
            className="rounded-sm border border-subtle bg-surface-1 p-2 text-xs"
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
                {preview.map((row) => (
                  <tr
                    key={row.field}
                    data-testid={`anonymization-preview-${row.field}`}
                    className="text-text-primary"
                  >
                    <td className="py-0.5 font-medium">{row.field}</td>
                    <td className="py-0.5 text-status-error line-through">{row.before}</td>
                    <td className="py-0.5 text-status-success">{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </m.div>
      )}

      {/* Errors section */}
      {node.errors.length > 0 && (
        <m.div variants={slideUp} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-status-error">
            <XCircle size={14} />
            <span>{t('common.error')}</span>
          </div>
          <ul data-testid="node-errors-list" className="flex flex-col gap-1">
            {node.errors.map((err, idx) => (
              <li
                key={idx}
                className="flex items-start gap-1.5 rounded-sm bg-status-error/10 px-2 py-1.5 text-xs text-status-error"
              >
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </li>
            ))}
          </ul>
        </m.div>
      )}
    </m.div>
  );
};
