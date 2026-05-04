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
                  <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {summary.totalOperations}
                  </span>
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
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
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('reports.successRate')}
                  </span>
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <div className="flex flex-col items-center">
                  <span className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    {(summary.avgDuration / 1000).toFixed(1)}s
                  </span>
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
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
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('reports.errorRate')}
                  </span>
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
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--vscode-panel-border, #3c3c3c)"
                    />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--vscode-descriptionForeground, #868686)' }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--vscode-descriptionForeground, #868686)' }}
                    />
                    <Tooltip />
                    <Bar dataKey="value" fill="var(--vscode-textLink-foreground, #3794ff)" />
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
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--vscode-panel-border, #3c3c3c)"
                    />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--vscode-descriptionForeground, #868686)' }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--vscode-descriptionForeground, #868686)' }}
                    />
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
