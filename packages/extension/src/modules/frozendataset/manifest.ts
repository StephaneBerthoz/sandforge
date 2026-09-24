/**
 * Frozen dataset manifest: the versioned identity card of a frozen
 * dataset. Contains NO source data — only the salt FINGERPRINT,
 * volumetry, and control outcomes.
 */

import type { FrozenExclusionCost, FrozenLeftToThePlatform } from '@sandforge/shared';
import { leftToThePlatformNote, type RowsLeftOut } from '../../core/common/platformRecords.js';
import type { NonReidentificationReport } from './NonReidentificationControl.js';

/** Source-org identity recorded in the manifest. */
export interface ManifestSource {
  /** Source org ID. */
  orgId: string;
  /** Source org alias, when known. */
  orgAlias?: string;
  /** Date the coverage selection was decided (ISO). */
  decisionDate: string;
}

/** Volumetry section: the ceiling plus what was actually measured. */
export interface ManifestVolumetry {
  /** Configured budget ceiling (records). */
  budgetMax: number;
  /** Measured record counts per object. */
  measured: Record<string, number>;
  /** ISO timestamp of the measurement. */
  measuredAt: string;
}

/**
 * EXTENSION POINT for the load phase: the dry-run load outcome is filled
 * by the load phase; the core engine always writes `null`.
 */
export interface DryRunLoadControl {
  status: 'pending' | 'passed' | 'failed';
  at?: string;
  detail?: string;
}

/** Controls section of the manifest. */
export interface ManifestControls {
  /** Four-point non-reidentification gate report. */
  nonReidentification: NonReidentificationReport;
  /** Dry-run load outcome — null until the load phase runs. */
  dryRunLoad: DryRunLoadControl | null;
  /** Who froze the dataset. */
  author: string;
  /** When the controls were consigned (ISO). */
  date: string;
}

/**
 * What the extraction reached. A dataset is only as complete as the graph it
 * was read through, and a frozen one is used as a reference: one read through
 * a graph cut short at its object cap has to say so where it is described.
 */
export interface ManifestCoverage {
  /** Objects discovery reached. */
  objects: number;
  /** Discovery stopped at its object cap: objects further out were never read. */
  truncated: boolean;
  /** The object cap discovery ran with. */
  maxNodes: number;
  /** Objects read without `CreatedDate <= asOf`, having no such field. */
  unboundedObjects: string[];
  /** Objects left out because they carry files the rules do not keep. */
  filesLeftOut: string[];
  /**
   * Records left out because the platform writes them, or what they depend
   * on, itself — see {@link leftToThePlatformCoverage}. Absent when none was,
   * and from manifests written before it was recorded.
   */
  leftToThePlatform?: FrozenLeftToThePlatform[];
  /**
   * Records held that cannot be loaded as they are, for an object
   * `excludedObjects` leaves out. Absent when none is, and from manifests
   * written before it was recorded.
   */
  exclusionCosts?: FrozenExclusionCost[];
}

/**
 * What a manifest says of the records an extraction left to the platform:
 * per object and reason, how many, and why in words.
 */
export function leftToThePlatformCoverage(
  counts: readonly RowsLeftOut[],
): FrozenLeftToThePlatform[] {
  return counts.map(({ objectApiName, why, count }) => ({
    objectApiName,
    count,
    note: leftToThePlatformNote(count, why),
  }));
}

/** The frozen dataset manifest. */
export interface FrozenManifest {
  /** Human semver of the dataset content. */
  version: string;
  status: 'frozen';
  /** ISO timestamp of the freeze. */
  frozenAt: string;
  source: ManifestSource;
  /** SHA-256 fingerprint (12 hex) of the salt — never the salt itself. */
  saltFingerprint: string;
  /** Semver of the pseudonymization rules file used. */
  rulesVersion: string;
  volumetry: ManifestVolumetry;
  controls: ManifestControls;
  /** Absent from manifests written before coverage was recorded. */
  coverage?: ManifestCoverage;
}

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;
const FINGERPRINT_REGEX = /^[0-9a-f]{12}$/;

