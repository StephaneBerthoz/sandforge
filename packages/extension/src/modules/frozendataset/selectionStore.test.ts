import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';
import {
  readSelectionFromSas,
  SELECTION_FILE_NAME,
  writeSelectionToSas,
} from './selectionStore.js';
import type { CoverageSelectionResult } from './CoverageMatrixSelector.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-sel-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sampleSelection: CoverageSelectionResult = {
  roots: [
    {
      rootRecordId: '001SOURCEID000001',
      combinationKey: 'prestation=RC',
      axisValues: { prestation: 'RC' },
    },
  ],
  uncovered: [],
  volumetry: { measured: { Dossier__c: 1 }, total: 1, budgetMax: 2500 },
  selectedAt: '2026-08-03T09:00:00.000Z',
};

describe('selectionStore', () => {
  it('writes the retained-ID list to the sas and reads it back', () => {
    const dir = makeTmpDir();
    const guard = new SasPathGuard(path.join(dir, 'fake-repo'));
    const written = writeSelectionToSas(dir, sampleSelection, guard);
    expect(path.basename(written)).toBe(SELECTION_FILE_NAME);
    expect(fs.existsSync(written)).toBe(true);
    expect(readSelectionFromSas(dir, guard)).toEqual(sampleSelection);
  });

  it('refuses to write the ID list inside the repository', () => {
    const guard = new SasPathGuard();
    const insideRepo = path.join(guard.repoRoot, 'frozen-export');
    expect(() => writeSelectionToSas(insideRepo, sampleSelection, guard)).toThrow(
      InsideRepoPathError,
    );
    expect(fs.existsSync(insideRepo)).toBe(false);
  });

  it('refuses to read a selection from inside the repository', () => {
    const guard = new SasPathGuard();
    expect(() => readSelectionFromSas(guard.repoRoot, guard)).toThrow(InsideRepoPathError);
  });
});
