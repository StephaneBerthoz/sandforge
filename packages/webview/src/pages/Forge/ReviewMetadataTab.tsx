import React from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';

/** CSS classes for severity badge variants. */
const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-blue-500/20 text-blue-400',
  warning: 'bg-orange-500/20 text-orange-400',
  error: 'bg-red-500/20 text-red-400',
};

/**
 * Metadata tab within the Forge Review phase.
 *
 * Shows a list of metadata differences (missing fields, type mismatches,
 * permission issues) between source and target orgs, each with a severity badge.
 */
export const ReviewMetadataTab: React.FC = () => {
  const { t } = useTranslation();
  const diffs = useForgeStore((s) => s.metadataDiffs);

  if (diffs.length === 0) {
    return (
      <div data-testid="review-metadata-tab" className="py-4">
        <p data-testid="no-diffs" className="text-xs text-text-muted text-center">
          {t('forge.review.noDiffs', 'No metadata differences detected.')}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="review-metadata-tab" className="flex flex-col gap-2">
      <p className="text-xs text-text-muted">
        {t(
          'forge.review.diffsFound',
          '{{count}} differences found between source and target.',
        ).replace('{{count}}', String(diffs.length))}
      </p>
      {diffs.map((diff, idx) => (
        <div
          key={`diff-${idx}`}
          data-testid={`diff-${idx}`}
          className="rounded border border-subtle p-2 text-xs"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-text-primary">
              {diff.objectApiName}.{diff.fieldApiName}
            </span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded ${SEVERITY_STYLES[diff.severity]}`}>
              {diff.severity.toUpperCase()}
            </span>
          </div>
          <p className="text-text-muted text-[10px]">{diff.details}</p>
        </div>
      ))}
    </div>
  );
};
