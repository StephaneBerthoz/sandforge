import { describe, expect, it } from 'vitest';
import { parseArgs as autopilotArgs } from './sandforge-autopilot.js';
import { parseArgs as checkpointArgs } from './sandforge-checkpoint.js';
import { parseArgs as cloneArgs, parseRemoveArgs as cloneRemoveArgs } from './sandforge-clone.js';
import { parseArgs as frozenArgs } from './sandforge-frozen.js';
import { parseArgs as seedArgs, parseRemoveArgs as seedRemoveArgs } from './sandforge-seed.js';
import { parseArgs as syncArgs, parseRemoveArgs as syncRemoveArgs } from './sandforge-sync.js';

/**
 * `--mute-automation` read by each command line that writes, and by the
 * removals of those that remove: a flag one of them did not read would be
 * refused as unknown, or, worse, dropped, and the run would write with the
 * target's automation running.
 */
const line = (tool: string, ...args: string[]): string[] => ['node', `${tool}.ts`, ...args];

describe('--mute-automation', () => {
  it('reaches the clone, and its removal', () => {
    expect(
      cloneArgs(
        line(
          'sandforge-clone',
          '--record',
          '001xx0000000001AAA',
          '--source',
          'S',
          '--target',
          'T',
          '--mute-automation',
        ),
        {},
      ).muteAutomation,
    ).toBe(true);
    expect(
      cloneArgs(
        line('sandforge-clone', '--record', '001xx0000000001AAA', '--source', 'S', '--target', 'T'),
        {},
      ).muteAutomation,
    ).toBe(false);
    expect(
      cloneRemoveArgs(
        line('sandforge-clone', '--remove', 's.json', '--target', 'T', '--mute-automation'),
      ).muteAutomation,
    ).toBe(true);
  });

  it('reaches Sync, a saved configuration too, and its removal', () => {
    expect(
      syncArgs(
        line(
          'sandforge-sync',
          '--source',
          'S',
          '--target',
          'T',
          '--object',
          'Account',
          '--mute-automation',
        ),
      ).muteAutomation,
    ).toBe(true);
    expect(
      syncArgs(line('sandforge-sync', '--source', 'S', '--target', 'T', '--object', 'Account'))
        .muteAutomation,
    ).toBe(false);
    expect(
      syncRemoveArgs(
        line('sandforge-sync', '--remove', 'run.json', '--target', 'T', '--mute-automation'),
      ).muteAutomation,
    ).toBe(true);
  });

  it('reaches Seed, and its removal', () => {
    expect(
      seedArgs(
        line('sandforge-seed', '--target', 'T', '--object', 'Account:2', '--mute-automation'),
      ).muteAutomation,
    ).toBe(true);
    expect(
      seedRemoveArgs(
        line('sandforge-seed', '--remove', 'run.json', '--target', 'T', '--mute-automation'),
      ).muteAutomation,
    ).toBe(true);
  });

  it('reaches Autopilot', () => {
    expect(
      autopilotArgs(
        line(
          'sandforge-autopilot',
          '--source',
          'S',
          '--target',
          'T',
          '--object',
          'Account',
          '--mute-automation',
        ),
      ).muteAutomation,
    ).toBe(true);
  });

  it('reaches a Frozen load', () => {
    expect(
      frozenArgs(
        line(
          'sandforge-frozen',
          'load',
          '--config',
          'f.json',
          '--target',
          'T',
          '--mute-automation',
        ),
      ).muteAutomation,
    ).toBe(true);
    expect(
      frozenArgs(line('sandforge-frozen', 'load', '--config', 'f.json', '--target', 'T'))
        .muteAutomation,
    ).toBe(false);
  });

  it('reaches a rewind and an undo', () => {
    expect(
      checkpointArgs(line('sandforge-checkpoint', 'rewind', '--org', 'DEV', '--mute-automation')),
    ).toMatchObject({ command: 'rewind', muteAutomation: true });
    expect(
      checkpointArgs(line('sandforge-checkpoint', 'undo', '--org', 'DEV', '--mute-automation')),
    ).toMatchObject({
      command: 'undo',
      muteAutomation: true,
    });
  });
});
