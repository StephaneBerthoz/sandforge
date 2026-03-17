import { describe, it, expect } from 'vitest';
import { computeDiff } from './diffWorker';
import type { DiffInput } from './diffWorker';

function makeDiffInput(
  source: Array<Record<string, unknown>>,
  target: Array<Record<string, unknown>>,
  keyField = 'Id'
): DiffInput {
  return { source, target, keyField };
}

describe('computeDiff', () => {
  it('should detect added records in target', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice' }],
      [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]
    );
    const result = computeDiff(input);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toEqual({ Id: '2', Name: 'Bob' });
  });

  it('should detect removed records from source', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }],
      [{ Id: '1', Name: 'Alice' }]
    );
    const result = computeDiff(input);

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toEqual({ Id: '2', Name: 'Bob' });
  });

  it('should detect modified records with field-level changes', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice', Age: 30 }],
      [{ Id: '1', Name: 'Alice Updated', Age: 31 }]
    );
    const result = computeDiff(input);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].key).toBe('1');
    expect(result.modified[0].changes).toEqual({
      Name: { old: 'Alice', new: 'Alice Updated' },
      Age: { old: 30, new: 31 },
    });
  });

  it('should count unchanged records', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }],
      [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]
    );
    const result = computeDiff(input);

    expect(result.unchanged).toBe(2);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });

  it('should handle empty source (all added)', () => {
    const input = makeDiffInput(
      [],
      [{ Id: '1', Name: 'Alice' }]
    );
    const result = computeDiff(input);

    expect(result.added).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
    expect(result.unchanged).toBe(0);
  });

  it('should handle empty target (all removed)', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice' }],
      []
    );
    const result = computeDiff(input);

    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(result.unchanged).toBe(0);
  });

  it('should handle both source and target empty', () => {
    const input = makeDiffInput([], []);
    const result = computeDiff(input);

    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.unchanged).toBe(0);
  });

  it('should not include the key field in changes', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice' }],
      [{ Id: '1', Name: 'Bob' }]
    );
    const result = computeDiff(input);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changes).not.toHaveProperty('Id');
  });

  it('should detect fields added in target record', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice' }],
      [{ Id: '1', Name: 'Alice', Email: 'alice@example.com' }]
    );
    const result = computeDiff(input);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changes).toEqual({
      Email: { old: undefined, new: 'alice@example.com' },
    });
  });

  it('should detect fields removed from source record', () => {
    const input = makeDiffInput(
      [{ Id: '1', Name: 'Alice', Phone: '555-1234' }],
      [{ Id: '1', Name: 'Alice' }]
    );
    const result = computeDiff(input);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changes).toEqual({
      Phone: { old: '555-1234', new: undefined },
    });
  });

  it('should handle object values correctly', () => {
    const input = makeDiffInput(
      [{ Id: '1', Address: { city: 'Paris' } }],
      [{ Id: '1', Address: { city: 'Lyon' } }]
    );
    const result = computeDiff(input);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changes.Address.old).toEqual({ city: 'Paris' });
    expect(result.modified[0].changes.Address.new).toEqual({ city: 'Lyon' });
  });

  it('should handle a mixed scenario with adds, removes, modifies, and unchanged', () => {
    const input = makeDiffInput(
      [
        { Id: '1', Name: 'Alice' },
        { Id: '2', Name: 'Bob' },
        { Id: '3', Name: 'Charlie' },
      ],
      [
        { Id: '1', Name: 'Alice' },
        { Id: '2', Name: 'Bob Updated' },
        { Id: '4', Name: 'Diana' },
      ]
    );
    const result = computeDiff(input);

    expect(result.unchanged).toBe(1);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].key).toBe('2');
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toEqual({ Id: '3', Name: 'Charlie' });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toEqual({ Id: '4', Name: 'Diana' });
  });

  it('should use a custom key field', () => {
    const input: DiffInput = {
      source: [{ ExternalId: 'A', Value: 1 }],
      target: [{ ExternalId: 'A', Value: 2 }],
      keyField: 'ExternalId',
    };
    const result = computeDiff(input);

    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].key).toBe('A');
    expect(result.modified[0].changes).not.toHaveProperty('ExternalId');
  });
});
