import React from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Layers, Cpu, Gauge } from 'lucide-react';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { KPICard } from '../../components/ui/KPICard';
import { PageHeader } from '../../components/ui/PageHeader';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Tooltip } from '../../components/ui/Tooltip';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { useAppStore } from '../../stores/useAppStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { uiLocale } from '../../utils/formatters';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';

/** The setting that turns Grappe on, off by default. */
const GRAPPE_SETTING = 'sandforge.grappe.enabled';

/**
 * Grappe module page — partitioned-run dashboard.
 *
 * Shows the partitions a run reports as it goes: Seed reports one per chunk it
 * writes, Sync one per object, Autopilot only the start and the end. Nothing
 * here runs anything; the store is fed by the `grappe:*` events the
 * orchestrators emit around their sequential loops.
 *
 * Laid out as its neighbours are, a page header and a row of KPI cards: it
 * had its own icon header, its own tiles labelled "processed" and "failed" in
 * lower case, and a centred column narrower than every other page.
 */
export const GrappePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const grappeEnabled = useAppStore((s) => s.grappeEnabled);
  const active = useGrappeStore((s) => s.active);
  const totalPartitions = useGrappeStore((s) => s.totalPartitions);
  const totalRecords = useGrappeStore((s) => s.totalRecords);
  const partitions = useGrappeStore((s) => s.partitions);
  const totalProcessed = useGrappeStore((s) => s.totalProcessed);
  const totalFailed = useGrappeStore((s) => s.totalFailed);

  const partitionList = Array.from(partitions.values());
  const currentProcessed = active
    ? partitionList.reduce((sum, p) => sum + p.processedRecords, 0)
    : totalProcessed;
  const overallProgress =
    totalRecords > 0 ? Math.round((currentProcessed / totalRecords) * 100) : 0;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="grappe-page">
      <PageHeader title={t('nav.grappe')} subtitle={t('grappe.subtitle')} icon="server" />
      <ModuleHowTo module="grappe" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="grappe-kpi-row">
        <KPICard
          icon="package"
          label={t('grappe.partitions')}
          value={totalPartitions.toLocaleString(uiLocale())}
        />
        <KPICard
          icon="database"
          label={t('grappe.totalRecords')}
          value={totalRecords.toLocaleString(uiLocale())}
        />
        <KPICard
          icon="check"
          label={t('grappe.processed')}
          value={currentProcessed.toLocaleString(uiLocale())}
          variant="success"
        />
        <KPICard
          icon="error"
          label={t('grappe.failed')}
          value={totalFailed.toLocaleString(uiLocale())}
          variant={totalFailed > 0 ? 'error' : 'default'}
        />
      </div>

      {/* Active Operation */}
      {active ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-text-primary">{t('grappe.activeTitle')}</h2>
          <Card className="border border-subtle bg-surface-1">
            <CardBody>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Network className="w-4 h-4 text-hue-indigo" />
                  <Badge variant="info">
                    {t('grappe.partitionCount', { count: totalPartitions })}
                  </Badge>
                </div>
                <span className="text-xs tabular-nums text-text-secondary">
                  {currentProcessed.toLocaleString(uiLocale())} /{' '}
                  {totalRecords.toLocaleString(uiLocale())}
                </span>
              </div>
              {/* Overall progress bar */}
              <div data-testid="grappe-progress">
                <ProgressBar
                  value={overallProgress}
                  ariaLabel={t('a11y.runProgress', { name: t('nav.grappe') })}
                  barClassName="bg-linear-to-r from-hue-indigo to-hue-purple"
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-text-secondary">
                  {t('grappe.percentComplete', { percent: overallProgress })}
                </span>
                {totalFailed > 0 && (
                  <span className="text-[10px] text-status-error">
                    {t('grappe.failedCount', {
                      count: totalFailed,
                      formatted: totalFailed.toLocaleString(uiLocale()),
                    })}
                  </span>
                )}
              </div>

              {/* Partition breakdown */}
              {partitionList.length > 0 && (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {partitionList.map((p) => (
                    <div key={p.grappeId} className="flex items-center gap-2">
                      <span className="text-[10px] text-text-secondary w-20 truncate">
                        {p.grappeId}
                      </span>
                      <ProgressBar
                        value={p.percentage}
                        size="sm"
                        className="flex-1"
                        ariaLabel={p.grappeId}
                        barClassName="bg-hue-indigo"
                      />
                      <span className="text-[10px] tabular-nums text-text-secondary w-8 text-right">
                        {p.percentage}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      ) : (
        /*
         * Grappe is switched on in VS Code's Settings, not here: it needs
         * `sandforge.grappe.enabled`, off by default, and then a run past
         * `sandforge.grappe.autoActivateThreshold` records. The page said so
         * and led nowhere; it opens the setting now. The other thing to offer
         * from an idle dashboard is a module that produces such runs. Seed,
         * Sync and Autopilot are the three that emit grappe:* events; Forge
         * emits none, so the CTA that pointed there could never populate this
         * page. Seed is the shortest path of the three.
         *
         * It opened on "Grappe needs sandforge.grappe.enabled." under "No
         * Active Grappes", and never said what the page is for. It says that
         * first now, and the setting's id stays on the button that opens it.
         * Whether the setting is on comes with the settings, so a page opened
         * once it is on no longer asks for it.
         */
        <div data-testid="grappe-empty">
          <EmptyState
            icon={<Icon name="server" />}
            title={t('grappe.emptyTitle')}
            description={t(grappeEnabled ? 'grappe.emptyDescOn' : 'grappe.emptyDesc')}
            action={
              <div className="flex items-center gap-3">
                <Tooltip content={GRAPPE_SETTING} side="bottom">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      sendBridgeMessage<{ setting: string }>('workbench:open-setting', {
                        setting: GRAPPE_SETTING,
                      })
                    }
                    data-testid="grappe-open-setting"
                  >
                    {t('grappe.openSetting')}
                  </Button>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('seed')}
                  data-testid="grappe-settings"
                >
                  {t('grappe.openSeed')}
                </Button>
              </div>
            }
          />
        </div>
      )}

      {/* Architecture Overview */}
      <Card className="border-0 bg-surface-1">
        <CardBody>
          <h2 className="text-xs font-semibold text-text-primary mb-3">{t('grappe.howItWorks')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-hue-indigo/10">
                <Layers className="w-5 h-5 text-hue-indigo" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step1Title')}
              </span>
              <span className="text-[10px] text-text-secondary">{t('grappe.step1Desc')}</span>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-hue-cyan/10">
                <Cpu className="w-5 h-5 text-hue-cyan" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step2Title')}
              </span>
              <span className="text-[10px] text-text-secondary">{t('grappe.step2Desc')}</span>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-hue-green/10">
                <Gauge className="w-5 h-5 text-hue-green" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step3Title')}
              </span>
              <span className="text-[10px] text-text-secondary">{t('grappe.step3Desc')}</span>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
