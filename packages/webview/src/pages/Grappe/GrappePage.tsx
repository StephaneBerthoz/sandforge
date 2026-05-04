import React from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Layers, Cpu, Gauge, Play, Square } from 'lucide-react';
import { cn } from '../../theme';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { useGrappeStore } from '../../stores/useGrappeStore';

/** Status color for grappe pressure levels. */
function pressureColor(pressure: string): string {
  switch (pressure) {
    case 'critical':
      return 'text-red-400';
    case 'warning':
      return 'text-amber-400';
    default:
      return 'text-green-400';
  }
}

/** Badge variant for pressure. */
function pressureBadge(pressure: string): 'error' | 'warning' | 'success' {
  switch (pressure) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'success';
  }
}

/**
 * Grappe module page — Parallel execution engine dashboard.
 * Shows active operation, partition progress, and back-pressure indicators.
 */
export const GrappePage: React.FC = () => {
  const { t } = useTranslation();
  const active = useGrappeStore((s) => s.active);
  const totalPartitions = useGrappeStore((s) => s.totalPartitions);
  const totalRecords = useGrappeStore((s) => s.totalRecords);
  const partitions = useGrappeStore((s) => s.partitions);
  const backPressureLevel = useGrappeStore((s) => s.backPressureLevel);
  const apiUsagePercent = useGrappeStore((s) => s.apiUsagePercent);
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
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
            <Network className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary">{t('nav.grappe', 'Grappe')}</h1>
            <p className="text-xs text-text-secondary">
              {t('grappe.subtitle', 'Parallel execution engine for large-scale data operations')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={pressureBadge(backPressureLevel)}>
            <Gauge className={cn('w-3 h-3 mr-1', pressureColor(backPressureLevel))} />
            {t(`grappe.pressure.${backPressureLevel}`, backPressureLevel)}
          </Badge>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Layers className="w-5 h-5 text-indigo-400 shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">{totalPartitions}</div>
              <div className="text-[10px] text-text-muted">
                {t('grappe.partitions', 'Partitions')}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Cpu className="w-5 h-5 text-cyan-400 shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">
                {totalRecords.toLocaleString()}
              </div>
              <div className="text-[10px] text-text-muted">
                {t('grappe.totalRecords', 'Records')}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Play className="w-5 h-5 text-green-400 shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">
                {currentProcessed.toLocaleString()}
              </div>
              <div className="text-[10px] text-text-muted">
                {t('grappe.processed', 'processed')}
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="border-0 bg-surface-1">
          <CardBody className="flex items-center gap-3 py-3">
            <Square className="w-5 h-5 text-red-400 shrink-0" />
            <div>
              <div className="text-lg font-bold text-text-primary">
                {totalFailed.toLocaleString()}
              </div>
              <div className="text-[10px] text-text-muted">{t('grappe.failed', 'failed')}</div>
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
                  <Network className="w-4 h-4 text-indigo-400" />
                  <Badge variant="info">
                    {totalPartitions} {t('grappe.partitions', 'partitions')}
                  </Badge>
                  <span className="text-xs text-text-secondary">API: {apiUsagePercent}%</span>
                </div>
                <span className="text-xs tabular-nums text-text-secondary">
                  {currentProcessed.toLocaleString()} / {totalRecords.toLocaleString()}
                </span>
              </div>
              {/* Overall progress bar */}
              <div className="w-full h-2.5 rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
                  style={{ width: `${overallProgress}%` }}
                  data-testid="grappe-progress"
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-text-muted">
                  {overallProgress}% {t('grappe.completed', 'Completed')}
                </span>
                {totalFailed > 0 && (
                  <span className="text-[10px] text-red-400">
                    {totalFailed.toLocaleString()} {t('grappe.failed', 'failed')}
                  </span>
                )}
              </div>

              {/* Partition breakdown */}
              {partitionList.length > 0 && (
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {partitionList.map((p) => (
                    <div key={p.grappeId} className="flex items-center gap-2">
                      <span className="text-[10px] text-text-muted w-20 truncate">
                        {p.grappeId}
                      </span>
                      <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo-400 transition-all"
                          style={{ width: `${p.percentage}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-text-muted w-8 text-right">
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
        <Card className="border border-dashed border-indigo-500/30 bg-indigo-500/5">
          <CardBody className="flex flex-col items-center gap-4 py-12">
            <div className="p-4 rounded-2xl bg-indigo-500/10">
              <Network className="w-10 h-10 text-indigo-400" />
            </div>
            <div className="text-center">
              <h2 className="text-sm font-semibold text-text-primary mb-1">
                {t('grappe.emptyTitle', 'No Active Grappes')}
              </h2>
              <p className="text-xs text-text-secondary max-w-sm">
                {t(
                  'grappe.emptyDesc',
                  'Grappe automatically activates when operations exceed the parallel threshold. Configure threshold in Settings or launch a Forge operation with large datasets.',
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" data-testid="grappe-settings">
                {t('grappe.configureThreshold', 'Configure Threshold')}
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
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Layers className="w-5 h-5 text-indigo-400" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step1Title', 'Smart Partitioning')}
              </span>
              <span className="text-[10px] text-text-muted">
                {t(
                  'grappe.step1Desc',
                  'Data is split into optimal partitions based on dependencies and size',
                )}
              </span>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-cyan-500/10">
                <Cpu className="w-5 h-5 text-cyan-400" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step2Title', 'Worker Pool')}
              </span>
              <span className="text-[10px] text-text-muted">
                {t(
                  'grappe.step2Desc',
                  'Parallel workers process partitions with back-pressure control',
                )}
              </span>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Gauge className="w-5 h-5 text-green-400" />
              </div>
              <span className="text-[11px] font-medium text-text-primary">
                {t('grappe.step3Title', 'Adaptive Throttle')}
              </span>
              <span className="text-[10px] text-text-muted">
                {t('grappe.step3Desc', 'Monitors API limits and adjusts throughput in real-time')}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
