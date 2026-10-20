import React from 'react';
import { useTranslation } from 'react-i18next';

/** Props for {@link SyncPricebookLine}. */
export interface SyncPricebookLineProps {
  /** Test id of the line. */
  testId?: string;
}

/**
 * What an object's result says of the source's standard price book a run
 * matched to the target's instead of writing it, beside the object's other
 * lines as the results step, the Quick Sync results and the history detail
 * show them.
 *
 * It was a sentence among the price books' refusals, so the Sync results and
 * history listed "The standard price book is matched to the target org's,
 * never written." in red, as if a record had been refused.
 */
export const SyncPricebookLine: React.FC<SyncPricebookLineProps> = ({ testId }) => {
  const { t } = useTranslation();
  return (
    <p className="text-[10px] text-text-secondary" data-testid={testId}>
      {t('sync.standardPricebookMatched')}
    </p>
  );
};
