import type {
  PreCheckCategory,
  PreCheckConfig,
  PreCheckEstimations,
  PreCheckItem,
  PreCheckResult,
  PreCheckSeverity,
  ConfirmationItem,
} from '@sandforge/shared';
import type { SecurityCheckResult } from './SecurityCheck';
import type { PerformanceMetrics } from './PerformanceCheck';

/** Interface for a category checker */
export interface CategoryChecker {
  check(config: PreCheckConfig): Promise<PreCheckItem[]>;
}

/** Interface for the security checker (returns items + confirmations) */
export interface SecurityCategoryChecker {
  check(config: PreCheckConfig): Promise<SecurityCheckResult>;
}

/** Interface for the performance checker (also provides estimations) */
export interface PerformanceCategoryChecker {
  check(config: PreCheckConfig): Promise<PreCheckItem[]>;
  estimatePerformance(config: PreCheckConfig, metrics: PerformanceMetrics): PreCheckEstimations;
}

/** Dependencies for the PreCheckEngine */
export interface PreCheckEngineDeps {
  permissionCheck: CategoryChecker;
  apiLimitCheck: CategoryChecker;
  storageCheck: CategoryChecker;
  schemaCheck: CategoryChecker;
  dataIntegrityCheck: CategoryChecker;
  orgStatusCheck: CategoryChecker;
  compatibilityCheck: CategoryChecker;
  securityCheck: SecurityCategoryChecker;
  performanceCheck: PerformanceCategoryChecker;
  fetchPerformanceMetrics: (orgId: string, operationConfig: Record<string, unknown>) => Promise<PerformanceMetrics>;
}

/** Severity penalty values for score calculation */
const SEVERITY_PENALTIES: Record<PreCheckSeverity, number> = {
  info: 0,
  warning: 5,
  error: 15,
  blocker: 30,
};

/** Map from PreCheckCategory to the dependency key */
const CATEGORY_TO_CHECKER_KEY: Record<
  Exclude<PreCheckCategory, 'security' | 'performance' | 'connectivity'>,
  keyof Pick<PreCheckEngineDeps,
    'permissionCheck' | 'apiLimitCheck' | 'storageCheck' | 'schemaCheck' |
    'dataIntegrityCheck' | 'orgStatusCheck' | 'compatibilityCheck'
  >
> = {
  permissions: 'permissionCheck',
  api_limits: 'apiLimitCheck',
  storage: 'storageCheck',
  schema: 'schemaCheck',
  data_integrity: 'dataIntegrityCheck',
  org_status: 'orgStatusCheck',
  compatibility: 'compatibilityCheck',
};

/**
 * Central pre-check engine that orchestrates all category checks,
 * computes an overall score, determines proceed status, and
 * collects confirmation requirements and auto-fixable items.
 */
export class PreCheckEngine {
  private readonly deps: PreCheckEngineDeps;

  constructor(deps: PreCheckEngineDeps) {
    this.deps = deps;
  }

  /** Run all configured category checks and produce a consolidated result */
  async run(config: PreCheckConfig): Promise<PreCheckResult> {
    const allItems: PreCheckItem[] = [];
    const allConfirmations: ConfirmationItem[] = [];

    for (const category of config.categories) {
      if (category === 'security') {
        const result = await this.deps.securityCheck.check(config);
        allItems.push(...result.items);
        allConfirmations.push(...result.confirmations);
        continue;
      }

      if (category === 'performance') {
        const items = await this.deps.performanceCheck.check(config);
        allItems.push(...items);
        continue;
      }

      if (category === 'connectivity') {
        continue;
      }

      const checkerKey = CATEGORY_TO_CHECKER_KEY[category];
      const checker = this.deps[checkerKey];
      const items = await checker.check(config);
      allItems.push(...items);
    }

    const estimations = await this.computeEstimations(config);
    const score = this.computeScore(allItems);
    const status = this.computeStatus(allItems);
    const canProceed = status !== 'fail';
    const autoFixable = allItems.filter((item) => item.autoFixable && !item.passed);

    return {
      status,
      score,
      checks: allItems,
      estimations,
      canProceed,
      requiresConfirmation: allConfirmations,
      autoFixable,
    };
  }

  /** Run checks for a single category */
  async runCategory(
    category: PreCheckCategory,
    config: PreCheckConfig
  ): Promise<PreCheckItem[]> {
    if (category === 'security') {
      const result = await this.deps.securityCheck.check(config);
      return result.items;
    }

    if (category === 'performance') {
      return this.deps.performanceCheck.check(config);
    }

    if (category === 'connectivity') {
      return [];
    }

    const checkerKey = CATEGORY_TO_CHECKER_KEY[category];
    const checker = this.deps[checkerKey];
    return checker.check(config);
  }

  /**
   * Compute overall score starting from 100, deducting penalties
   * for each failed check based on severity. Minimum score is 0.
   */
  private computeScore(items: PreCheckItem[]): number {
    let score = 100;

    for (const item of items) {
      if (!item.passed) {
        score -= SEVERITY_PENALTIES[item.severity];
      }
    }

    return Math.max(0, score);
  }

  /**
   * Compute overall status:
   * - 'fail' if any item has severity 'blocker' and did not pass
   * - 'warning' if any item has severity 'warning' or 'error' and did not pass
   * - 'pass' otherwise
   */
  private computeStatus(items: PreCheckItem[]): 'pass' | 'warning' | 'fail' {
    const failedItems = items.filter((item) => !item.passed);
    const hasBlocker = failedItems.some((item) => item.severity === 'blocker');

    if (hasBlocker) return 'fail';

    const hasWarningOrError = failedItems.some(
      (item) => item.severity === 'warning' || item.severity === 'error'
    );

    if (hasWarningOrError) return 'warning';

    return 'pass';
  }

  /** Compute performance estimations */
  private async computeEstimations(config: PreCheckConfig): Promise<PreCheckEstimations> {
    const metrics = await this.deps.fetchPerformanceMetrics(
      config.targetOrgId,
      config.operationConfig
    );
    return this.deps.performanceCheck.estimatePerformance(config, metrics);
  }
}
