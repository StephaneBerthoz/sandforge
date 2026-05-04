/** Profile describing the characteristics of a Salesforce object */
export interface ObjectProfile {
  objectName: string;
  fieldCount: number;
  averageRecordSizeBytes: number;
  hasTriggersActive: boolean;
  hasFlowsActive: boolean;
  hasValidationRules: boolean;
}

/** Historical record of a batch execution */
export interface BatchHistory {
  objectName: string;
  batchSize: number;
  durationMs: number;
  errorRate: number;
  timestamp: string;
}

/** Recommendation produced by the optimizer */
export interface BatchRecommendation {
  recommendedBatchSize: number;
  reason: string;
  confidence: number;
}

const BASE_BATCH_SIZE = 10_000;
const MIN_BATCH_SIZE = 200;
const FIELD_COUNT_THRESHOLD = 50;
const ERROR_RATE_THRESHOLD = 5;

const FIELD_COUNT_PENALTY = 0.4;
const TRIGGERS_PENALTY = 0.3;
const FLOWS_PENALTY = 0.2;
const VALIDATION_RULES_PENALTY = 0.1;
const HIGH_ERROR_RATE_PENALTY = 0.3;

/**
 * Auto-optimizes batch sizes for Salesforce operations based on
 * object profiles and historical execution data.
 */
export class BatchOptimizer {
  private readonly historyMap: Map<string, BatchHistory[]> = new Map();

  /**
   * Calculate the optimal batch size for a given object profile,
   * optionally using historical execution data.
   */
  calculateOptimalBatchSize(profile: ObjectProfile, history?: BatchHistory[]): BatchRecommendation {
    let size = BASE_BATCH_SIZE;
    const reasons: string[] = [];
    let penaltyCount = 0;

    if (profile.fieldCount > FIELD_COUNT_THRESHOLD) {
      size *= 1 - FIELD_COUNT_PENALTY;
      reasons.push(`high field count (${profile.fieldCount})`);
      penaltyCount++;
    }

    if (profile.hasTriggersActive) {
      size *= 1 - TRIGGERS_PENALTY;
      reasons.push('active triggers');
      penaltyCount++;
    }

    if (profile.hasFlowsActive) {
      size *= 1 - FLOWS_PENALTY;
      reasons.push('active flows');
      penaltyCount++;
    }

    if (profile.hasValidationRules) {
      size *= 1 - VALIDATION_RULES_PENALTY;
      reasons.push('validation rules');
      penaltyCount++;
    }

    const effectiveHistory = history ?? this.historyMap.get(profile.objectName) ?? [];
    const averageErrorRate = this.computeAverageErrorRate(effectiveHistory);

    if (averageErrorRate > ERROR_RATE_THRESHOLD) {
      size *= 1 - HIGH_ERROR_RATE_PENALTY;
      reasons.push(`high error rate (${averageErrorRate.toFixed(1)}%)`);
      penaltyCount++;
    }

    size = Math.max(MIN_BATCH_SIZE, Math.round(size));

    const reason =
      reasons.length > 0
        ? `Reduced from ${BASE_BATCH_SIZE} due to: ${reasons.join(', ')}`
        : `Base size — no reductions needed`;

    const confidence = this.computeConfidence(penaltyCount, effectiveHistory.length);

    return { recommendedBatchSize: size, reason, confidence };
  }

  /** Store a batch execution entry for future optimization */
  recordExecution(entry: BatchHistory): void {
    const existing = this.historyMap.get(entry.objectName) ?? [];
    existing.push(entry);
    this.historyMap.set(entry.objectName, existing);
  }

  /** Retrieve all recorded history for a given object */
  getHistory(objectName: string): BatchHistory[] {
    return this.historyMap.get(objectName) ?? [];
  }

  /** Clear all stored execution history */
  clearHistory(): void {
    this.historyMap.clear();
  }

  private computeAverageErrorRate(history: BatchHistory[]): number {
    if (history.length === 0) return 0;
    const total = history.reduce((sum, entry) => sum + entry.errorRate, 0);
    return total / history.length;
  }

  private computeConfidence(penaltyCount: number, historySize: number): number {
    const baseConfidence = 0.5;
    const historyBonus = Math.min(historySize * 0.05, 0.3);
    const penaltyReduction = penaltyCount * 0.05;
    return Math.min(1, Math.max(0, baseConfidence + historyBonus - penaltyReduction));
  }
}
