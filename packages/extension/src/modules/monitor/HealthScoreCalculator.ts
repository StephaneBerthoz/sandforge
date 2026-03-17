import type { ApiLimit, HealthFactor, HealthReport } from '@sandforge/shared';

/** Weight configuration for health factors */
const FACTOR_WEIGHTS: Record<string, { weight: number; category: HealthFactor['category'] }> = {
  DailyApiRequests: { weight: 0.20, category: 'limits' },
  DataStorageMB: { weight: 0.20, category: 'storage' },
  DailySoqlQueries: { weight: 0.15, category: 'limits' },
  DailyDmlStatements: { weight: 0.15, category: 'limits' },
  DailyAsyncApexExecutions: { weight: 0.15, category: 'jobs' },
};

/** Score based on usage percentage */
function usageScore(usedPercent: number): number {
  if (usedPercent < 50) return 100;
  if (usedPercent < 75) return 80;
  if (usedPercent < 90) return 50;
  if (usedPercent < 95) return 20;
  return 0;
}

/** Status from usage percentage */
function usageStatus(usedPercent: number): HealthFactor['status'] {
  if (usedPercent < 75) return 'healthy';
  if (usedPercent < 90) return 'warning';
  return 'critical';
}

/** Generate a recommendation based on the limit name and usage */
function generateRecommendation(name: string, usedPercent: number): string {
  if (usedPercent < 75) return 'No action needed.';
  const prefix = usedPercent >= 90 ? 'Urgent: ' : '';
  switch (name) {
    case 'DailyApiRequests':
      return `${prefix}Review scheduled batch jobs and integrations consuming API calls.`;
    case 'DataStorageMB':
      return `${prefix}Consider archiving old records or cleaning up attachments.`;
    case 'DailySoqlQueries':
      return `${prefix}Optimize triggers and flows that execute excessive SOQL queries.`;
    case 'DailyDmlStatements':
      return `${prefix}Consolidate DML operations in batch processing.`;
    case 'DailyAsyncApexExecutions':
      return `${prefix}Review queued and scheduled Apex jobs for efficiency.`;
    default:
      return `${prefix}Monitor this limit and optimize usage if it continues to grow.`;
  }
}

/** Format a usage detail string */
function formatDetail(_name: string, limit: ApiLimit): string {
  const used = limit.max - limit.remaining;
  return `${limit.usedPercent}% used (${used.toLocaleString()} / ${limit.max.toLocaleString()})`;
}

/**
 * Calculates a detailed health report from API limits.
 * Each limit is scored, weighted, and combined into an overall score with explanations.
 */
export class HealthScoreCalculator {
  /** Compute a full health report from limits data */
  calculate(limits: ApiLimit[]): HealthReport {
    const factors: HealthFactor[] = [];
    let weightedSum = 0;
    let totalWeight = 0;

    // Process known weighted factors
    for (const [limitName, config] of Object.entries(FACTOR_WEIGHTS)) {
      const limit = limits.find((l) => l.name === limitName);
      if (!limit) continue;

      const score = usageScore(limit.usedPercent);
      const factor: HealthFactor = {
        name: limit.name,
        category: config.category,
        score,
        weight: config.weight,
        status: usageStatus(limit.usedPercent),
        detail: formatDetail(limit.name, limit),
        recommendation: generateRecommendation(limit.name, limit.usedPercent),
        trend: 'stable', // Will be enriched by TrendStorage in Phase 2
      };
      factors.push(factor);
      weightedSum += score * config.weight;
      totalWeight += config.weight;
    }

    // Add remaining limits with equal share of remaining weight (0.15 total)
    const remainingLimits = limits.filter(
      (l) => !FACTOR_WEIGHTS[l.name] && l.usedPercent > 0,
    );
    if (remainingLimits.length > 0) {
      const remainingWeight = Math.max(0, 1 - totalWeight);
      const perLimitWeight = remainingWeight / remainingLimits.length;
      for (const limit of remainingLimits) {
        const score = usageScore(limit.usedPercent);
        factors.push({
          name: limit.name,
          category: 'limits',
          score,
          weight: perLimitWeight,
          status: usageStatus(limit.usedPercent),
          detail: formatDetail(limit.name, limit),
          recommendation: generateRecommendation(limit.name, limit.usedPercent),
          trend: 'stable',
        });
        weightedSum += score * perLimitWeight;
        totalWeight += perLimitWeight;
      }
    }

    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 100;
    const overallStatus: HealthReport['overallStatus'] =
      overallScore >= 75 ? 'healthy' : overallScore >= 50 ? 'warning' : 'critical';

    // Sort factors by score ascending (worst first) for topRisks
    const sortedFactors = [...factors].sort((a, b) => a.score - b.score);
    const topRisks = sortedFactors.filter((f) => f.status !== 'healthy').slice(0, 3);

    const summary = this.buildSummary(overallStatus, topRisks);

    return {
      overallScore,
      overallStatus,
      factors,
      summary,
      topRisks,
    };
  }

  private buildSummary(
    status: HealthReport['overallStatus'],
    topRisks: HealthFactor[],
  ): string {
    if (status === 'healthy' && topRisks.length === 0) {
      return 'Your org is healthy. All limits are within safe thresholds.';
    }
    if (status === 'healthy') {
      return `Your org is healthy but ${topRisks[0].name} is trending up.`;
    }
    if (status === 'warning') {
      const names = topRisks.map((r) => r.name).join(', ');
      return `Warning: ${names} approaching limits. Review recommendations.`;
    }
    const names = topRisks.map((r) => r.name).join(', ');
    return `Critical: ${names} at dangerous levels. Immediate action required.`;
  }
}
