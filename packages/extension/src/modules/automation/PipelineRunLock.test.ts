import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LockSelf } from '../checkpoint/linkedLock.js';
import {
  acquirePipelineRunLock,
  defaultPipelinesRoot,
  pipelineFolderName,
  pipelineFolderOf,
  pipelineLockTakenOverLine,
  pipelineRunLockFileOf,
  pipelineRunLockHolder,
  pipelineRunningRefusal,
} from './PipelineRunLock.js';

const PIPELINE = '3f1c2b9e-6a0d-4c8e-9b7a-2d4f6e8a1c3b';

const NOW = Date.parse('2026-11-20T02:00:00.000Z');
const BOOTED = NOW - 3 * 60 * 60_000;

/** A command line run of this machine, started an hour before {@link NOW}. */
const CRON_RUN: LockSelf = {
  host: hostname(),
  pid: 4242,
  startedAt: new Date(NOW - 60 * 60_000).toISOString(),
};

const checks = (alive: boolean) => ({
  isAlive: () => alive,
  bootedAt: () => BOOTED,
  now: () => NOW,
});

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function pipelinesRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-lock-'));
  made.push(dir);
  return join(dir, 'pipelines');
}

describe('the run lock of a pipeline', () => {
  it('sits in the pipeline folder of the journal SANDFORGE_JOURNAL_DIR names, or of ~/.sandforge', () => {
    expect(defaultPipelinesRoot({ SANDFORGE_JOURNAL_DIR: '/var/journal' })).toBe(
      resolve('/var/journal', 'pipelines'),
    );
    expect(defaultPipelinesRoot({ SANDFORGE_JOURNAL_DIR: '  ' })).toBe(
      join(homedir(), '.sandforge', 'pipelines'),
    );
    expect(defaultPipelinesRoot({})).toBe(join(homedir(), '.sandforge', 'pipelines'));
    expect(pipelineRunLockFileOf('/root', PIPELINE)).toBe(join('/root', PIPELINE, 'run.lock'));
  });

  it('names a pipeline whose id is no plain name by a digest, never by the id as a path', () => {
    expect(pipelineFolderName(PIPELINE)).toBe(PIPELINE);
    for (const id of ['../../etc', 'a/b', 'nightly reset', '..', '.hidden', 'x'.repeat(101)]) {
      const name = pipelineFolderName(id);
      expect(name, id).toMatch(/^p-[0-9a-f]{32}$/);
    }
    expect(pipelineFolderName('a/b')).toBe(pipelineFolderName('a/b'));
    expect(pipelineFolderName('a/b')).not.toBe(pipelineFolderName('a\\b'));
    expect(pipelineFolderOf('/root', '../x')).toBe(join('/root', pipelineFolderName('../x')));
  });

  it('is held once on the machine: a run from the command line refuses the editor, which is told who and since when', () => {
    const root = pipelinesRoot();
    const cron = acquirePipelineRunLock(
      root,
      PIPELINE,
      { pipelineName: 'Nightly reset', ranFrom: 'commandLine', triggeredBy: 'schedule' },
      { self: CRON_RUN, checks: checks(true) },
    );
    if (!('lock' in cron)) throw new Error('the lock was not taken');
    expect(cron.tookOver).toBeUndefined();

    const editor = acquirePipelineRunLock(
      root,
      PIPELINE,
      { pipelineName: 'Nightly reset', ranFrom: 'editor', triggeredBy: 'manual' },
      { checks: checks(true) },
    );

    if (!('busy' in editor)) throw new Error('the editor took a lock the command line holds');
    expect(editor.busy).toMatchObject({
      pipelineId: PIPELINE,
      ranFrom: 'commandLine',
      triggeredBy: 'schedule',
      pid: 4242,
    });
    expect(pipelineRunningRefusal(editor.busy, 'Nightly reset')).toBe(
      'Pipeline "Nightly reset" is already running on this machine: a run from the command line ' +
        `(sandforge pipeline run) started at ${editor.busy.acquiredAt} (process 4242 on ${hostname()}) ` +
        'has not ended. A pipeline runs once at a time: run it again once that run ends.',
    );
  });

  it('is taken over from a run whose process has ended, and the take says whose it was', () => {
    const root = pipelinesRoot();
    const crashed = acquirePipelineRunLock(
      root,
      PIPELINE,
      { pipelineName: 'Nightly reset', ranFrom: 'commandLine', triggeredBy: 'schedule' },
      { self: CRON_RUN, checks: checks(true) },
    );
    if (!('lock' in crashed)) throw new Error('the lock was not taken');

    const editor = acquirePipelineRunLock(
      root,
      PIPELINE,
      { pipelineName: 'Nightly reset', ranFrom: 'editor', triggeredBy: 'manual' },
      { checks: checks(false) },
    );

    if (!('lock' in editor)) throw new Error('the lock of a process gone was not taken over');
    expect(editor.tookOver).toMatchObject({ pid: 4242, ranFrom: 'commandLine' });
    expect(pipelineLockTakenOverLine(editor.tookOver!)).toContain(
      'was left by a run from the command line (sandforge pipeline run)',
    );
    expect(pipelineRunLockHolder(root, PIPELINE)).toMatchObject({
      ranFrom: 'editor',
      pid: process.pid,
    });
    editor.lock.release();
  });

  it('is let go by its release, once or twice, and its file is its owner’s alone', () => {
    const root = pipelinesRoot();
    const taken = acquirePipelineRunLock(root, PIPELINE, {
      ranFrom: 'editor',
      triggeredBy: 'manual',
      dryRun: true,
    });
    if (!('lock' in taken)) throw new Error('the lock was not taken');
    const file = pipelineRunLockFileOf(root, PIPELINE);
    // Windows keeps no permission bits: Node reads 0o666 there, whatever was asked.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ dryRun: true });

    taken.lock.release();
    taken.lock.release();

    expect(existsSync(file)).toBe(false);
    expect(pipelineRunLockHolder(root, PIPELINE)).toBeUndefined();
    const again = acquirePipelineRunLock(root, PIPELINE, {
      ranFrom: 'commandLine',
      triggeredBy: 'manual',
    });
    expect('lock' in again && again.tookOver === undefined).toBe(true);
    if ('lock' in again) again.lock.release();
  });

  it('keeps two pipelines apart from each other’s locks', () => {
    const root = pipelinesRoot();
    const one = acquirePipelineRunLock(root, PIPELINE, {
      ranFrom: 'editor',
      triggeredBy: 'manual',
    });
    const two = acquirePipelineRunLock(root, 'other-pipeline', {
      ranFrom: 'editor',
      triggeredBy: 'manual',
    });
    expect('lock' in one && 'lock' in two).toBe(true);
    if ('lock' in one) one.lock.release();
    if ('lock' in two) two.lock.release();
  });
});
