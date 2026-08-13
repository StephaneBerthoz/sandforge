import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from './Icon';

/** Props for {@link ComingSoon}. */
export interface ComingSoonProps {
  /** What the tab will do once it is wired, in the user's language. */
  description: string;
  /** Test id for the surface hosting this notice. */
  'data-testid'?: string;
}

/**
 * Panel shown in place of a tab whose backend does not exist yet.
 *
 * Three DataOps tabs mounted components against hardcoded empty arrays, so
 * they rendered a normal "nothing found" list. A user who clicks Cleanup and
 * sees an empty list concludes the scan ran and found nothing — or that the
 * feature is broken. Neither is true, and both are worse than saying so.
 *
 * The tab is deliberately kept rather than removed: it tells the reader the
 * capability is planned, which a missing tab does not.
 */
export const ComingSoon: React.FC<ComingSoonProps> = ({
  description,
  'data-testid': testId = 'coming-soon',
}) => {
  const { t } = useTranslation();

  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-6 py-10 text-center"
    >
      <Icon name="tools" className="text-text-muted" />
      <div className="text-sm font-semibold text-text-primary">{t('common.comingSoon')}</div>
      <p className="max-w-md text-xs text-text-secondary">{description}</p>
    </div>
  );
};
