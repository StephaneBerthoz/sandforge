import type { DiffStatus, MetadataComponentType, OrgSnapshot } from '@sandforge/shared';

/** A component that has drifted from its baseline */
export interface DriftedComponent {
  componentType: MetadataComponentType;
  fullName: string;
  changeType: DiffStatus;
  detectedAt: string;
}

/** Result of a drift detection run */
export interface DriftResult {
  orgId: string;
  driftedComponents: DriftedComponent[];
  driftScore: number;
  detectedAt: string;
}

/** Function signature for fetching component names for a snapshot */
export type FetchComponentNamesFn = (
  snapshotId: string,
  componentType: MetadataComponentType
) => string[];

/**
 * Detects configuration drift between two org snapshots.
 * Compares the baseline snapshot against the current snapshot
 * and computes a drift score (0-100) based on the proportion
 * of changed components.
 */
export class DriftDetector {
  private readonly fetchComponentNames: FetchComponentNamesFn;

  constructor(fetchComponentNames: FetchComponentNamesFn) {
    this.fetchComponentNames = fetchComponentNames;
  }

  /**
   * Detect drift between a baseline and current snapshot.
   * Returns a DriftResult with a list of drifted components and a score.
   */
  detect(
    orgId: string,
    baseline: OrgSnapshot,
    current: OrgSnapshot
  ): DriftResult {
    const now = new Date().toISOString();
    const driftedComponents: DriftedComponent[] = [];

    const allTypes = new Set([
      ...baseline.componentTypes,
      ...current.componentTypes,
    ]);

    for (const componentType of allTypes) {
      const baselineNames = new Set(
        this.fetchComponentNames(baseline.id, componentType)
      );
      const currentNames = new Set(
        this.fetchComponentNames(current.id, componentType)
      );

      for (const name of currentNames) {
        if (!baselineNames.has(name)) {
          driftedComponents.push({
            componentType,
            fullName: name,
            changeType: 'added',
            detectedAt: now,
          });
        }
      }

      for (const name of baselineNames) {
        if (!currentNames.has(name)) {
          driftedComponents.push({
            componentType,
            fullName: name,
            changeType: 'removed',
            detectedAt: now,
          });
        }
      }
    }

    const totalBaseline = Math.max(baseline.componentCount, 1);
    const driftScore = Math.min(
      100,
      Math.round((driftedComponents.length / totalBaseline) * 100)
    );

    return {
      orgId,
      driftedComponents,
      driftScore,
      detectedAt: now,
    };
  }
}
