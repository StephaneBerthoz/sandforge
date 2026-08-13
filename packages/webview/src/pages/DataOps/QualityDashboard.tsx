/**
 * NOT MOUNTED. The DataOps tab for field completeness and duplicate scoring renders `ComingSoon`
 * instead, because nothing in the codebase produces the data this
 * component expects — mounting it against a hardcoded empty array made
 * an unimplemented feature look like a scan that found nothing.
 *
 * Kept rather than deleted: it is the finished UI for when the backend
 * lands, and nothing imports it, so it is tree-shaken out of the build.
 * Re-mount it in DataOpsPage the moment a real producer exists.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DataQualityScanResult, DataQualityRuleType } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { EmptyState } from '../../components/ui/EmptyState';

/** QualityDashboard component props. */
export interface QualityDashboardProps {
  results?: DataQualityScanResult[];
  isScanning?: boolean;
  onRunScan?: () => void;
}

const RULE_LABELS: Record<DataQualityRuleType, string> = {
  completeness: 'dataops.qualityRules.completeness',
  uniqueness: 'dataops.qualityRules.uniqueness',
  format: 'dataops.qualityRules.format',
  range: 'dataops.qualityRules.range',
  referential: 'dataops.qualityRules.referential',
  consistency: 'dataops.qualityRules.consistency',
  freshness: 'dataops.qualityRules.freshness',
};

/** Get variant based on score. */
function scoreVariant(score: number): 'success' | 'warning' | 'error' {
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'error';
}

/** Data quality scanning dashboard. */
export const QualityDashboard: React.FC<QualityDashboardProps> = ({
  results = [],
  isScanning = false,
  onRunScan,
}) => {
  const { t } = useTranslation();

  const avgScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
      : 0;

  return (
    <div className="flex flex-col gap-3" data-testid="quality-dashboard">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('dataops.quality')}</h2>
        <Button
          variant="primary"
          size="sm"
          onClick={onRunScan}
          loading={isScanning}
          data-testid="run-scan-btn"
        >
          {t('dataops.runScan')}
        </Button>
      </div>

      {results.length === 0 && !isScanning && (
        <EmptyState
          icon="graph"
          title={t('dataops.noResults')}
          description={t('dataops.qualityDesc')}
        />
      )}

      {results.length > 0 && (
        <div className="flex items-center gap-3" data-testid="quality-summary">
          <span className="text-xs text-text-secondary">{t('dataops.qualityScore')}:</span>
          <Badge variant={scoreVariant(avgScore)}>{avgScore}%</Badge>
        </div>
      )}

      {results.map((result) => (
        <div
          key={`${result.orgId}-${result.objectApiName}`}
          data-testid={`quality-${result.objectApiName}`}
        >
          <Card>
            <CardHeader
              title={result.objectApiName}
              subtitle={t('common.recordCount', { count: result.totalRecords })}
              action={<Badge variant={scoreVariant(result.score)}>{result.score}%</Badge>}
            />
            <CardBody>
              <div className="flex flex-col gap-2">
                {result.rules.map((rule) => (
                  <div key={rule.fieldApiName + rule.ruleType} className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary w-24">
                      {t(RULE_LABELS[rule.ruleType])}
                    </span>
                    <span className="text-xs text-text-secondary w-16">{rule.fieldApiName}</span>
                    <ProgressBar
                      value={rule.passRate}
                      variant={scoreVariant(rule.passRate)}
                      size="sm"
                      className="flex-1"
                    />
                    <span className="text-xs text-text-secondary w-12 text-right">
                      {Math.round(rule.passRate)}%
                    </span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
