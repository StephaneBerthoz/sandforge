import React from 'react';
import { useTranslation } from 'react-i18next';
import { NAV_GROUPS, isNavItemShown } from '../../navigation/navGroups';
import { useAppStore } from '../../stores/useAppStore';
import { cn } from '../../theme';

/** Props for {@link AllModulesTile}. */
export interface AllModulesTileProps {
  /** Whether a sandbox is registered: Back into service is listed once one is. */
  sandboxRegistered: boolean;
}

/**
 * Every module, in the launcher's five groups and under the same conditions,
 * each with the sentence that says what it does.
 *
 * Home's "Quick actions" opened Forge, Monitor and Automation and listed no
 * other module, so the page the launcher's Home button opens offered less
 * than the launcher itself; it also put Automation forward while the launcher
 * folded it away.
 */
export const AllModulesTile: React.FC<AllModulesTileProps> = ({ sandboxRegistered }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const facts = { sandboxRegistered };

  return (
    <section
      className="rounded-xl border border-subtle bg-surface-1 p-4"
      aria-labelledby="home-all-modules-title"
      data-testid="quick-actions-tile"
    >
      <h3 id="home-all-modules-title" className="mb-3 text-sm font-semibold text-text-primary">
        {t('home.quickActions')}
      </h3>
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5"
        data-testid="quick-actions-card"
      >
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => isNavItemShown(item, facts));
          if (items.length === 0) return null;
          const headingId = `home-group-${group.id}-title`;
          return (
            <div
              key={group.id}
              role="group"
              aria-labelledby={headingId}
              className="flex min-w-0 flex-col gap-1"
              data-testid={`home-group-${group.id}`}
            >
              <h4
                id={headingId}
                className="mb-1 px-2 text-[11px] font-semibold uppercase leading-tight tracking-wider text-text-secondary"
              >
                {t(group.labelKey)}
              </h4>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    'flex items-start gap-2 rounded-md px-2 py-1.5 text-left',
                    // A ring, not a hover background: the summary's secondary
                    // text falls under AA on the hover colour, as the recent
                    // operations' time did.
                    'hover:ring-1 hover:ring-(--sf-accent) transition-shadow',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
                  )}
                  onClick={() => navigate(item.id)}
                  data-testid={`open-${item.id}-btn`}
                >
                  <span className={cn('mt-0.5 shrink-0', item.accent)} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-text-primary break-words">
                      {t(item.labelKey)}
                    </span>
                    {/* On screen, not in a tooltip: four modules copy from one
                        org to another, and only this sentence tells them apart. */}
                    <span className="text-xs leading-snug text-text-secondary break-words">
                      {t(`moduleSummary.${item.id}`)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
};
