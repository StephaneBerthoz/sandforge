import { describe, it, expect } from 'vitest';
import {
  freeSyncConfigName,
  syncConfigNameRefused,
  syncConfigNameTaken,
} from './sync-config-names';

const SAVED = [
  { id: 'cfg-1', name: 'DevSandbox → QASandbox' },
  { id: 'cfg-2', name: 'Nightly accounts' },
];

describe('syncConfigNameTaken', () => {
  it('finds a name another saved configuration has, whatever its case and spaces', () => {
    expect(syncConfigNameTaken(SAVED, 'Nightly accounts')).toBe(true);
    expect(syncConfigNameTaken(SAVED, '  nightly ACCOUNTS ')).toBe(true);
    expect(syncConfigNameTaken(SAVED, 'Weekly accounts')).toBe(false);
  });

  it('leaves a configuration its own name', () => {
    expect(syncConfigNameTaken(SAVED, 'Nightly accounts', 'cfg-2')).toBe(false);
    expect(syncConfigNameTaken(SAVED, 'Nightly accounts', 'cfg-1')).toBe(true);
  });
});

describe('syncConfigNameRefused', () => {
  it('refuses a new configuration a name another one has', () => {
    expect(syncConfigNameRefused(SAVED, 'cfg-new', 'DevSandbox → QASandbox')).toBe(true);
    expect(syncConfigNameRefused(SAVED, 'cfg-new', 'DevSandbox → QASandbox (2)')).toBe(false);
  });

  it('refuses a saved configuration renamed to the name of another', () => {
    expect(syncConfigNameRefused(SAVED, 'cfg-2', 'devsandbox → qasandbox')).toBe(true);
    expect(syncConfigNameRefused(SAVED, 'cfg-2', 'Nightly contacts')).toBe(false);
  });

  it('saves again under its own name a configuration that shares it with an older one', () => {
    // Saved before the rule held, two entries of one pair carry one name: a
    // schedule runs each by its id, and saving one again must not fail.
    const older = [
      { id: 'cfg-a', name: 'dev1 → dev2' },
      { id: 'cfg-b', name: 'dev1 → dev2' },
    ];
    expect(syncConfigNameRefused(older, 'cfg-a', 'dev1 → dev2')).toBe(false);
    expect(syncConfigNameRefused(older, 'cfg-c', 'dev1 → dev2')).toBe(true);
  });
});

describe('freeSyncConfigName', () => {
  it('proposes the name itself while no other configuration has it', () => {
    expect(freeSyncConfigName(SAVED, 'Weekly accounts')).toBe('Weekly accounts');
    expect(freeSyncConfigName(SAVED, 'Nightly accounts', 'cfg-2')).toBe('Nightly accounts');
  });

  it('numbers it from 2 when the name is taken, past every number taken too', () => {
    expect(freeSyncConfigName(SAVED, 'DevSandbox → QASandbox')).toBe('DevSandbox → QASandbox (2)');
    const taken = [
      ...SAVED,
      { id: 'cfg-3', name: 'DevSandbox → QASandbox (2)' },
      { id: 'cfg-4', name: 'devsandbox → qasandbox (3)' },
    ];
    expect(freeSyncConfigName(taken, 'DevSandbox → QASandbox')).toBe('DevSandbox → QASandbox (4)');
  });

  it('proposes nothing the host would refuse', () => {
    const proposed = freeSyncConfigName(SAVED, 'Nightly accounts');
    expect(syncConfigNameRefused(SAVED, 'cfg-new', proposed)).toBe(false);
  });
});
