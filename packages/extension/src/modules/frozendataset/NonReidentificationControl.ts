/**
 * Non-reidentification control (spec §5) — the GATE before any frozen
 * artifact is written or versioned. Four checks compare the raw sas-only
 * extraction against the frozen dataset, record to record, matched by
 * `referenceId`:
 *
 *   1. **substitution** — every non-keep original value is gone from its
 *      field AND from every other field of the same record (TRANSVERSAL
 *      leak: e.g. a license plate typed into a "brand" free-text field);
 *   2. **clear-empty** — fields under the `clear` generator hold zero
 *      residue (present values must be `''`; absence/null are acceptable —
 *      spec pitfall 6: tree exports omit null fields);
 *   3. **formats** — SIV / E.164 / email / generalized postcodes still
 *      match their expected shape;
 *   4. **no-residual-id** — no remaining string validates the Salesforce
 *      18-char checksum.
 *
 * A single failure fails the whole report; the FrozenDatasetWriter
 * refuses to write anything on FAIL.
 */

import type { PseudonymGenerator } from './DeterministicPseudonymizer.js';
import { resolveGenerator, type PseudonymRulesFile } from './rulesFile.js';
import { isValidSalesforceId18 } from './salesforceId.js';
import type { ExtractedDataset, ExtractedRecord, FrozenDataset, FrozenRecord } from './types.js';

/** The four check names. */
export type ControlCheckName = 'substitution' | 'clear-empty' | 'formats' | 'no-residual-id';

/** One concrete violation found by a check. */
export interface ControlViolation {
  check: ControlCheckName;
  objectApiName: string;
  referenceId: string;
  /** Field concerned, when applicable. */
  field?: string;
  detail: string;
}

/** Outcome of one of the four checks. */
export interface FourPointCheckResult {
  name: ControlCheckName;
  passed: boolean;
  violations: ControlViolation[];
}

/** Full gate report, consigned in the manifest. */
export interface NonReidentificationReport {
  passed: boolean;
  checks: FourPointCheckResult[];
  /** Who ran the control (manifest `controls` author). */
  author: string;
  /** ISO timestamp of the control run. */
  checkedAt: string;
}

