import type { ApiLimit, HealthFactor, HealthReport, OrgInfo, TrendData } from '@sandforge/shared';
import type { TrendStorage } from './TrendStorage.js';

/** Weight and category configuration for a known limit factor. */
interface LimitFactorConfig {
  weight: number;
  category: HealthFactor['category'];
}

/** Metadata counts for complexity scoring. */
export interface MetadataCounts {
  customObjectCount: number;
  customFieldCount: number;
  apexClassCount: number;
}

/** Security settings for security dimension scoring. */
export interface SecuritySettings {
  passwordMinLength: number;
  passwordComplexity: boolean;
  sessionTimeout: number;
  mfaEnabled: boolean;
  ipRestrictions: boolean;
}

/** Input for the unified health score calculation. */
export interface UnifiedHealthInput {
  /** Current API limits snapshot. */
  limits: ApiLimit[];
  /** Org identifier (used for trend lookups). */
  orgId: string;
  /** Optional trend storage for real trend data integration. */
  trendStorage?: TrendStorage;
  /** Optional org info (provides metadata counts fallback). */
  orgInfo?: OrgInfo;
  /** Optional code coverage percentage (0-100). */
  codeCoverage?: number;
  /** Optional metadata counts for complexity dimension. */
  metadataCounts?: MetadataCounts;
  /** Optional security settings for security dimension. */
  securitySettings?: SecuritySettings;
}

/** Weight configuration for the 5 core limit factors. */
const CORE_LIMIT_FACTORS: Record<string, LimitFactorConfig> = {
  DailyApiRequests: { weight: 0.2, category: 'limits' },
  DataStorageMB: { weight: 0.2, category: 'storage' },
  DailySoqlQueries: { weight: 0.15, category: 'limits' },
  DailyDmlStatements: { weight: 0.15, category: 'limits' },
  DailyAsyncApexExecutions: { weight: 0.15, category: 'jobs' },
};

/** Base weight allocated to all limit factors combined. */
const BASE_LIMITS_WEIGHT = 1.0;

/** Weight per optional dimension when all 3 are present. */
const OPTIONAL_DIMENSION_WEIGHT = 0.15;

/** Weight for limits when all 3 optional dimensions are present. */
const LIMITS_WEIGHT_WITH_ALL_OPTIONAL = 0.55;

/**
 * Two-segment piecewise linear scoring for usage-based limits.
 * Higher usage = worse score (monotonically decreasing, continuous).
 *
 * - 0-50% usage: score = 100 - (usedPercent * 0.6)  => range [100, 70]
 * - 50-100% usage: score = 70 - ((usedPercent - 50) * 1.4)  => range [70, 0]
 *
 * @param usedPercent - Usage percentage (0-100).
 * @returns Score between 0 and 100.
 */
