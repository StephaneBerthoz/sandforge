import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { slideUp } from '../../motion/presets';
import { cn } from '../../theme';

/** A single metadata diff entry. */
export interface MetadataDiff {
  /** Type of metadata element (e.g. 'field', 'recordType'). */
  type: string;
  /** API name of the missing or mismatched element. */
  name: string;
  /** Severity level. */
  severity: 'warning' | 'error';
}

/** Props for the MetadataDiffBanner component. */
export interface MetadataDiffBannerProps {
  /** List of metadata mismatches between source and target orgs. */
  diffs: MetadataDiff[];
  /** Callback to sync metadata before forge execution. */
  onSyncMetadata?: () => void;
  /** Callback to skip metadata sync. */
  onSkip?: () => void;
}

/**
 * Conditional banner displayed when metadata mismatches are detected
 * between source and target orgs during graph discovery.
 * Shows missing fields, record types, etc. and offers sync / skip actions.
 */
export const MetadataDiffBanner: React.FC<MetadataDiffBannerProps> = ({
  diffs,
  onSyncMetadata,
  onSkip,
}) => {
  const { t } = useTranslation();

  if (diffs.length === 0) {
    return null;
  }

  const hasErrors = diffs.some((d) => d.severity === 'error');

  return (
    <motion.div
      data-testid="metadata-diff-banner"
      variants={slideUp}
      initial="hidden"
      animate="visible"
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-4',
        hasErrors
          ? 'border-red-500/40 bg-red-500/10'
          : 'border-amber-500/40 bg-amber-500/10',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <AlertTriangle
          size={16}
          className={hasErrors ? 'text-red-400' : 'text-amber-400'}
        />
        <span
          className={cn(
            'text-sm font-medium',
            hasErrors ? 'text-red-400' : 'text-amber-400',
          )}
        >
          {t('forge.metadataMismatch')}
        </span>
      </div>

      {/* Diff list */}
      <ul data-testid="diff-list" className="flex flex-col gap-1 text-xs">
        {diffs.map((diff, idx) => (
          <li
            key={`${diff.type}-${diff.name}-${idx}`}
            className={cn(
              'flex items-center gap-2',
              diff.severity === 'error' ? 'text-red-300' : 'text-amber-300',
            )}
          >
            <span className="font-medium">{diff.type}:</span>
            <span>{diff.name}</span>
          </li>
        ))}
      </ul>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {onSyncMetadata && (
          <Button
            data-testid="sync-metadata-btn"
            variant="primary"
            size="sm"
            onClick={onSyncMetadata}
          >
            {t('forge.syncMetadata')}
          </Button>
        )}
        {onSkip && (
          <Button
            data-testid="skip-metadata-btn"
            variant="ghost"
            size="sm"
            onClick={onSkip}
          >
            {t('forge.skipMetadata')}
          </Button>
        )}
      </div>
    </motion.div>
  );
};
