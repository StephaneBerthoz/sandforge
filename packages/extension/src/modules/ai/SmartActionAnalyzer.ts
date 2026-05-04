import type { Connection } from 'jsforce';
import type {
  SmartActionRecommendation,
  SmartActionType,
  OrgRecordCounts,
} from '@sandforge/shared';

/** Standard objects queried for smart action analysis. */
const STANDARD_OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'] as const;

/** Dependencies injected into SmartActionAnalyzer. */
export interface SmartActionAnalyzerDeps {
  /** Retrieves a jsforce Connection for the given org ID. */
  getConnection: (orgId: string) => Promise<Connection>;
}

/**
 * Org-level analyzer that determines the best next action based on
 * record counts across standard objects.
 *
 * Unlike SmartSuggestions (which is module-level), SmartActionAnalyzer
 * operates at the org level and produces a single recommendation:
 * Quick Seed, Clone, Sync, or none.
 */
export class SmartActionAnalyzer {
  private readonly deps: SmartActionAnalyzerDeps;

  /** @param deps - Injected dependencies for org connection access. */
  constructor(deps: SmartActionAnalyzerDeps) {
    this.deps = deps;
  }

  /**
   * Analyze org state and produce a smart action recommendation.
   *
   * Queries record counts on 5 standard objects (Account, Contact,
   * Opportunity, Case, Lead) for the target org, and optionally the
   * source org, then applies decision logic.
   *
   * @param targetOrgId - The target org to analyze.
   * @param sourceOrgId - Optional source org for clone/sync analysis.
   * @returns A recommendation with action, confidence, and reason.
   */
  async analyzeOrg(targetOrgId: string, sourceOrgId?: string): Promise<SmartActionRecommendation> {
    const targetConn = await this.deps.getConnection(targetOrgId);
    const targetCounts = await this.queryRecordCounts(targetConn);

    let sourceCounts: OrgRecordCounts | undefined;
    if (sourceOrgId) {
      const sourceConn = await this.deps.getConnection(sourceOrgId);
      sourceCounts = await this.queryRecordCounts(sourceConn);
    }

    return this.decide(targetOrgId, targetCounts, sourceOrgId, sourceCounts);
  }

  /**
   * Query record counts for standard objects in parallel.
   *
   * Each query is individually wrapped in try/catch so that a missing
   * object (e.g. custom org without Opportunity) returns 0 instead of
   * crashing the entire analysis.
   *
   * @param conn - The jsforce Connection to query.
   * @returns Record counts keyed by object API name.
   */
  private async queryRecordCounts(conn: Connection): Promise<OrgRecordCounts> {
    const results = await Promise.all(
      STANDARD_OBJECTS.map(async (objectName) => {
        try {
          const result = await conn.query(`SELECT COUNT() FROM ${objectName}`);
          return { objectName, count: result.totalSize };
        } catch {
          return { objectName, count: 0 };
        }
      }),
    );

    const counts: OrgRecordCounts = {};
    for (const { objectName, count } of results) {
      counts[objectName] = count;
    }
    return counts;
  }

  /**
   * Apply decision logic to determine the best action.
   *
   * @param targetOrgId - Target org ID.
   * @param targetCounts - Target org record counts.
   * @param sourceOrgId - Optional source org ID.
   * @param sourceCounts - Optional source org record counts.
   * @returns The recommendation.
   */
  private decide(
    targetOrgId: string,
    targetCounts: OrgRecordCounts,
    sourceOrgId?: string,
    sourceCounts?: OrgRecordCounts,
  ): SmartActionRecommendation {
    const targetTotal = Object.values(targetCounts).reduce((sum: number, c: number) => sum + c, 0);
    const sourceTotal = sourceCounts
      ? Object.values(sourceCounts).reduce((sum: number, c: number) => sum + c, 0)
      : 0;

    const targetAllZero = targetTotal === 0;
    const sourceHasData = sourceTotal > 0;

    let action: SmartActionType = 'none';
    let confidence = 0;
    let reason = '';
    let reasonKey = '';

    if (targetAllZero && sourceHasData && sourceOrgId) {
      action = 'clone';
      confidence = 0.85;
      reason = 'Source org has data — clone it to your target';
      reasonKey = 'home.smartAction.reasonClone';
    } else if (targetAllZero) {
      action = 'quick-seed';
      confidence = 0.9;
      reason = 'Your sandbox is empty — seed it with demo data';
      reasonKey = 'home.smartAction.reasonEmpty';
    } else if (sourceHasData && sourceOrgId) {
      action = 'sync';
      confidence = 0.7;
      reason = 'Both orgs have data — sync to keep them aligned';
      reasonKey = 'home.smartAction.reasonSync';
    }

    return {
      action,
      confidence,
      reason,
      reasonKey,
      details: {
        targetOrgId,
        sourceOrgId,
        recordCounts: targetCounts,
      },
    };
  }
}