function linearUsageScore(usedPercent: number): number {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  let score: number;
  if (clamped <= 50) {
    score = 100 - clamped * 0.6;
  } else {
    score = 70 - (clamped - 50) * 1.4;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Two-segment piecewise linear scoring for code coverage.
 * Higher coverage = better score.
 *
 * - 0-75%: score = (coverage / 75) * 70  => range [0, 70]
 * - 75-100%: score = 70 + ((coverage - 75) / 25) * 30  => range [70, 100]
 *
 * @param coverage - Code coverage percentage (0-100).
 * @returns Score between 0 and 100.
 */
function linearCoverageScore(coverage: number): number {
  const clamped = Math.max(0, Math.min(100, coverage));
  let score: number;
  if (clamped <= 75) {
    score = (clamped / 75) * 70;
  } else {
    score = 70 + ((clamped - 75) / 25) * 30;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Count-based complexity score (lower count = better).
 * Linear interpolation between low and high thresholds.
 *
 * @param count - Actual count.
 * @param low   - Threshold below which score is 100.
 * @param high  - Threshold above which score is 20.
 * @returns Score between 20 and 100.
 */
function complexityScore(count: number, low: number, high: number): number {
  if (count <= low) return 100;
  if (count >= high) return 20;
  const ratio = (count - low) / (high - low);
  return Math.round(100 - ratio * 80);
}

/**
 * Map TrendData.direction to HealthFactor.trend vocabulary.
 * - up (more usage) -> degrading
 * - down (less usage) -> improving
 * - stable -> stable
 *
 * @param direction - The trend direction from TrendStorage.
 * @returns The mapped HealthFactor trend.
 */
function mapTrendDirection(direction: TrendData['direction']): HealthFactor['trend'] {
  switch (direction) {
    case 'up':
      return 'degrading';
    case 'down':
      return 'improving';
    case 'stable':
      return 'stable';
  }
}

/**
 * Calculate a trend-based penalty for degrading factors.
 * Penalty is proportional to changePercent, capped at 15 points.
 *
 * @param trendData - The trend data for the factor.
 * @returns Penalty value between 0 and 15.
 */
function trendPenalty(trendData: TrendData): number {
  if (trendData.direction !== 'up') return 0;
  return Math.min(15, Math.max(0, Math.abs(trendData.changePercent) * 0.5));
}

/**
 * Map a factor score to a health status.
 *
 * @param score - Factor score (0-100).
 * @returns Health status string.
 */
function scoreToStatus(score: number): HealthFactor['status'] {
  if (score >= 70) return 'healthy';
  if (score >= 40) return 'warning';
  return 'critical';
}

/**
 * Generate a recommendation based on limit name and usage percentage.
 *
 * @param name - The limit name.
 * @param usedPercent - Usage percentage.
 * @returns Recommendation string.
 */
function generateLimitRecommendation(name: string, usedPercent: number): string {
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

/**
 * Format a usage detail string for a limit factor.
 *
 * @param limit - The API limit data.
 * @returns Human-readable detail string.
 */
function formatLimitDetail(limit: ApiLimit): string {
  const used = limit.max - limit.remaining;
  return `${limit.usedPercent}% used (${used.toLocaleString()} / ${limit.max.toLocaleString()})`;
}

/**
 * Unified health scorer that replaces both HealthScoreCalculator and
 * OrgHealthScoreCalculator.
 *
 * Features:
 * - Continuous linear interpolation scoring (no step-function cliffs)
 * - Real trend data integration from TrendStorage with degrading penalties
 * - Optional metadata/coverage/security dimensions with dynamic weight redistribution
 * - Single HealthReport output that serves both monitor:data and monitor:health-score
 */
export class UnifiedHealthScorer {
  /**
   * Calculate a complete health report from limits and optional enrichment data.
   *
   * @param input - The unified health input containing limits and optional data sources.
   * @returns A full HealthReport with factors, overall score, summary, and top risks.
   */
  calculate(input: UnifiedHealthInput): HealthReport {
    const factors: HealthFactor[] = [];
    const optionalDimensionCount = this.countOptionalDimensions(input);

    // Compute weight scaling for limits based on optional dimensions present
    const limitsWeightMultiplier = this.computeLimitsWeightMultiplier(optionalDimensionCount);

    // 1. Process core limit factors
    this.addCoreLimitFactors(input, factors, limitsWeightMultiplier);

    // 2. Process remaining limits with non-zero usage
    this.addRemainingLimitFactors(input, factors, limitsWeightMultiplier);

    // 3. Add optional dimensions when data is provided
    const optDimWeight = this.computeOptionalDimensionWeight(optionalDimensionCount);
    this.addMetadataDimension(input, factors, optDimWeight);
    this.addCoverageDimension(input, factors, optDimWeight);
    this.addSecurityDimension(input, factors, optDimWeight);

    // 4. Compute overall score as weighted average
    const { weightedSum, totalWeight } = factors.reduce(
      (acc, f) => ({
        weightedSum: acc.weightedSum + f.score * f.weight,
        totalWeight: acc.totalWeight + f.weight,
      }),
      { weightedSum: 0, totalWeight: 0 },
    );

    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 100;
    const overallStatus = this.scoreToOverallStatus(overallScore);

    // 5. Build top risks and summary
    const sortedFactors = [...factors].sort((a, b) => a.score - b.score);
    const topRisks = sortedFactors.filter((f) => f.status !== 'healthy').slice(0, 3);
    const summary = this.buildSummary(overallStatus, topRisks);

    return { overallScore, overallStatus, factors, summary, topRisks };
  }

  /**
   * Count how many optional dimensions have data provided.
   * @param input - The unified health input.
   * @returns Number of optional dimensions with data (0-3).
   */
  private countOptionalDimensions(input: UnifiedHealthInput): number {
    let count = 0;
    if (input.metadataCounts !== undefined || input.orgInfo !== undefined) count++;
    if (input.codeCoverage !== undefined) count++;
    if (input.securitySettings !== undefined) count++;
    return count;
  }

  /**
   * Compute the weight multiplier for limit factors based on optional dimensions.
   * When no optional dimensions exist, limits get full weight (1.0).
   * When all 3 are present, limits get 0.55 total weight.
   * Intermediate values are linearly interpolated.
   *
   * @param optionalCount - Number of optional dimensions present.
   * @returns Multiplier to apply to limit factor weights.
   */
  private computeLimitsWeightMultiplier(optionalCount: number): number {
    if (optionalCount === 0) return BASE_LIMITS_WEIGHT;
    const totalOptWeight = optionalCount * OPTIONAL_DIMENSION_WEIGHT;
    return Math.max(LIMITS_WEIGHT_WITH_ALL_OPTIONAL, BASE_LIMITS_WEIGHT - totalOptWeight);
  }

  /**
   * Compute the weight for each optional dimension.
   * @param optionalCount - Number of optional dimensions present.
   * @returns Weight per optional dimension.
   */
  private computeOptionalDimensionWeight(optionalCount: number): number {
    if (optionalCount === 0) return 0;
    return OPTIONAL_DIMENSION_WEIGHT;
  }

  /**
   * Add the 5 core limit factors with linear scoring and trend integration.
   *
   * @param input - The unified health input.
   * @param factors - The factors array to populate.
   * @param weightMultiplier - Weight scaling for limits.
   */
  private addCoreLimitFactors(
    input: UnifiedHealthInput,
    factors: HealthFactor[],
    weightMultiplier: number,
  ): void {
    for (const [limitName, config] of Object.entries(CORE_LIMIT_FACTORS)) {
      const limit = input.limits.find((l) => l.name === limitName);
      if (!limit) continue;

      const rawScore = linearUsageScore(limit.usedPercent);
      const trendData = this.fetchTrendData(input, limitName);
      const trend = trendData ? mapTrendDirection(trendData.direction) : 'stable';
      const penalty = trendData ? trendPenalty(trendData) : 0;
      const finalScore = Math.max(0, Math.round(rawScore - penalty));

      factors.push({
        name: limit.name,
        category: config.category,
        score: finalScore,
        weight: config.weight * weightMultiplier,
        status: scoreToStatus(finalScore),
        detail: formatLimitDetail(limit),
        recommendation: generateLimitRecommendation(limit.name, limit.usedPercent),
        trend,
      });
    }
  }

  /**
   * Add remaining non-core limits with non-zero usage, sharing the leftover weight.
   *
   * @param input - The unified health input.
   * @param factors - The factors array to populate.
   * @param weightMultiplier - Weight scaling for limits.
   */
  private addRemainingLimitFactors(
    input: UnifiedHealthInput,
    factors: HealthFactor[],
    weightMultiplier: number,
  ): void {
    const coreNames = new Set(Object.keys(CORE_LIMIT_FACTORS));
    const remainingLimits = input.limits.filter((l) => !coreNames.has(l.name) && l.usedPercent > 0);

    if (remainingLimits.length === 0) return;

    const coreWeightTotal = Object.values(CORE_LIMIT_FACTORS).reduce((sum, c) => sum + c.weight, 0);
    const remainingWeight = Math.max(0, (BASE_LIMITS_WEIGHT - coreWeightTotal) * weightMultiplier);
    const perLimitWeight = remainingWeight / remainingLimits.length;

    for (const limit of remainingLimits) {
      const rawScore = linearUsageScore(limit.usedPercent);
      const trendData = this.fetchTrendData(input, limit.name);
      const trend = trendData ? mapTrendDirection(trendData.direction) : 'stable';
      const penalty = trendData ? trendPenalty(trendData) : 0;
      const finalScore = Math.max(0, Math.round(rawScore - penalty));

      factors.push({
        name: limit.name,
        category: 'limits',
        score: finalScore,
        weight: perLimitWeight,
        status: scoreToStatus(finalScore),
        detail: formatLimitDetail(limit),
        recommendation: generateLimitRecommendation(limit.name, limit.usedPercent),
        trend,
      });
    }
  }

  /**
   * Add the metadata complexity dimension if data is available.
   *
   * @param input - The unified health input.
   * @param factors - The factors array to populate.
   * @param weight - The weight for this dimension.
   */
  private addMetadataDimension(
    input: UnifiedHealthInput,
    factors: HealthFactor[],
    weight: number,
  ): void {
    if (input.metadataCounts === undefined && input.orgInfo === undefined) return;

    const objCount =
      input.metadataCounts?.customObjectCount ?? input.orgInfo?.customObjectCount ?? 0;
    const fieldCount = input.metadataCounts?.customFieldCount ?? 0;
    const apexCount = input.metadataCounts?.apexClassCount ?? input.orgInfo?.apexClassCount ?? 0;

    const score = Math.round(
      complexityScore(objCount, 50, 500) * 0.4 +
        complexityScore(fieldCount, 200, 2000) * 0.3 +
        complexityScore(apexCount, 100, 1000) * 0.3,
    );

    const detail = `${objCount} custom objects, ${fieldCount} custom fields, ${apexCount} Apex classes`;
    const recommendation =
      score < 60
        ? 'High metadata complexity detected - consider consolidating custom objects and reviewing unused Apex classes'
        : 'Metadata complexity is manageable';

    factors.push({
      name: 'Metadata Complexity',
      category: 'metadata',
      score,
      weight,
      status: scoreToStatus(score),
      detail,
      recommendation,
      trend: 'stable',
    });
  }

  /**
   * Add the code coverage dimension if data is available.
   *
   * @param input - The unified health input.
   * @param factors - The factors array to populate.
   * @param weight - The weight for this dimension.
   */
  private addCoverageDimension(
    input: UnifiedHealthInput,
    factors: HealthFactor[],
    weight: number,
  ): void {
    if (input.codeCoverage === undefined) return;

    const score = linearCoverageScore(input.codeCoverage);
    const detail = `${Math.round(input.codeCoverage)}% org-wide Apex code coverage`;
    const recommendation =
      input.codeCoverage < 75
        ? `Code coverage is at ${Math.round(input.codeCoverage)}% - Salesforce requires minimum 75% for deployment`
        : 'Code coverage meets Salesforce requirements';

    factors.push({
      name: 'Code Coverage',
      category: 'coverage',
      score,
      weight,
      status: scoreToStatus(score),
      detail,
      recommendation,
      trend: 'stable',
    });
  }

  /**
   * Add the security settings dimension if data is available.
   *
   * @param input - The unified health input.
   * @param factors - The factors array to populate.
   * @param weight - The weight for this dimension.
   */
  private addSecurityDimension(
    input: UnifiedHealthInput,
    factors: HealthFactor[],
    weight: number,
  ): void {
    if (input.securitySettings === undefined) return;

    const { score, detail, recommendation } = this.scoreSecuritySettings(input.securitySettings);

    factors.push({
      name: 'Security Settings',
      category: 'security',
      score,
      weight,
      status: scoreToStatus(score),
      detail,
      recommendation,
      trend: 'stable',
    });
  }

  /**
   * Score security settings using a point-based system (same as OrgHealthScoreCalculator).
   *
   * @param settings - The security settings to evaluate.
   * @returns Score, detail string, and recommendation.
   */
  private scoreSecuritySettings(settings: SecuritySettings): {
    score: number;
    detail: string;
    recommendation: string;
  } {
    let score = 0;
    const issues: string[] = [];

    // Password min length (max 25 points)
    if (settings.passwordMinLength >= 12) score += 25;
    else if (settings.passwordMinLength >= 8) score += 15;
    else {
      score += 5;
      issues.push('password minimum length is below 8 characters');
    }

    // Password complexity (20 points)
    if (settings.passwordComplexity) score += 20;
    else issues.push('password complexity requirements are disabled');

    // Session timeout (20 points)
    if (settings.sessionTimeout <= 120) score += 20;
    else if (settings.sessionTimeout <= 480) score += 10;
    else issues.push('session timeout exceeds 8 hours');

    // MFA (20 points)
    if (settings.mfaEnabled) score += 20;
    else issues.push('MFA is not enabled');

    // IP restrictions (15 points)
    if (settings.ipRestrictions) score += 15;
    else issues.push('login IP restrictions are not configured');

    const detail =
      issues.length === 0
        ? 'All security settings are properly configured'
        : `${issues.length} security issue(s) found`;

    const recommendation =
      issues.length === 0
        ? 'Security configuration is strong'
        : `Improve security: ${issues.join(', ')}`;

    return { score, detail, recommendation };
  }

  /**
   * Fetch trend data for a limit from TrendStorage if available.
   *
   * @param input - The unified health input.
   * @param limitName - The limit name to look up.
   * @returns TrendData or undefined if TrendStorage is not available.
   */
  private fetchTrendData(input: UnifiedHealthInput, limitName: string): TrendData | undefined {
    if (!input.trendStorage) return undefined;
    return input.trendStorage.getTrendData(input.orgId, limitName);
  }

  /**
   * Map overall score to overall status.
   *
   * @param score - The overall score (0-100).
   * @returns The overall health status.
   */
  private scoreToOverallStatus(score: number): HealthReport['overallStatus'] {
    if (score >= 70) return 'healthy';
    if (score >= 40) return 'warning';
    return 'critical';
  }

  /**
   * Build a human-readable summary from the overall status and top risks.
   *
   * @param status - The overall health status.
   * @param topRisks - The top risk factors.
   * @returns Summary string.
   */
  private buildSummary(status: HealthReport['overallStatus'], topRisks: HealthFactor[]): string {
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
