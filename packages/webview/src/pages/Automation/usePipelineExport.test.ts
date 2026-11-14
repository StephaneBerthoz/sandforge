import { describe, it, expect } from 'vitest';
import type { PipelineDefinition, PipelineRunsOutside } from '@sandforge/shared';
import {
  SAVE_DIALOG_WAIT_MS,
  baseNameOf,
  folderOf,
  handOverWithheld,
  handedOverPipeline,
} from './usePipelineExport';

const EXPORTED = { fileName: 'nightly.sandforge-pipeline.json' };

const OUTSIDE: PipelineRunsOutside = {
  since: '2026-11-20T08:00:00.000Z',
  runner: 'cron',
  file: 'nightly.sandforge-pipeline.json',
  digest: `sha256:${'e'.repeat(64)}`,
};

describe('usePipelineExport', () => {
  it('reads a file’s name and folder from a path of either separator', () => {
    expect(baseNameOf('/home/me/x/nightly.sh')).toBe('nightly.sh');
    expect(baseNameOf('C:\\Users\\me\\nightly.ps1')).toBe('nightly.ps1');
    expect(baseNameOf('nightly.sh')).toBe('nightly.sh');
    expect(folderOf('/home/me/x/nightly.sh')).toBe('/home/me/x');
    expect(folderOf('C:\\Users\\me\\nightly.ps1')).toBe('C:\\Users\\me');
  });

  it('withholds the hand-over from a launcher that would not find its file', () => {
    // Renamed in the Save dialog: the launcher runs the file by the name the export gave it.
    expect(
      handOverWithheld(EXPORTED, 'cron', '/home/me/x/other.json', '/home/me/x/nightly.sh'),
    ).toBe('renamed');
    // Apart: bash and PowerShell run the file from their own folder.
    expect(
      handOverWithheld(
        EXPORTED,
        'taskScheduler',
        'C:\\a\\nightly.sandforge-pipeline.json',
        'C:\\b\\nightly.ps1',
      ),
    ).toBe('apart');
    expect(
      handOverWithheld(
        EXPORTED,
        'cron',
        '/home/me/x/nightly.sandforge-pipeline.json',
        '/home/me/x/nightly.sh',
      ),
    ).toBeUndefined();
    // A workflow is committed under .github/workflows, the file at the root.
    expect(
      handOverWithheld(
        EXPORTED,
        'githubActions',
        '/repo/nightly.sandforge-pipeline.json',
        '/repo/.github/workflows/nightly.yml',
      ),
    ).toBeUndefined();
  });

  it('hands over the schedule triggers alone, and none of the fields the store stamps', () => {
    const saved = {
      id: 'p',
      name: 'Nightly',
      description: '',
      version: 1,
      steps: [],
      triggers: [
        { id: 'a', type: 'schedule', enabled: true, config: { cron: '0 2 * * *' } },
        { id: 'b', type: 'sandbox_refresh', enabled: true, config: { orgId: 'o' } },
      ],
      variables: [],
      tags: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      key: 'pipeline:saved:p',
      savedAt: '2026-11-02T00:00:00.000Z',
    } as unknown as PipelineDefinition;

    const handed = handedOverPipeline(saved, OUTSIDE);

    expect(handed.triggers.map((trigger) => [trigger.id, trigger.enabled])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(handed.runsOutside).toEqual(OUTSIDE);
    expect(handed).not.toHaveProperty('key');
    expect(handed).not.toHaveProperty('savedAt');
    // The pipeline the page holds is left as it was.
    expect(saved.triggers[0].enabled).toBe(true);
  });

  it('waits on a Save dialog far past the bridge’s 30 seconds: a person chooses the folder', () => {
    expect(SAVE_DIALOG_WAIT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
