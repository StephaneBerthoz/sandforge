import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeGapsRead } from './useForgeGaps';

/** The words of each part the read could not read, by the part the extension names. */
const PART_KEYS: Readonly<Record<string, string>> = {
  validationRules: 'forge.review.gapsRead.part.validationRules',
  validationRuleFormulas: 'forge.review.gapsRead.part.validationRuleFormulas',
  duplicateRules: 'forge.review.gapsRead.part.duplicateRules',
  duplicateRuleActions: 'forge.review.gapsRead.part.duplicateRuleActions',
  userPermissions: 'forge.review.gapsRead.part.userPermissions',
  targetFields: 'forge.review.gapsRead.part.targetFields',
  sourceFields: 'forge.review.gapsRead.part.sourceFields',
  apiBudget: 'forge.review.gapsRead.part.apiBudget',
};

/** Props for {@link ReviewGapsRead}. */
export interface ReviewGapsReadProps {
  /** Review's read of the target's gaps (`useForgeGaps`). */
  gaps: Pick<ForgeGapsRead, 'pending' | 'read' | 'error'>;
}

/**
 * One line on Review of what the read of the target's metadata found: how
 * many gaps, how many of them refuse rows, what it cost, and what the target
 * would not give. The gaps themselves are shown where the user decides about
 * them; this says the read happened, and what it could not see.
 */
export const ReviewGapsRead: React.FC<ReviewGapsReadProps> = ({ gaps }) => {
  const { t } = useTranslation();
  const { pending, read, error } = gaps;
  if (!pending && !read && !error) return null;
  return (
    <div data-testid="forge-gaps-read" role="status" className="text-xs text-text-secondary">
      {error ? (
        <p data-testid="forge-gaps-read-error">{t('forge.review.gapsRead.error', { error })}</p>
      ) : pending || !read ? (
        <p>{t('forge.review.gapsRead.pending')}</p>
      ) : (
        <>
          <p data-testid="forge-gaps-read-found">
            {[
              t('forge.review.gapsRead.found', { count: read.count }),
              ...(read.blocking > 0
                ? [t('forge.review.gapsRead.blocking', { count: read.blocking })]
                : []),
              t('forge.review.gapsRead.requests', { count: read.requests }),
            ].join(' ')}
          </p>
          {(read.formulasNotRead > 0 || read.unread.length > 0) && (
            <ul data-testid="forge-gaps-read-unread" className="flex flex-col gap-0.5">
              {read.formulasNotRead > 0 && (
                <li>
                  {t('forge.review.gapsRead.formulasNotRead', { count: read.formulasNotRead })}
                </li>
              )}
              {read.unread.map(({ part, reason }, index) => (
                <li key={`${part}-${index}`}>
                  {t('forge.review.gapsRead.unread', {
                    part: PART_KEYS[part] ? t(PART_KEYS[part]) : part,
                    reason,
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};
