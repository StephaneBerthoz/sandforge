import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod';

import type {
  CheckpointRewindEnded,
  CheckpointRewindRecord,
  CheckpointRewindUndone,
  RewindStatus,
} from '../types/checkpoint.types.js';
import {
  checkpointRewindEndedSchema,
  checkpointRewindRecordSchema,
  checkpointRewindUndoneSchema,
  rewindStatusSchema,
} from './checkpoint.schema.js';

/*
 * The rewind ledger is read back line by line with these schemas: a line
 * they refuse is left out of the histories' marks, and what the ledger writes
 * is what they parsed. The type assertions are read by the type checker
 * (`tsc -p tsconfig.test.json`).
 */

const ENDED: CheckpointRewindEnded = {
  kind: 'rewind',
  rewindId: 'rw-20261028-120000-aaaa',
  checkpointId: 'ck-20261028-100000-aaaa',
  checkpointName: 'Before UAT',
  organizationId: '00D000000000001AAA',
  mode: 'picked',
  objects: ['Account', 'Contact'],
  readFrom: '2026-10-28T10:00:00.000Z',
  takenAt: '2026-10-28T10:05:00.000Z',
  startedAt: '2026-10-28T12:00:00.000Z',
  endedAt: '2026-10-28T12:10:00.000Z',
  orgAheadMs: -1_250,
  status: 'partial',
  totals: { deleted: 3, restored: 1, undeleted: 2, recreated: 0 },
};

const UNDONE: CheckpointRewindUndone = {
  kind: 'undo',
  rewindId: 'rw-20261028-120000-aaaa',
  checkpointId: 'ck-20261028-100000-aaaa',
  organizationId: '00D000000000001AAA',
  status: 'success',
  undoneAt: '2026-10-28T13:00:00.000Z',
};

describe('the rewind ledger’s lines and their schemas', () => {
  it('reads exactly the shapes the types declare', () => {
    expectTypeOf<
      z.infer<typeof checkpointRewindEndedSchema>
    >().toEqualTypeOf<CheckpointRewindEnded>();
    expectTypeOf<
      z.infer<typeof checkpointRewindUndoneSchema>
    >().toEqualTypeOf<CheckpointRewindUndone>();
    expectTypeOf<
      z.infer<typeof checkpointRewindRecordSchema>
    >().toEqualTypeOf<CheckpointRewindRecord>();
    expectTypeOf<z.infer<typeof rewindStatusSchema>>().toEqualTypeOf<RewindStatus>();
  });

  it('reads a rewind’s line and an undo’s as they were written', () => {
    expect(checkpointRewindRecordSchema.parse(ENDED)).toEqual(ENDED);
    expect(checkpointRewindRecordSchema.parse(UNDONE)).toEqual(UNDONE);
  });

  it('drops a key it does not know, a record’s id among them, rather than refusing the line', () => {
    const parsed = checkpointRewindRecordSchema.parse({
      ...ENDED,
      ids: ['001000000000001AAA'],
      Name: 'Acme',
    });

    expect(parsed).toEqual(ENDED);
  });

  it('refuses a line that names no rewind, a time that is no instant, and an undo that did not go through', () => {
    expect(checkpointRewindRecordSchema.safeParse({ ...ENDED, rewindId: '../x' }).success).toBe(
      false,
    );
    expect(checkpointRewindRecordSchema.safeParse({ ...ENDED, startedAt: 'noon' }).success).toBe(
      false,
    );
    expect(checkpointRewindRecordSchema.safeParse({ ...UNDONE, status: 'cancelled' }).success).toBe(
      false,
    );
    expect(checkpointRewindRecordSchema.safeParse({ ...ENDED, kind: 'take' }).success).toBe(false);
  });

  it('refuses a clock read more than a year off this machine’s', () => {
    const year = 366 * 86_400_000;

    expect(checkpointRewindEndedSchema.safeParse({ ...ENDED, orgAheadMs: year }).success).toBe(
      true,
    );
    expect(checkpointRewindEndedSchema.safeParse({ ...ENDED, orgAheadMs: year + 1 }).success).toBe(
      false,
    );
  });
});
