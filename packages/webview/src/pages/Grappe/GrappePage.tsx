import React from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Layers, Cpu, Gauge, Play, Square } from 'lucide-react';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { useAppStore } from '../../stores/useAppStore';

/**
 * Grappe module page — partitioned-run dashboard.
 *
 * Shows the partitions a run reports as it goes: Seed reports one per chunk it
 * writes, Sync one per object, Autopilot only the start and the end. Nothing
 * here runs anything; the store is fed by the `grappe:*` events the
 * orchestrators emit around their sequential loops.
 */
export const GrappePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
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
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto" data-testid="grappe-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-hue-indigo/10 border border-hue-indigo/20">
            <Network className="w-6 h-6 text-hue-indigo" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary">{t('nav.grappe', 'Grappe')}</h1>
            <p className="text-xs text-text-secondary">
              {t('grappe.subtitle', 'Per-partition progress for large-scale data operations')}
            </p>
          </div>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Layers className="w-5 h-5 text-hue-indigo shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">{totalPartitions}</div>
              <div className="text-[10px] text-text-secondary">
                {t('grappe.partitions', 'Partitions')}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Cpu className="w-5 h-5 text-hue-cyan shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">
                {totalRecords.toLocaleString()}
              </div>
              <div className="text-[10px] text-text-secondary">
                {t('grappe.totalRecords', 'Records')}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Play className="w-5 h-5 text-status-success shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">
                {currentProcessed.toLocaleString()}
              </div>
              <div className="text-[10px] text-text-secondary">
                {t('grappe.processed', 'processed')}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Square className="w-5 h-5 text-status-error shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">
                {totalFailed.toLocaleString()}
              </div>
              <div className="text-[10px] text-text-secondary">{t('grappe.failed', 'failed')}</div>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Active Operation */}
      {active ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('grappe.active', 'Grappe')} — {t('grappe.activeTitle', 'Active Execution')}
          </h2>
          <Card className="border border-subtle bg-surface-1">
            <CardBody>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Network className="w-4 h-4 text-hue-indigo" />
                  <Badge variant="info">
                    {totalPartitions} {t('grappe.partitions', 'partitions')}
                  </Badge>
                </div>
                <span className="text-xs tabular-nums text-text-secondary">
                  {currentProcessed.toLocaleString()} / {totalRecords.toLocaleString()}
                </span>
              </div>
              {/* Overall progress bar */}
              <div data-testid="grappe-progress">
                <ProgressBar
                  value={overallProgress}
                  ariaLabel={t('a11y.runProgress', { name: t('nav.grappe', 'Grappe') })}
                  barClassName="bg-gradient-to-r from-hue-indigo to-hue-purple"
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-text-secondary">
                  {overallProgress}% {t('grappe.completed', 'Completed')}
                </span>
                {totalFailed > 0 && (
                  <span className="text-[10px] text-status-error">
                    {totalFailed.toLocaleString()} {t('grappe.failed', 'failed')}
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
        /* Empty State */
        <Card className="border border-dashed border-hue-indigo/30 bg-hue-indigo/5">
          <CardBody className="flex flex-col items-center gap-4 py-12">
            <div className="p-4 rounded-2xl bg-hue-indigo/10">
              <Network className="w-10 h-10 text-hue-indigo" />
            </div>
            <div className="text-center">
              <h2 className="text-sm font-semibold text-text-primary mb-1">
                {t('grappe.emptyTitle', 'No Active Grappes')}
              </h2>
              <p className="text-xs text-text-primary max-w-sm">{t('grappe.emptyDesc')}</p>
            </div>
            {/*
             * Grappe is switched on in Settings, not here: it needs
             * `sandforge.grappe.enabled`, and then a run past
             * `sandforge.grappe.autoActivateThreshold` records. This page has no
             * control over either, so the only useful thing to offer from an
             * idle dashboard is a module that produces such runs. Seed, Sync
             * and Autopilot are the three that emit grappe:* events; Forge
             * emits none, so the CTA that pointed there could never populate
             * this page. Seed is the shortest path of the three.
             */}
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('seed')}
                data-testid="grappe-settings"
              >
                {t('grappe.openSeed')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Architecture Overview */}
      <Card className="border-0 bg-surface-1">
        <CardBody>
          <h3 className="text-xs font-semibold text-text-primary mb-3">
            {t('grappe.howItWorks', 'How Grappe Works')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-hue-indigo/10">
                <Layers className="w-5 h-5 text-hue-indigo" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step1Title', 'Smart Partitioning')}
              </span>
              <span className="text-[10px] text-text-secondary">
                {t(
                  'grappe.step1Desc',
                  'Data is split into optimal partitions based on dependencies and size',
                )}
              </span>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-hue-cyan/10">
                <Cpu className="w-5 h-5 text-hue-cyan" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step2Title', 'Partition Queue')}
              </span>
              <span className="text-[10px] text-text-secondary">
                {t(
                  'grappe.step2Desc',
                  'Partitions are processed one after another, each reported as it completes',
                )}
              </span>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-hue-green/10">
                <Gauge className="w-5 h-5 text-hue-green" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step3Title', 'Run Totals')}
              </span>
              <span className="text-[10px] text-text-secondary">
                {t(
                  'grappe.step3Desc',
                  'When the run ends, the view keeps the partition count and the records processed and failed',
                )}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
