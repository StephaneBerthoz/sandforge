import type { Connection } from 'jsforce';
import type {
  SmartActionRecommendation,
  SmartActionType,
  OrgRecordCounts,
} from '@sandforge/shared';

/** Standard objects queried for smart action analysis. */
const STANDARD_OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'] as const;

/**
 * Below this many records of every one of the five objects, an org is one to
 * fill.
 *
 * Quick Seed was recommended only to an org holding none at all, and no new
 * org is such an org: a Developer Edition, a Trailhead playground and a
 * scratch org made with sample data each come with a dozen accounts and a
 * few dozen contacts, opportunities, cases and leads. The org SandForge is
 * for, the one Salesforce gives away, never got the recommendation; an org
 * holding a working set of any one of the five still does not.
 */
export const SAMPLE_DATA_CEILING = 50;

/** Whether an org holds no more than sample data: under the ceiling on every object. */
function holdsSampleDataAtMost(counts: OrgRecordCounts): boolean {
  return Object.values(counts).every((count) => count < SAMPLE_DATA_CEILING);
}

/** Dependencies injected into SmartActionAnalyzer. */
export interface SmartActionAnalyzerDeps {
  /** Retrieves a jsforce Connection for the given org ID. */
  getConnection: (orgId: string) => Promise<Connection>;
}

/**
 * Org-level analyzer that determines the best next action based on
 * record counts across standard objects.
 *
 * Operates at the org level and produces a single recommendation:
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

    const targetToFill = holdsSampleDataAtMost(targetCounts);
    // A source holding sample data at most has nothing a template does not
    // write better: two new Developer Edition orgs get Quick Seed, not a clone
    // of one's sample records into the other.
    const sourceHasData = sourceCounts !== undefined && !holdsSampleDataAtMost(sourceCounts);

    let action: SmartActionType = 'none';
    let confidence = 0;
    let reason = '';
    let reasonKey = '';

    if (targetToFill && sourceHasData && sourceOrgId) {
      action = 'clone';
      confidence = 0.85;
      reason = 'Source org has data — clone it to your target';
      reasonKey = 'home.smartAction.reasonClone';
    } else if (targetToFill && targetTotal === 0) {
      action = 'quick-seed';
      confidence = 0.9;
      reason = 'Your sandbox is empty — seed it with demo data';
      reasonKey = 'home.smartAction.reasonEmpty';
    } else if (targetToFill) {
      action = 'quick-seed';
      confidence = 0.85;
      reason = 'Your org holds only a few sample records — fill it with demo data';
      reasonKey = 'home.smartAction.reasonSampleOnly';
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
