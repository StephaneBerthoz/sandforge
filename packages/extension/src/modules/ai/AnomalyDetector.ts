/** Anomaly type classification. */
export type AnomalyType = 'outlier' | 'pattern' | 'inconsistency' | 'empty' | 'duplicate';

/** Anomaly severity level. */
export type AnomalySeverity = 'low' | 'medium' | 'high';

/** A single detected data anomaly. */
export interface Anomaly {
  type: AnomalyType;
  field: string;
  description: string;
  severity: AnomalySeverity;
  affectedRecords: number;
  examples: unknown[];
}

/** Report summarizing all anomalies found in a data sample. */
export interface AnomalyReport {
  objectName: string;
  totalRecords: number;
  anomalies: Anomaly[];
  score: number;
  scannedAt: string;
}

/** A data sample with field names and record rows. */
export interface DataSample {
  fields: string[];
  records: Array<Record<string, unknown>>;
}

/** Statistical summary for a numeric field. */
export interface FieldStatistics {
  min: number;
  max: number;
  avg: number;
  stdDev: number;
  nullCount: number;
  uniqueCount: number;
}

/** Fields that indicate timestamps by convention. */
const DATE_FIELD_PATTERNS = /date|created|modified|updated|timestamp|time/i;

/** Fields that should never be negative. */
const NON_NEGATIVE_FIELD_PATTERNS = /amount|price|cost|revenue|quantity|count|total|balance/i;

/** Fields used for duplicate detection via fuzzy matching. */
const NAME_FIELDS = /^(name|firstname|lastname|first_name|last_name|fullname|full_name)$/i;
const EMAIL_FIELDS = /^(email|emailaddress|email_address)$/i;

/**
 * Detects data anomalies in Salesforce record samples using
 * statistical analysis and heuristic pattern matching.
 */
export class AnomalyDetector {
  /**
   * Analyze a data sample and detect anomalies.
   * Runs outlier, pattern, inconsistency, empty field,
   * and duplicate detection across all fields.
   * @param sample - The data sample to analyze
   * @param objectName - Salesforce object API name
   * @returns Anomaly report with score and findings
   */
  detectAnomalies(sample: DataSample, objectName: string): AnomalyReport {
    if (sample.records.length === 0) {
      return {
        objectName,
        totalRecords: 0,
        anomalies: [],
        score: 0,
        scannedAt: new Date().toISOString(),
      };
    }

    const anomalies: Anomaly[] = [];

    for (const field of sample.fields) {
      anomalies.push(...this.detectOutliers(sample, field));
      anomalies.push(...this.detectInconsistencies(sample, field));
      anomalies.push(...this.detectEmptyFields(sample, field));
    }

    anomalies.push(...this.detectPatterns(sample));
    anomalies.push(...this.detectDuplicates(sample));

    const totalAffected = anomalies.reduce((sum, a) => sum + a.affectedRecords, 0);
    const maxPossible = sample.records.length * sample.fields.length;
    const score = maxPossible > 0 ? Math.min(100, Math.round((totalAffected / maxPossible) * 100)) : 0;

    return {
      objectName,
      totalRecords: sample.records.length,
      anomalies,
      score,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Compute field statistics for a numeric field in the sample.
   * @param sample - The data sample
   * @param field - Field name to compute statistics for
   * @returns Numeric statistics including min, max, avg, stdDev, nullCount, uniqueCount
   */
  getFieldStatistics(sample: DataSample, field: string): FieldStatistics {
    const values: number[] = [];
    let nullCount = 0;
    const uniqueValues = new Set<unknown>();

    for (const record of sample.records) {
      const value = record[field];
      uniqueValues.add(value);

      if (value === null || value === undefined || value === '') {
        nullCount++;
        continue;
      }

      const num = Number(value);
      if (!isNaN(num)) {
        values.push(num);
      }
    }

    if (values.length === 0) {
      return { min: 0, max: 0, avg: 0, stdDev: 0, nullCount, uniqueCount: uniqueValues.size };
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return { min, max, avg, stdDev, nullCount, uniqueCount: uniqueValues.size };
  }

  private detectOutliers(sample: DataSample, field: string): Anomaly[] {
    const stats = this.getFieldStatistics(sample, field);
    if (stats.stdDev === 0) return [];

    const outlierRecords: unknown[] = [];
    for (const record of sample.records) {
      const value = record[field];
      if (value === null || value === undefined) continue;

      const num = Number(value);
      if (!isNaN(num) && Math.abs(num - stats.avg) > 3 * stats.stdDev) {
        outlierRecords.push(value);
      }
    }

    if (outlierRecords.length === 0) return [];

    return [
      {
        type: 'outlier',
        field,
        description: `${outlierRecords.length} value(s) are more than 3 standard deviations from the mean (avg: ${stats.avg.toFixed(2)}, stdDev: ${stats.stdDev.toFixed(2)}).`,
        severity: outlierRecords.length > sample.records.length * 0.1 ? 'high' : 'medium',
        affectedRecords: outlierRecords.length,
        examples: outlierRecords.slice(0, 5),
      },
    ];
  }

  private detectPatterns(sample: DataSample): Anomaly[] {
    const anomalies: Anomaly[] = [];

    const dateFields = sample.fields.filter((f) => DATE_FIELD_PATTERNS.test(f));
    for (const field of dateFields) {
      const timestamps: number[] = [];
      for (const record of sample.records) {
        const value = record[field];
        if (typeof value === 'string' || typeof value === 'number') {
          const ts = new Date(value).getTime();
          if (!isNaN(ts)) {
            timestamps.push(ts);
          }
        }
      }

      if (timestamps.length < 3) continue;

      timestamps.sort((a, b) => a - b);
      const ONE_MINUTE = 60_000;
      let burstCount = 0;
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i] - timestamps[i - 1] < ONE_MINUTE) {
          burstCount++;
        }
      }

      if (burstCount > timestamps.length * 0.5) {
        anomalies.push({
          type: 'pattern',
          field,
          description: `${burstCount} records created within 1-minute intervals, indicating bulk or automated creation.`,
          severity: 'medium',
          affectedRecords: burstCount,
          examples: timestamps.slice(0, 3).map((ts) => new Date(ts).toISOString()),
        });
      }
    }

    return anomalies;
  }