/** Options for a control run. */
export interface NonReidentificationControlOptions {
  /** Author recorded in the report. */
  author?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

const SIV_REGEX = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
const E164_REGEX = /^\+3363998\d{4}$/;
const EMAIL_REGEX = /^[a-z0-9-]+@example\.invalid$/;
const GENERALIZED_POSTAL_REGEX = /^\d{2}0+$/;

/**
 * Minimum length for the transversal-leak comparison: shorter tokens
 * (1-2 chars) produce too many false positives against legitimate
 * pseudonyms to be a useful signal.
 */
const TRANSVERSAL_MIN_LENGTH = 3;

/**
 * Runs the four-point non-reidentification control. Pure in-memory
 * comparison; never touches an org.
 */
export class NonReidentificationControl {
  /**
   * Compare `extracted` (raw, sas-only) against `frozen` (pseudonymized)
   * under `rules` and return the gate report.
   */
  run(
    extracted: ExtractedDataset,
    frozen: FrozenDataset,
    rules: PseudonymRulesFile,
    options: NonReidentificationControlOptions = {},
  ): NonReidentificationReport {
    // All referenceIds of the dataset — structural link values are exempt
    // from the clear-empty check (they are joins, not residue).
    const referenceIds = new Set<string>();
    const frozenByRef = new Map<string, { objectApiName: string; record: FrozenRecord }>();
    for (const objectData of frozen.objects) {
      for (const record of objectData.records) {
        referenceIds.add(record.referenceId);
        frozenByRef.set(record.referenceId, { objectApiName: objectData.objectApiName, record });
      }
    }

    const violations: Record<ControlCheckName, ControlViolation[]> = {
      substitution: [],
      'clear-empty': [],
      formats: [],
      'no-residual-id': [],
    };

    for (const objectData of extracted.objects) {
      for (const sourceRecord of objectData.records) {
        const target = frozenByRef.get(sourceRecord.referenceId);
        if (!target) {
          violations.substitution.push({
            check: 'substitution',
            objectApiName: objectData.objectApiName,
            referenceId: sourceRecord.referenceId,
            detail: 'record missing from the frozen dataset',
          });
          continue;
        }
        this.checkSubstitution(
          objectData.objectApiName,
          sourceRecord,
          target.record,
          rules,
          violations.substitution,
        );
      }
    }

    for (const objectData of frozen.objects) {
      for (const record of objectData.records) {
        this.checkClearEmpty(
          objectData.objectApiName,
          record,
          rules,
          referenceIds,
          violations['clear-empty'],
        );
        this.checkNoResidualId(
          objectData.objectApiName,
          record,
          referenceIds,
          violations['no-residual-id'],
        );
      }
    }

    this.checkFormats(extracted, frozen, rules, frozenByRef, violations.formats);

    const checks = (['substitution', 'clear-empty', 'formats', 'no-residual-id'] as const).map(
      (name) => ({
        name,
        passed: violations[name].length === 0,
        violations: violations[name],
      }),
    );

    return {
      passed: checks.every((c) => c.passed),
      checks,
      author: options.author ?? 'frozen-dataset-engine',
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  }

  /** Check 1 — effective substitution, transversal leak included. */
  private checkSubstitution(
    objectApiName: string,
    source: ExtractedRecord,
    frozen: FrozenRecord,
    rules: PseudonymRulesFile,
    violations: ControlViolation[],
  ): void {
    for (const [field, original] of Object.entries(source.fields)) {
      if (field === 'Id' || original === null || original === undefined || original === '') {
        continue;
      }
      const generator = resolveGenerator(rules, objectApiName, field);
      if (generator === 'keep') {
        // Human-approved clear-text — nothing to substitute by design.
        continue;
      }
      const anonymized = frozen.fields[field];
      if (valuesEqual(anonymized, original)) {
        violations.push({
          check: 'substitution',
          objectApiName,
          referenceId: source.referenceId,
          field,
          detail: 'original value still present in its own field',
        });
        continue;
      }
      // Transversal leak: the original value must not appear in ANY other
      // field of the same record — except human-approved keep fields.
      if (typeof original === 'string' && original.length >= TRANSVERSAL_MIN_LENGTH) {
        for (const [otherField, otherValue] of Object.entries(frozen.fields)) {
          if (otherField === field || typeof otherValue !== 'string' || otherValue !== original) {
            continue;
          }
          const otherGenerator = resolveGenerator(rules, objectApiName, otherField);
          if (otherGenerator === 'keep') {
            continue;
          }
          violations.push({
            check: 'substitution',
            objectApiName,
            referenceId: source.referenceId,
            field: otherField,
            detail: `transversal leak: original value of "${field}" found in "${otherField}"`,
          });
        }
      }
    }
  }

  /** Check 2 — fields under the clear generator must hold zero residue. */
  private checkClearEmpty(
    objectApiName: string,
    record: FrozenRecord,
    rules: PseudonymRulesFile,
    referenceIds: ReadonlySet<string>,
    violations: ControlViolation[],
  ): void {
    for (const [field, value] of Object.entries(record.fields)) {
      // Structural joins and resolved RecordType names are not residue.
      if (field === 'RecordTypeId') {
        continue;
      }
      if (typeof value === 'string' && referenceIds.has(value)) {
        continue;
      }
      if (resolveGenerator(rules, objectApiName, field) !== 'clear') {
        continue;
      }
      // Absence is fine (pitfall 6); a present value must be empty.
      if (value !== '' && value !== null && value !== undefined) {
        violations.push({
          check: 'clear-empty',
          objectApiName,
          referenceId: record.referenceId,
          field,
          detail: `residual value under "clear" generator: ${JSON.stringify(value)}`,
        });
      }
    }
  }

  /** Check 3 — pseudonym formats are conserved. */
  private checkFormats(
    extracted: ExtractedDataset,
    frozen: FrozenDataset,
    rules: PseudonymRulesFile,
    frozenByRef: ReadonlyMap<string, { objectApiName: string; record: FrozenRecord }>,
    violations: ControlViolation[],
  ): void {
    void frozen;
    const formatValidators: Partial<
      Record<PseudonymGenerator, (anonymized: string, original: string) => boolean>
    > = {
      registrationSIV: (v) => SIV_REGEX.test(v),
      phoneE164: (v) => E164_REGEX.test(v),
      email: (v) => EMAIL_REGEX.test(v),
      postalCodeGeneralize: (anonymized, original) =>
        GENERALIZED_POSTAL_REGEX.test(anonymized) && anonymized.length === original.trim().length,
    };

    for (const objectData of extracted.objects) {
      for (const sourceRecord of objectData.records) {
        const target = frozenByRef.get(sourceRecord.referenceId);
        if (!target) {
          continue;
        }
        for (const [field, original] of Object.entries(sourceRecord.fields)) {
          if (typeof original !== 'string' || original === '') {
            continue;
          }
          const generator = resolveGenerator(rules, objectData.objectApiName, field);
          const validator = formatValidators[generator];
          if (!validator) {
            continue;
          }
          const anonymized = target.record.fields[field];
          // Cleared/absent values have no format to conserve.
          if (typeof anonymized !== 'string' || anonymized === '') {
            continue;
          }
          if (!validator(anonymized, original)) {
            violations.push({
              check: 'formats',
              objectApiName: objectData.objectApiName,
              referenceId: sourceRecord.referenceId,
              field,
              detail: `format not conserved for ${generator}: ${JSON.stringify(anonymized)}`,
            });
          }
        }
      }
    }
  }

  /** Check 4 — no checksum-valid Salesforce ID remains anywhere. */
  private checkNoResidualId(
    objectApiName: string,
    record: FrozenRecord,
    referenceIds: ReadonlySet<string>,
    violations: ControlViolation[],
  ): void {
    void referenceIds;
    for (const [field, value] of Object.entries(record.fields)) {
      if (typeof value === 'string' && isValidSalesforceId18(value)) {
        violations.push({
          check: 'no-residual-id',
          objectApiName,
          referenceId: record.referenceId,
          field,
          detail: 'checksum-valid Salesforce ID survived the sweep',
        });
      }
    }
  }
}

/** Loose equality for substitution comparison (string/number/boolean). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return String(a) === String(b);
}
