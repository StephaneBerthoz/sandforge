import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { heldRecordChoiceOf, runSettingsOf, writesOverHeld } from './heldRecordChoice';

function object(operation: SyncObjectConfig['operation']): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation,
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
  };
}

describe('writesOverHeld', () => {
  it('is an upsert or an update, which find the record the target holds', () => {
    expect(writesOverHeld('upsert')).toBe(true);
    expect(writesOverHeld('update')).toBe(true);
    expect(writesOverHeld('insert')).toBe(false);
    expect(writesOverHeld('delete')).toBe(false);
  });
});

describe('runSettingsOf', () => {
  it('sends the read of the target, and the choice, for anything but overwriting', () => {
    expect(runSettingsOf('target_wins', true)).toEqual({
      direction: 'bidirectional',
      conflictStrategy: 'target_wins',
    });
    expect(runSettingsOf('merge', true)).toEqual({
      direction: 'bidirectional',
      conflictStrategy: 'merge',
    });
  });

  it('sends the plain write to overwrite with the source, and for a run that finds no held record', () => {
    // Keep the target's values asked of inserts only: nothing to keep, and
    // nothing of the target worth reading.
    expect(runSettingsOf('source_wins', true)).toEqual({
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
    });
    expect(runSettingsOf('target_wins', false)).toEqual({
      direction: 'source_to_target',
      conflictStrategy: 'source_wins',
    });
  });
});

describe('heldRecordChoiceOf', () => {
  it('names the strategy a bidirectional run acted on, and the overwrite any other made', () => {
    expect(
      heldRecordChoiceOf({
        direction: 'bidirectional',
        conflictStrategy: 'newest_wins',
        objects: [object('upsert')],
      }),
    ).toBe('newest_wins');
    // On Source to Target the strategy was never read: the source's values went.
    expect(
      heldRecordChoiceOf({
        direction: 'source_to_target',
        conflictStrategy: 'target_wins',
        objects: [object('update')],
      }),
    ).toBe('source_wins');
  });

  it('names none for a configuration that only inserts', () => {
    expect(
      heldRecordChoiceOf({
        direction: 'bidirectional',
        conflictStrategy: 'target_wins',
        objects: [object('insert')],
      }),
    ).toBeNull();
  });
});