  private detectInconsistencies(sample: DataSample, field: string): Anomaly[] {
    const anomalies: Anomaly[] = [];

    if (DATE_FIELD_PATTERNS.test(field)) {
      const now = Date.now();
      const futureRecords: unknown[] = [];

      for (const record of sample.records) {
        const value = record[field];
        if (typeof value === 'string' || typeof value === 'number') {
          const ts = new Date(value).getTime();
          if (!isNaN(ts) && ts > now) {
            futureRecords.push(value);
          }
        }
      }

      if (futureRecords.length > 0) {
        anomalies.push({
          type: 'inconsistency',
          field,
          description: `${futureRecords.length} record(s) have future dates in a field that typically contains past dates.`,
          severity: futureRecords.length > sample.records.length * 0.1 ? 'high' : 'low',
          affectedRecords: futureRecords.length,
          examples: futureRecords.slice(0, 5),
        });
      }
    }

    if (NON_NEGATIVE_FIELD_PATTERNS.test(field)) {
      const negativeRecords: unknown[] = [];
      for (const record of sample.records) {
        const value = record[field];
        if (value !== null && value !== undefined) {
          const num = Number(value);
          if (!isNaN(num) && num < 0) {
            negativeRecords.push(value);
          }
        }
      }

      if (negativeRecords.length > 0) {
        anomalies.push({
          type: 'inconsistency',
          field,
          description: `${negativeRecords.length} record(s) have negative values in "${field}" which typically should not be negative.`,
          severity: 'medium',
          affectedRecords: negativeRecords.length,
          examples: negativeRecords.slice(0, 5),
        });
      }
    }

    return anomalies;
  }

  private detectEmptyFields(sample: DataSample, field: string): Anomaly[] {
    let emptyCount = 0;
    for (const record of sample.records) {
      const value = record[field];
      if (value === null || value === undefined || value === '') {
        emptyCount++;
      }
    }

    const emptyRatio = emptyCount / sample.records.length;

    if (emptyRatio > 0.9 && emptyCount < sample.records.length) {
      return [
        {
          type: 'empty',
          field,
          description: `${emptyCount} of ${sample.records.length} records (${(emptyRatio * 100).toFixed(0)}%) have no value for "${field}".`,
          severity: 'low',
          affectedRecords: emptyCount,
          examples: [],
        },
      ];
    }

    return [];
  }

  private detectDuplicates(sample: DataSample): Anomaly[] {
    const anomalies: Anomaly[] = [];

    const nameFields = sample.fields.filter((f) => NAME_FIELDS.test(f));
    const emailFieldsList = sample.fields.filter((f) => EMAIL_FIELDS.test(f));

    for (const field of [...nameFields, ...emailFieldsList]) {
      const valueCounts = new Map<string, number>();

      for (const record of sample.records) {
        const value = record[field];
        if (typeof value === 'string' && value.trim() !== '') {
          const normalized = value.trim().toLowerCase();
          valueCounts.set(normalized, (valueCounts.get(normalized) ?? 0) + 1);
        }
      }

      const duplicateEntries: Array<{ value: string; count: number }> = [];
      for (const [value, count] of valueCounts) {
        if (count > 1) {
          duplicateEntries.push({ value, count });
        }
      }

      if (duplicateEntries.length > 0) {
        const totalDuplicateRecords = duplicateEntries.reduce((sum, d) => sum + d.count, 0);
        anomalies.push({
          type: 'duplicate',
          field,
          description: `${duplicateEntries.length} duplicate value(s) found in "${field}" affecting ${totalDuplicateRecords} records.`,
          severity: totalDuplicateRecords > sample.records.length * 0.2 ? 'high' : 'medium',
          affectedRecords: totalDuplicateRecords,
          examples: duplicateEntries.slice(0, 5).map((d) => `${d.value} (x${d.count})`),
        });
      }
    }

    return anomalies;
  }
}
