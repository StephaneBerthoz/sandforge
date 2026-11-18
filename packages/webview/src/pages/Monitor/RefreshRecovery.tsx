import React from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { Button } from '../../components/ui/Button';
import { formatRelativeTime, formatStoredDate } from '../../utils/formatters';
import type { DetectedRefresh } from './RefreshPanel';

/**
 * How long after a refresh was noticed the dashboard leads with it. A
 * Developer sandbox can be refreshed every day, a Full one every 29: a week
 * covers the days a sandbox is brought back into use without the banner
 * staying over a sandbox in use for a month.
 */
export const RECENT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The built-in pipeline a refresh starts: Sandbox Refresh Post-Processing,
 * by the id its template is kept under. Named here rather than read from the
 * catalogue, which would bring every template into the Monitor's bundle.
 */
export const SANDBOX_REFRESH_TEMPLATE_ID = 'tpl-sandbox-refresh';

/**
 * The refresh the dashboard leads with: the newest noticed, while it was
 * noticed within {@link RECENT_REFRESH_MS}. The list comes newest first, as
 * the detector keeps it.
 */
export function recentRefreshOf(detected: readonly DetectedRefresh[]): DetectedRefresh | undefined {
  const [newest] = detected;
  if (newest === undefined) return undefined;
  const at = Date.parse(newest.detectedAt);
  if (Number.isNaN(at)) return undefined;
  return Date.now() - at <= RECENT_REFRESH_MS ? newest : undefined;
}

/**
 * The two ways on from a refreshed sandbox: bring it back into service, on
 * the org the dashboard shows, which is the org selected; or have Automation
 * do the same after each refresh, from its Sandbox Refresh Post-Processing
 * template. The panel said the data was gone and offered nothing after it.
 */
export const RefreshRecoveryActions: React.FC<{ testIdPrefix: string }> = ({ testIdPrefix }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        size="sm"
        onClick={() => navigate('recovery')}
        data-testid={`${testIdPrefix}-bring-back`}
      >
        {t('monitor.sandboxRefresh.recovery.bringBack')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          navigate('automation', { automationTemplateId: SANDBOX_REFRESH_TEMPLATE_ID })
        }
        data-testid={`${testIdPrefix}-automate`}
      >
        {t('monitor.sandboxRefresh.recovery.automate')}
      </Button>
    </span>
  );
};

/**
 * The band at the top of the dashboard after a recent refresh of the org it
 * shows. The panel that lists the refresh is the fourteenth of the page, far
 * below the fold: a refreshed sandbox was read as any other until there.
 */
export const AfterRefreshBanner: React.FC<{ alias: string; refresh: DetectedRefresh }> = ({
  alias,
  refresh,
}) => {
  const { t } = useTranslation();
  // The org's clock may run ahead of this machine's: a refresh noticed "in 5
  // seconds" is said to have been noticed now.
  const age =
    formatStoredDate(Math.min(Date.parse(refresh.detectedAt), Date.now()), (d) =>
      formatRelativeTime(d),
    ) ?? t('common.dateUnknown');
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-status-warning/30 bg-status-warning/5 px-4 py-2"
      data-testid="monitor-after-refresh"
    >
      <ListChecks className="w-4 h-4 text-status-warning shrink-0" aria-hidden="true" />
      <p className="flex-1 min-w-48 text-sm text-text-primary">
        {t('monitor.sandboxRefresh.recovery.banner', { alias, age })}
      </p>
      <RefreshRecoveryActions testIdPrefix="monitor-after-refresh" />
    </div>
  );
};
