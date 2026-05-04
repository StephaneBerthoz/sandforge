import { describe, it, expect } from 'vitest';
import { searchRecords } from './searchWorker';
import type { SearchInput } from './searchWorker';

const sampleData: Array<Record<string, unknown>> = [
  { Id: '1', Name: 'Alice Johnson', Email: 'alice@example.com', City: 'Paris' },
  { Id: '2', Name: 'Bob Smith', Email: 'bob@example.com', City: 'London' },
  { Id: '3', Name: 'Charlie Brown', Email: 'charlie@test.org', City: 'New York' },
  { Id: '4', Name: 'Diana Prince', Email: 'diana@example.com', City: 'Metropolis' },
  { Id: '5', Name: 'Eve Adams', Email: 'eve@test.org', City: 'Berlin' },
];

function makeInput(overrides?: Partial<SearchInput>): SearchInput {
  return {
    data: sampleData,
    query: '',
    ...overrides,
  };
}

describe('searchRecords', () => {
  it('should return no matches for an empty query', () => {
    const result = searchRecords(makeInput({ query: '' }));

    expect(result.matches).toHaveLength(0);
    expect(result.totalSearched).toBe(5);
  });

  it('should find records matching across all fields by default', () => {
    const result = searchRecords(makeInput({ query: 'example.com' }));

    expect(result.matches).toHaveLength(3);
    const ids = result.matches.map((m) => m.record.Id);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
    expect(ids).toContain('4');
  });

  it('should restrict search to specified fields', () => {
    const result = searchRecords(
      makeInput({
        query: 'alice',
        fields: ['Name'],
        caseSensitive: false,
      }),
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedFields).toEqual(['Name']);
  });

  it('should not match on excluded fields', () => {
    const result = searchRecords(
      makeInput({
        query: 'alice@example.com',
        fields: ['Name', 'City'],
      }),
    );

    expect(result.matches).toHaveLength(0);
  });

  it('should perform case-insensitive search by default', () => {
    const result = searchRecords(makeInput({ query: 'ALICE' }));

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].record.Name).toBe('Alice Johnson');
  });

  it('should respect case-sensitive flag', () => {
    const result = searchRecords(
      makeInput({
        query: 'ALICE',
        caseSensitive: true,
      }),
    );

    expect(result.matches).toHaveLength(0);
  });

  it('should match partial strings', () => {
    const result = searchRecords(makeInput({ query: 'own' }));

    // "Charlie Brown" contains "own"
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].record.Name).toBe('Charlie Brown');
  });

  it('should include the correct index of matched records', () => {
    const result = searchRecords(makeInput({ query: 'Berlin' }));

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].index).toBe(4);
  });

  it('should list all matched fields for a record', () => {
    const data = [{ Id: '1', First: 'Test User', Last: 'Test Account', Bio: 'No test here' }];
    const result = searchRecords({
      data,
      query: 'test',
      caseSensitive: false,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedFields.sort()).toEqual(['Bio', 'First', 'Last']);
  });

  it('should handle empty data array', () => {
    const result = searchRecords(makeInput({ data: [], query: 'alice' }));

    expect(result.matches).toHaveLength(0);
    expect(result.totalSearched).toBe(0);
  });

  it('should return the correct totalSearched count', () => {
    const result = searchRecords(makeInput({ query: 'nonexistent' }));

    expect(result.totalSearched).toBe(5);
    expect(result.matches).toHaveLength(0);
  });

  it('should provide a durationMs value', () => {
    const result = searchRecords(makeInput({ query: 'alice' }));

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });

  it('should skip null and undefined field values without errors', () => {
    const data = [{ Id: '1', Name: null, Email: undefined, City: 'Paris' }];
    const result = searchRecords({ data, query: 'Paris' });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedFields).toEqual(['City']);
  });

  it('should match numeric field values converted to strings', () => {
    const data = [
      { Id: '1', Name: 'Widget', Price: 42 },
      { Id: '2', Name: 'Gadget', Price: 99 },
    ];
    const result = searchRecords({ data, query: '42' });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].record.Name).toBe('Widget');
    expect(result.matches[0].matchedFields).toContain('Price');
  });
});
