/**
 * Dossier health, judged on the dossier's own records.
 *
 * A root record is healthy when the records its scope-aware extraction
 * reaches include at least one of every expected object: an Opportunity kept
 * for a combination must actually carry the line items the tests will lean
 * on, not merely belong to an object that can have some.
 *
 * The first version judged the discovery graph instead — whether it was
 * truncated, which objects it reached. That graph is the SCHEMA's: the record
 * id only picks the root object, and every count discovery takes is
 * org-wide. So it gave every candidate of a root object the same verdict, and
 * on a real org the verdict was always "lame": an Opportunity's graph ran to
 * four hundred objects at a cap of two hundred, every candidate was
 * "truncated", none was kept, and the selection died on an empty list.
 *
 * The measurement is the one the volumetry budget is checked with, so a
 * dossier is judged on exactly the read the dataset will be made of.
 */

import type {
  DossierHealth,
  DossierHealthChecker,
  ScopeVolumetryFn,
} from './CoverageMatrixSelector.js';

export class ScopedDossierHealthChecker implements DossierHealthChecker {
  /**
   * @param measure - Per-object record counts of the extraction scope of the
   *   given roots (the selector's volumetry measurement).
   * @param expectedObjects - Objects every healthy dossier holds a record of.
   */
  constructor(
    private readonly measure: ScopeVolumetryFn,
    private readonly expectedObjects: readonly string[],
  ) {}

  /** Measure the candidate's own scope and judge it. */
  async check(rootRecordId: string): Promise<DossierHealth> {
    let measured: Record<string, number>;
    try {
      measured = await this.measure([rootRecordId]);
    } catch (error) {
      return {
        healthy: false,
        reason: `extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    for (const expected of this.expectedObjects) {
      if ((measured[expected] ?? 0) === 0) {
        return { healthy: false, reason: `no ${expected} record in this dossier` };
      }
    }
    return { healthy: true };
  }
}
