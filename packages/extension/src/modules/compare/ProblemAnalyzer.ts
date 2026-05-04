import type { CompareItem, CompareSeverity, MetadataComponentType } from '@sandforge/shared';

/** A problem identified during comparison analysis */
export interface Problem {
  id: string;
  severity: CompareSeverity;
  componentType: MetadataComponentType;
  fullName: string;
  description: string;
  suggestion: string;
}

/** Full problem analysis report */
export interface ProblemReport {
  problems: Problem[];
  conflictCount: number;
  breakingChangeCount: number;
}

/** Function signature for generating unique IDs */
export type GenerateProblemIdFn = () => string;

/**
 * Analyzes comparison diffs to identify problems, conflicts,
 * and breaking changes. Provides descriptions and actionable
 * suggestions for each problem found.
 */
export class ProblemAnalyzer {
  private readonly generateId: GenerateProblemIdFn;

  constructor(generateId: GenerateProblemIdFn) {
    this.generateId = generateId;
  }

  /**
   * Analyze a set of CompareItem diffs and produce a ProblemReport.
   * Only non-unchanged items with warning or breaking severity are flagged.
   */
  analyze(diffs: CompareItem[]): ProblemReport {
    const problems: Problem[] = [];
    let conflictCount = 0;
    let breakingChangeCount = 0;

    for (const diff of diffs) {
      if (diff.status === 'unchanged') {
        continue;
      }

      if (diff.severity === 'breaking') {
        breakingChangeCount++;
        problems.push(createBreakingProblem(this.generateId(), diff));
      }

      if (diff.severity === 'warning') {
        problems.push(createWarningProblem(this.generateId(), diff));
      }

      if (diff.status === 'modified' && diff.fieldDiffs && diff.fieldDiffs.length > 0) {
        conflictCount++;
      }

      const contextProblem = detectContextualProblem(this.generateId, diff);
      if (contextProblem) {
        problems.push(contextProblem);
      }
    }

    return {
      problems,
      conflictCount,
      breakingChangeCount,
    };
  }
}

/** Create a problem entry for a breaking change */
function createBreakingProblem(id: string, diff: CompareItem): Problem {
  const action = diff.status === 'removed' ? 'removed' : 'modified';
  return {
    id,
    severity: 'breaking',
    componentType: diff.componentType,
    fullName: diff.fullName,
    description: `${diff.componentType} "${diff.fullName}" has been ${action}, which may break dependent functionality.`,
    suggestion: `Verify all references to "${diff.fullName}" before deploying this change.`,
  };
}

/** Create a problem entry for a warning-level change */
function createWarningProblem(id: string, diff: CompareItem): Problem {
  return {
    id,
    severity: 'warning',
    componentType: diff.componentType,
    fullName: diff.fullName,
    description: `${diff.componentType} "${diff.fullName}" has been ${diff.status}. Review the change for correctness.`,
    suggestion: `Compare the source and target versions of "${diff.fullName}" to ensure the change is intentional.`,
  };
}

/** Detect contextual problems specific to certain component types */
function detectContextualProblem(
  generateId: GenerateProblemIdFn,
  diff: CompareItem,
): Problem | undefined {
  if (diff.status === 'removed' && diff.componentType === 'CustomField') {
    return {
      id: generateId(),
      severity: 'warning',
      componentType: diff.componentType,
      fullName: diff.fullName,
      description: `Removing field "${diff.fullName}" may cause data loss.`,
      suggestion: `Back up data in "${diff.fullName}" before proceeding with deletion.`,
    };
  }

  if (diff.status === 'modified' && diff.componentType === 'Flow') {
    return {
      id: generateId(),
      severity: 'info',
      componentType: diff.componentType,
      fullName: diff.fullName,
      description: `Flow "${diff.fullName}" has been modified. Active flow versions may be affected.`,
      suggestion: `Verify that the updated flow version is activated in the target org.`,
    };
  }

  if (diff.status === 'removed' && diff.componentType === 'ApexTrigger') {
    return {
      id: generateId(),
      severity: 'warning',
      componentType: diff.componentType,
      fullName: diff.fullName,
      description: `Removing trigger "${diff.fullName}" may disable critical automation.`,
      suggestion: `Ensure no business process depends on trigger "${diff.fullName}" before removal.`,
    };
  }

  return undefined;
}
