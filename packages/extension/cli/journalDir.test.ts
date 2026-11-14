import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JOURNAL_DIR_VARIABLE, journalDirOf } from './journalDir.js';
import { journalDirOf as ofTheCloneScript } from './sandforge-clone.js';

describe('journalDirOf', () => {
  it('keeps the journals in SANDFORGE_JOURNAL_DIR, resolved, or in .sandforge of the home directory', () => {
    expect(JOURNAL_DIR_VARIABLE).toBe('SANDFORGE_JOURNAL_DIR');
    expect(journalDirOf({ SANDFORGE_JOURNAL_DIR: 'runs' })).toBe(resolve('runs'));
    expect(journalDirOf({ SANDFORGE_JOURNAL_DIR: '/var/runs' })).toBe(resolve('/var/runs'));
    expect(journalDirOf({})).toBe(join(homedir(), '.sandforge'));
  });

  it('reads a variable set to blanks as unset', () => {
    expect(journalDirOf({ SANDFORGE_JOURNAL_DIR: '  ' })).toBe(join(homedir(), '.sandforge'));
  });

  it('is the one the clone script still gives the scripts that import it from there', () => {
    expect(ofTheCloneScript).toBe(journalDirOf);
  });
});
