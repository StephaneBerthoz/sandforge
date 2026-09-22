import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../utils/formatters';

/** Props for {@link ListCapNote}. */
export interface ListCapNoteProps {
  /** Rows the list holds: the bound its read stopped at. */
  shown: number;
  /** Test id, so a page can tell its lists' notes apart. */
  testId: string;
}

/**
 * The line a Monitor list carries when its read came back full.
 *
 * Each list reads a bounded number of rows, newest first. They used to stop
 * at that bound without a word, and the counts drawn from the rows (active
 * users, errors per type, failed jobs) stopped there with them, reading as
 * the org's whole story.
 */
export const ListCapNote: React.FC<ListCapNoteProps> = ({ shown, testId }) => {
  const { t } = useTranslation();
  return (
    <p className="text-[11px] text-text-secondary mb-2" data-testid={testId}>
      {t('monitor.listStopsAt', { shown: formatNumber(shown) })}
    </p>
  );
};
