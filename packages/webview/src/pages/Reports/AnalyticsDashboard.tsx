import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts';
import type { AnalyticsTimeSeries } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';

/** Summary statistics for the analytics dashboard. */
export interface AnalyticsSummary {
  totalOperations: number;
  successRate: number;
  avgDuration: number;
  errorRate: number;
}

/** AnalyticsDashboard component props. */
export interface AnalyticsDashboardProps {
  summary?: AnalyticsSummary;
  operationsOverTime?: AnalyticsTimeSeries;
  errorTimeSeries?: AnalyticsTimeSeries;
  className?: string;
}

/** Dashboard displaying operational analytics with Recharts. */
export const AnalyticsDashboard: React.FC<AnalyticsDashboardProps> = ({
  summary,
  operationsOverTime,
  errorTimeSeries,
  className,
}) => {
  const { t } = useTranslation();

  const opsChartData = useMemo(() => {
    if (!operationsOverTime) return [];
    return operationsOverTime.points.map((p) => ({
      time: p.timestamp.slice(0, 10),
      value: p.value,
    }));
  }, [operationsOverTime]);

  const errorChartData = useMemo(() => {
    if (!errorTimeSeries) return [];
    return errorTimeSeries.points.map((p) => ({
      time: p.timestamp.slice(0, 10),
      value: p.value,
    }));
  }, [errorTimeSeries]);

  if (!summary && !operationsOverTime) {
    return (
      <div data-testid="analytics-dashboard" className={className}>
        <EmptyState title={t('reports.noReports')} />
      </div>
    );
  }

  return (
    <div data-testid="analytics-dashboard" className={className}>
      <div className="flex flex-col gap-3">
        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="analytics-summary">
            <Card>
              <CardBody>
                <div className="flex flex-col items-center">
                  <span className="text-lg font-bold text-text-primary">
                    {summary.totalOperations}
                  </span>
                  <span className="text-[10px] text-text-secondary">
                    {t('reports.totalOperations')}
                  </span>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <div className="flex flex-col items-center">
                  <span className="text-lg font-bold text-[var(--sf-success)]">
                    {summary.successRate.toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-text-secondary">
                    {t('reports.successRate')}
                  </span>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <div className="flex flex-col items-center">
                  <span className="text-lg font-bold text-text-primary">
                    {(summary.avgDuration / 1000).toFixed(1)}s
                  </span>
                  <span className="text-[10px] text-text-secondary">
                    {t('reports.avgDuration')}
                  </span>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <div className="flex flex-col items-center">
                  <span className="text-lg font-bold text-[var(--sf-error)]">
                    {summary.errorRate.toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-text-secondary">{t('reports.errorRate')}</span>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {/* Operations over time chart */}
        {opsChartData.length > 0 && (
          <Card>
            <CardHeader title={t('reports.operationsOverTime')} />
            <CardBody>
              <div data-testid="ops-chart" style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={opsChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--sf-border)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--sf-text-secondary)' }}
                    />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--sf-text-secondary)' }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="var(--sf-text-link)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
        )}

        {/* Error rate chart */}
        {errorChartData.length > 0 && (
          <Card>
            <CardHeader title={t('reports.errorRate')} />
            <CardBody>
              <div data-testid="error-chart" style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={errorChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--sf-border)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--sf-text-secondary)' }}
                    />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--sf-text-secondary)' }} />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="var(--sf-error, #EF4444)"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
};
