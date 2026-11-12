import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOutputFiles } from './sfOutputFiles';
import type { OutputFilePaths } from './sfOutputFiles';

describe('readOutputFiles', () => {
  it('hands the run two files of a new folder in the temp folder, reads them, then removes the folder', async () => {
    let given: OutputFilePaths | undefined;

    const files = await readOutputFiles(async (paths) => {
      given = paths;
      expect(existsSync(dirname(paths.stdout))).toBe(true);
      writeFileSync(paths.stdout, '{"status":0}');
      writeFileSync(paths.stderr, 'Warning: one');
    });

    expect(files).toEqual({ stdout: '{"status":0}', stderr: 'Warning: one' });
    expect(given).toBeDefined();
    const folder = dirname(given?.stdout ?? '');
    expect(dirname(given?.stderr ?? '')).toBe(folder);
    expect(dirname(folder)).toBe(tmpdir());
    expect(basename(folder)).toMatch(/^sandforge-sf-/);
    expect(existsSync(folder)).toBe(false);
  });

  it('gives each run a folder of its own', async () => {
    const folders: string[] = [];
    const record = async (paths: OutputFilePaths): Promise<void> => {
      folders.push(dirname(paths.stdout));
    };

    await readOutputFiles(record);
    await readOutputFiles(record);

    expect(new Set(folders).size).toBe(2);
  });

  it('returns what the run wrote and how it failed, and removes the folder all the same', async () => {
    let folder = '';
    const refusal = new Error('Command failed: sf org list --json');

    const files = await readOutputFiles(async (paths) => {
      folder = dirname(paths.stdout);
      writeFileSync(paths.stdout, '{"status":1}');
      throw refusal;
    });

    expect(files).toEqual({ stdout: '{"status":1}', stderr: '', failure: refusal });
    expect(existsSync(folder)).toBe(false);
  });

  it('reads a file the run never wrote as nothing', async () => {
    const files = await readOutputFiles(async () => undefined);

    expect(files).toEqual({ stdout: '', stderr: '' });
  });
});
