import { describe, expect, it } from 'vitest';
import { sliceProgressOf } from './sliceProgress';

describe('sliceProgressOf', () => {
  it('reads the slice a run backs up before it masks it', () => {
    expect(sliceProgressOf('Backing up Contact slice 2 of about 4')).toEqual({
      phase: 'backingUp',
      object: 'Contact',
      index: 2,
      about: 4,
    });
  });

  it('reads the slice a run masks, and how far into it', () => {
    expect(sliceProgressOf('Anonymized Contact slice 2 of about 4 (412/1000)')).toEqual({
      phase: 'masking',
      object: 'Contact',
      index: 2,
      about: 4,
      done: 412,
      total: 1000,
    });
  });

  it('reads a resumed slice, which says no count of slices', () => {
    expect(sliceProgressOf('Anonymized Lead slice 3 (10/200)')).toEqual({
      phase: 'masking',
      object: 'Lead',
      index: 3,
      done: 10,
      total: 200,
    });
  });

  it('reads nothing of a step of no slice, which the page says as written', () => {
    expect(sliceProgressOf('Anonymized Contact (12/40)')).toBeUndefined();
    expect(sliceProgressOf('Reading Contact (800 of 2000 records)')).toBeUndefined();
    expect(sliceProgressOf(undefined)).toBeUndefined();
  });
});
