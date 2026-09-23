import { describe, it, expect, vi } from 'vitest';
import type { BulkDataWriter } from '../sync/BulkDataWriter.js';
import { WriteCancelledError } from '../sync/WriteCancelledError.js';
import { createBulkDmlWriter, DEFAULT_FROZEN_LOAD_BATCH_SIZE } from './BulkDmlWriterAdapter.js';

/** A writer double whose three writes answer as given. */
function writerAnswering(answer: () => Promise<unknown>): BulkDataWriter {
  return {
    insert: vi.fn(answer),
    update: vi.fn(answer),
    delete: vi.fn(answer),
  } as unknown as BulkDataWriter;
}

describe('createBulkDmlWriter', () => {
  it('hands each write to the writer with the load batch size, the org aside', async () => {
    const outcomes = [{ id: '001Fk00000AbCdEIAV', success: true, errors: [] }];
    const writer = writerAnswering(async () => outcomes);
    const dml = createBulkDmlWriter(writer);

    await expect(dml.insert('00D-any', 'Account', [{ Name: 'Anon' }])).resolves.toBe(outcomes);
    await dml.update('00D-any', 'Account', [{ Id: '001Fk00000AbCdEIAV' }]);
    await dml.delete('00D-any', 'Account', ['001Fk00000AbCdEIAV']);

    expect(writer.insert).toHaveBeenCalledWith(
      'Account',
      [{ Name: 'Anon' }],
      DEFAULT_FROZEN_LOAD_BATCH_SIZE,
    );
    expect(writer.update).toHaveBeenCalledWith(
      'Account',
      [{ Id: '001Fk00000AbCdEIAV' }],
      DEFAULT_FROZEN_LOAD_BATCH_SIZE,
    );
    expect(writer.delete).toHaveBeenCalledWith(
      'Account',
      ['001Fk00000AbCdEIAV'],
      DEFAULT_FROZEN_LOAD_BATCH_SIZE,
    );
  });

  it('answers a write the cancel aborted with nothing written, for the loader to stop at its next check', async () => {
    // Raised through the loader, the cancel ended the load as a failure
    // before the mapping of what it had written was kept.
    const dml = createBulkDmlWriter(
      writerAnswering(async () => {
        throw new WriteCancelledError('Contact');
      }),
    );

    await expect(dml.insert('00D-any', 'Contact', [{ LastName: 'Doe' }])).resolves.toEqual([]);
    await expect(dml.update('00D-any', 'Contact', [{ Id: '003x' }])).resolves.toEqual([]);
    await expect(dml.delete('00D-any', 'Contact', ['003x'])).resolves.toEqual([]);
  });

  it('answers a write stopped between two batches with what the batches before wrote', async () => {
    // The loader maps each written record to its new id: answered with
    // nothing, those records stayed in the org with no mapping to find them.
    const written = [{ id: '003Fk00000AbCdEIAV', success: true, errors: [] }];
    const dml = createBulkDmlWriter(
      writerAnswering(async () => {
        throw new WriteCancelledError('Contact', written);
      }),
    );

    await expect(
      dml.insert('00D-any', 'Contact', [{ LastName: 'Doe' }, { LastName: 'Roe' }]),
    ).resolves.toBe(written);
  });

  it('lets any other error through: a failure stays a failure', async () => {
    const dml = createBulkDmlWriter(
      writerAnswering(async () => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      }),
    );

    await expect(dml.insert('00D-any', 'Contact', [{ LastName: 'Doe' }])).rejects.toThrow(
      'INVALID_SESSION_ID',
    );
  });
});