/** Inputs required to build a manifest. */
export interface BuildManifestInput {
  version: string;
  source: ManifestSource;
  saltFingerprint: string;
  rulesVersion: string;
  volumetry: ManifestVolumetry;
  nonReidentification: NonReidentificationReport;
  author: string;
  coverage?: ManifestCoverage;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Error thrown for invalid manifest content. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Build and validate a manifest. `dryRunLoad` starts null (load phase). */
export function buildFrozenManifest(input: BuildManifestInput): FrozenManifest {
  const now = (input.now?.() ?? new Date()).toISOString();
  const manifest: FrozenManifest = {
    version: input.version,
    status: 'frozen',
    frozenAt: now,
    source: input.source,
    saltFingerprint: input.saltFingerprint,
    rulesVersion: input.rulesVersion,
    volumetry: input.volumetry,
    controls: {
      nonReidentification: input.nonReidentification,
      dryRunLoad: null,
      author: input.author,
      date: now,
    },
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };
  validateManifest(manifest);
  return manifest;
}

/** Validate the required fields of a manifest (throws {@link ManifestError}). */
export function validateManifest(manifest: FrozenManifest): void {
  if (!SEMVER_REGEX.test(manifest.version)) {
    throw new ManifestError(`version must be semver, got ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.status !== 'frozen') {
    throw new ManifestError(`status must be "frozen", got ${JSON.stringify(manifest.status)}`);
  }
  if (!manifest.frozenAt) {
    throw new ManifestError('frozenAt is required');
  }
  if (!manifest.source?.orgId || !manifest.source.decisionDate) {
    throw new ManifestError('source.orgId and source.decisionDate are required');
  }
  if (!FINGERPRINT_REGEX.test(manifest.saltFingerprint)) {
    throw new ManifestError('saltFingerprint must be 12 lowercase hex chars of the salt SHA-256');
  }
  if (!SEMVER_REGEX.test(manifest.rulesVersion)) {
    throw new ManifestError(
      `rulesVersion must be semver, got ${JSON.stringify(manifest.rulesVersion)}`,
    );
  }
  if (typeof manifest.volumetry?.budgetMax !== 'number' || !manifest.volumetry.measured) {
    throw new ManifestError('volumetry.budgetMax and volumetry.measured are required');
  }
  if (!manifest.controls?.nonReidentification) {
    throw new ManifestError('controls.nonReidentification is required');
  }
  if (!manifest.controls.author || !manifest.controls.date) {
    throw new ManifestError('controls.author and controls.date are required');
  }
  const coverage = manifest.coverage;
  if (
    coverage !== undefined &&
    (typeof coverage.objects !== 'number' ||
      typeof coverage.truncated !== 'boolean' ||
      typeof coverage.maxNodes !== 'number' ||
      !Array.isArray(coverage.unboundedObjects) ||
      !Array.isArray(coverage.filesLeftOut) ||
      (coverage.leftToThePlatform !== undefined && !Array.isArray(coverage.leftToThePlatform)) ||
      (coverage.exclusionCosts !== undefined && !Array.isArray(coverage.exclusionCosts)))
  ) {
    throw new ManifestError(
      'coverage, when present, needs objects, truncated, maxNodes, unboundedObjects and ' +
        'filesLeftOut, and a list of what it left to the platform, or of what its exclusions ' +
        'cost, if it names any',
    );
  }
}

/** Serialize a manifest to stable pretty JSON. */
export function serializeManifest(manifest: FrozenManifest): string {
  validateManifest(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parse a manifest from JSON, validating required fields. */
export function parseManifest(payload: unknown): FrozenManifest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ManifestError('Manifest must be a JSON object');
  }
  const manifest = payload as FrozenManifest;
  validateManifest(manifest);
  return manifest;
}
