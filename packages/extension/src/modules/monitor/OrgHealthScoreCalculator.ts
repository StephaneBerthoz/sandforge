import type { ApiLimit, OrgInfo, OrgHealthDimension } from '@sandforge/shared';

/** Thresholds for scoring a percentage usage 0-100. */
function scoreFromPercent(pct: number): number {
  if (pct <= 30) return 100;
  if (pct <= 50) return 85;
  if (pct <= 70) return 65;
  if (pct <= 85) return 40;
  if (pct <= 95) return 15;
  return 0;
}

/** Invert: higher raw value = better score (e.g. code coverage). */
function scoreFromCoverage(pct: number): number {
  if (pct >= 90) return 100;
  if (pct >= 80) return 85;
  if (pct >= 75) return 70;
  if (pct >= 60) return 45;
  if (pct >= 40) return 20;
  return 0;
}

/** Count-based complexity score (lower count = better). */
function complexityScore(count: number, low: number, high: number): number {
  if (count <= low) return 100;
  if (count >= high) return 20;
  const ratio = (count - low) / (high - low);
  return Math.round(100 - ratio * 80);
}

/** Full health score result. */
export interface OrgHealthScoreResult {
  /** Overall weighted score 0-100. */
  overallScore: number;
  /** Per-dimension scores. */
  dimensions: OrgHealthDimension[];
  /** Actionable recommendations sorted by priority. */
  recommendations: string[];
}

/** Metadata counts passed in when org metadata has been queried. */
export interface OrgMetadataCounts {
  customObjectCount: number;
  customFieldCount: number;
  apexClassCount: number;
}

/** Security settings passed in from org query. */
export interface OrgSecuritySettings {
  passwordMinLength: number;
  passwordComplexity: boolean;
  sessionTimeout: number;
  mfaEnabled: boolean;
  ipRestrictions: boolean;
}

/**
 * Computes a multi-dimensional health score for a Salesforce org.
 *
 * Dimensions:
 * 1. API Usage (weight 0.25)
 * 2. Storage Usage (weight 0.20)
 * 3. Metadata Complexity (weight 0.20)
 * 4. Code Coverage (weight 0.15)
 * 5. Security Settings (weight 0.20)
 */
export class OrgHealthScoreCalculator {
  /**
   * Compute the full health score.
   *
   * @param limits - Current API limits snapshot.
   * @param orgInfo - Org metadata (optional, for complexity dimension).
   * @param codeCoverage - Org-wide code coverage percentage 0-100.
   * @param metadataCounts - Custom metadata counts.
   * @param securitySettings - Org security configuration.
   * @returns Full health score with dimensions and recommendations.
   */
  calculate(
    limits: ApiLimit[],
    orgInfo?: OrgInfo,
    codeCoverage?: number,
    metadataCounts?: OrgMetadataCounts,
    securitySettings?: OrgSecuritySettings,
  ): OrgHealthScoreResult {
    const dimensions: OrgHealthDimension[] = [];
    const recommendations: string[] = [];

    // 1. API Usage
    const apiLimit = limits.find((l) => l.name === 'DailyApiRequests');
    const apiPct = apiLimit?.usedPercent ?? 0;
    const apiScore = scoreFromPercent(apiPct);
    dimensions.push({
      name: 'apiUsage',
      score: apiScore,
      label: 'API Usage',
      detail: `${Math.round(apiPct)}% of daily API calls used`,
      recommendation: apiPct > 70
        ? `API usage is at ${Math.round(apiPct)}% - consider optimizing integrations or archiving old data`
        : 'API usage is within healthy limits',
    });
    if (apiPct > 70) {
      recommendations.push(`API usage is at ${Math.round(apiPct)}% - consider optimizing integrations or archiving old data`);
    }

    // 2. Storage Usage
    const storageLimit = limits.find((l) => l.name === 'DataStorageMB');
    const storagePct = storageLimit?.usedPercent ?? 0;
    const storageScore = scoreFromPercent(storagePct);
    dimensions.push({
      name: 'storageUsage',
      score: storageScore,
      label: 'Storage Usage',
      detail: `${Math.round(storagePct)}% of data storage used`,
      recommendation: storagePct > 70
        ? `Storage is at ${Math.round(storagePct)}% - consider archiving old records or cleaning attachments`
        : 'Storage usage is within healthy limits',
    });
    if (storagePct > 70) {
      recommendations.push(`Storage is at ${Math.round(storagePct)}% - consider archiving old records or cleaning attachments`);
    }

    // 3. Metadata Complexity
    const objCount = metadataCounts?.customObjectCount ?? orgInfo?.customObjectCount ?? 0;
    const fieldCount = metadataCounts?.customFieldCount ?? 0;
    const apexCount = metadataCounts?.apexClassCount ?? orgInfo?.apexClassCount ?? 0;
    const metaScore = Math.round(
      (complexityScore(objCount, 50, 500) * 0.4) +
      (complexityScore(fieldCount, 200, 2000) * 0.3) +
      (complexityScore(apexCount, 100, 1000) * 0.3),
    );
    dimensions.push({
      name: 'metadataComplexity',
      score: metaScore,
      label: 'Metadata Complexity',
      detail: `${objCount} custom objects, ${fieldCount} custom fields, ${apexCount} Apex classes`,
      recommendation: metaScore < 60
        ? 'High metadata complexity detected - consider consolidating custom objects and reviewing unused Apex classes'
        : 'Metadata complexity is manageable',
    });
    if (metaScore < 60) {
      recommendations.push('High metadata complexity - review unused custom objects, fields, and Apex classes');
    }

    // 4. Code Coverage
    const coverage = codeCoverage ?? 75;
    const coverageScore = scoreFromCoverage(coverage);
    dimensions.push({
      name: 'codeCoverage',
      score: coverageScore,
      label: 'Code Coverage',
      detail: `${Math.round(coverage)}% org-wide Apex code coverage`,
      recommendation: coverage < 75
        ? `Code coverage is at ${Math.round(coverage)}% - Salesforce requires minimum 75% for deployment`
        : 'Code coverage meets Salesforce requirements',
    });
    if (coverage < 75) {
      recommendations.push(`Code coverage is ${Math.round(coverage)}% - below the 75% deployment threshold`);
    }

    // 5. Security Settings
    const secScore = this.scoreSecuritySettings(securitySettings);
    dimensions.push({
      name: 'securitySettings',
      score: secScore.score,
      label: 'Security Settings',
      detail: secScore.detail,
      recommendation: secScore.recommendation,
    });
    if (secScore.score < 70) {
      recommendations.push(secScore.recommendation);
    }

    // Weighted overall score
    const weights = [0.25, 0.20, 0.20, 0.15, 0.20];
    const overallScore = Math.round(
      dimensions.reduce((sum, dim, i) => sum + dim.score * weights[i], 0),
    );

    return { overallScore, dimensions, recommendations };
  }

  /** Score security settings. */
  private scoreSecuritySettings(settings?: OrgSecuritySettings): {
    score: number;
    detail: string;
    recommendation: string;
  } {
    if (!settings) {
      return {
        score: 50,
        detail: 'Security settings could not be retrieved',
        recommendation: 'Unable to evaluate security settings - ensure proper admin permissions',
      };
    }

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

    const detail = issues.length === 0
      ? 'All security settings are properly configured'
      : `${issues.length} security issue(s) found`;

    const recommendation = issues.length === 0
      ? 'Security configuration is strong'
      : `Improve security: ${issues.join(', ')}`;

    return { score, detail, recommendation };
  }
}
