/**
 * Frozen dataset writer: the ONLY service that persists the frozen
 * artifacts. It hard-requires a PASS from the non-reidentification
 * control — a FAIL means nothing is written, hence nothing can be
 * versioned. Output always goes through the SasPathGuard, so artifacts
 * can only land outside the repository.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NonReidentificationReport } from './NonReidentificationControl.js';
import { SasPathGuard } from './SasPathGuard.js';
import { serializeManifest, type FrozenManifest } from './manifest.js';
import type { FrozenDataset } from './types.js';

/** Thrown when a write is attempted with a failed control gate. */
export class ControlNotPassedError extends Error {
  constructor(report: NonReidentificationReport) {
    const failed = report.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.name} (${c.violations.length} violation(s))`)
      .join(', ');
    super(
      `Refusing to write the frozen dataset: non-reidentification control FAILED ` +
        `[${failed}]. A FAIL means nothing is written or versioned.`,
    );
    this.name = 'ControlNotPassedError';
  }
}

/** Result of a successful write. */
export interface FrozenDatasetWriteResult {
  /** Absolute output directory. */
  dir: string;
  /** Absolute paths of every file written. */
  files: string[];
}

/**
 * Persists the frozen dataset: `manifest.json`, one `data/<Object>.json`
 * per object, `record-types.json`, `personcontact-sidecar.json`.
 */
export class FrozenDatasetWriter {
  private readonly guard: SasPathGuard;

  constructor(guard?: SasPathGuard) {
    this.guard = guard ?? new SasPathGuard();
  }

  /**
   * Write the frozen artifacts. Rejects with {@link ControlNotPassedError}
   * BEFORE touching the filesystem when the gate report is not a PASS.
   *
   * Every write goes through `fs/promises`: a dataset is written from the
   * extension host, and a synchronous write held the extension host for as
   * long as the disk took.
   */
  async write(
    outputDir: string,
    dataset: FrozenDataset,
    manifest: FrozenManifest,
    control: NonReidentificationReport,
  ): Promise<FrozenDatasetWriteResult> {
    if (!control.passed) {
      throw new ControlNotPassedError(control);
    }
    const dir = this.guard.assertOutsideRepo(outputDir);
    const dataDir = this.guard.assertOutsideRepo(path.join(dir, 'data'));
    await fs.mkdir(dataDir, { recursive: true });

    const files: string[] = [];
    // Data files are read back by the loader, never by hand: compact JSON,
    // where the manifest keeps the indentation a reader needs.
    const writeJson = async (absPath: string, payload: unknown): Promise<void> => {
      const validated = this.guard.assertOutsideRepo(absPath);
      await fs.writeFile(validated, `${JSON.stringify(payload)}\n`, 'utf8');
      files.push(validated);
    };

    const manifestPath = this.guard.assertOutsideRepo(path.join(dir, 'manifest.json'));
    await fs.writeFile(manifestPath, serializeManifest(manifest), 'utf8');
    files.push(manifestPath);

    for (const objectData of dataset.objects) {
      await writeJson(path.join(dataDir, `${objectData.objectApiName}.json`), {
        objectApiName: objectData.objectApiName,
        records: objectData.records,
      });
    }
    await writeJson(path.join(dir, 'record-types.json'), dataset.recordTypes);
    await writeJson(path.join(dir, 'personcontact-sidecar.json'), dataset.personContactSidecar);

    return { dir, files };
  }
}
