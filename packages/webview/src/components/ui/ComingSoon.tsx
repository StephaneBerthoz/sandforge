import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from './Icon';

/** How much room the notice takes. */
export type ComingSoonVariant = 'panel' | 'banner';

/** Props for {@link ComingSoon}. */
export interface ComingSoonProps {
  /** What the tab will do once it is wired, in the user's language. */
  description: string;
  /** `panel` stands in for a tab's content; `banner` sits above content of its own. */
  variant?: ComingSoonVariant;
  /** Test id for the surface hosting this notice. */
  'data-testid'?: string;
}

/**
 * Notice shown where a backend does not exist yet.
 *
 * Three DataOps tabs mounted components against hardcoded empty arrays, so
 * they rendered a normal "nothing found" list. A user who clicks Cleanup and
 * sees an empty list concludes the scan ran and found nothing — or that the
 * feature is broken. Neither is true, and both are worse than saying so.
 *
 * The tab is deliberately kept rather than removed: it tells the reader the
 * capability is planned, which a missing tab does not.
 *
 * `panel` replaces the content it stands in for, so it can afford the height.
 * `banner` sits on top of a surface that does work — the pipeline canvas, the
 * Marketplace list — where the same ten lines of padding would push what the
 * reader came for off the screen, so it is one row and announces itself as a
 * note instead of taking the space of a panel.
 */
export const ComingSoon: React.FC<ComingSoonProps> = ({
  description,
  variant = 'panel',
  'data-testid': testId = 'coming-soon',
}) => {
  const { t } = useTranslation();

  if (variant === 'banner') {
    return (
      <div
        data-testid={testId}
        role="note"
        className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-3 py-2"
      >
        <Icon name="tools" className="shrink-0 text-text-muted" />
        <span className="text-xs font-semibold text-text-primary">{t('common.comingSoon')}</span>
        <p className="text-xs text-text-secondary">{description}</p>
      </div>
    );
  }

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
