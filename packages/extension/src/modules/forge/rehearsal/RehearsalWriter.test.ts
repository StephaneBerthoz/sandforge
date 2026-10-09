import { describe, it, expect, vi } from 'vitest';
import type { ForgeExecutorDeps } from '../ForgeExecutor.js';
import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import { RehearsalWriter, placeholderId, rehearsalExecutorDeps } from './RehearsalWriter.js';

const prefixes: Record<string, string> = { Account: '001', Contact: '003' };
const writer = (): RehearsalWriter =>
  new RehearsalWriter(async (objectApiName) => prefixes[objectApiName] ?? null);

describe('the placeholder ids a rehearsal hands the executor', () => {
  it('is shaped as an 18-character id of the object, with a valid checksum', () => {
    const id = placeholderId('001', 0);
    expect(id).toHaveLength(18);
    expect(id.startsWith('001')).toBe(true);
    expect(canonicalRecordId(id)).toBe(id);
  });

  it('never repeats, whatever the number', () => {
    const ids = new Set(Array.from({ length: 5_000 }, (_, seq) => placeholderId('003', seq)));
    expect(ids.size).toBe(5_000);
  });

  it('carries a mark no real id holds where a real id always holds 0', () => {
    expect(placeholderId('001', 61).slice(3, 6)).toBe('RHZ');
  });

  it('takes a prefix of zeros when the target gives the object none', () => {
    expect(placeholderId(null, 1).startsWith('000RHZ')).toBe(true);
    expect(placeholderId('bad prefix', 1).startsWith('000RHZ')).toBe(true);
  });
});

describe('the writer a rehearsal hands the executor', () => {
  it('keeps each row in the order the run would create it, and answers it as created', async () => {
    const w = writer();
    const accounts = await w.insertRecords('target', 'Account', [{ Name: 'A' }, { Name: 'B' }]);
    const contacts = await w.insertRecords('target', 'Contact', [
      { LastName: 'C', AccountId: accounts[1].id },
    ]);
    expect(accounts.every((r) => r.success && r.errors.length === 0)).toBe(true);
    expect(w.rows.map((r) => [r.seq, r.objectApiName])).toEqual([
      [0, 'Account'],
      [1, 'Account'],
      [2, 'Contact'],
    ]);
    expect(w.rows[2].fields).toEqual({ LastName: 'C', AccountId: accounts[1].id });
    expect(contacts[0].id.startsWith('003')).toBe(true);
  });

  it('keeps a copy of each row, which the executor changing its own afterwards leaves alone', async () => {
    const w = writer();
    const record: Record<string, unknown> = { Name: 'A' };
    await w.insertRecords('target', 'Account', [record]);
    record['Name'] = 'changed';
    expect(w.rows[0].fields['Name']).toBe('A');
  });

  it('tells the row a placeholder stands for, by its 15 or 18 characters, and nothing else', async () => {
    const w = writer();
    const [{ id }] = await w.insertRecords('target', 'Account', [{ Name: 'A' }]);
    expect(w.rowOf(id)?.seq).toBe(0);
    expect(w.rowOf(id.slice(0, 15))?.seq).toBe(0);
    expect(w.rowOf('001000000000001AAA')).toBeUndefined();
    expect(w.rowOf(42)).toBeUndefined();
  });

  it('asks the key prefix of an object once', async () => {
    const keyPrefixOf = vi.fn(async () => '001');
    const w = new RehearsalWriter(keyPrefixOf);
    await w.insertRecords('target', 'Account', [{ Name: 'A' }]);
    await w.insertRecords('target', 'Account', [{ Name: 'B' }]);
    expect(keyPrefixOf).toHaveBeenCalledTimes(1);
  });

  it('keeps the updates the run makes after its inserts, each of one record, and sends none', async () => {
    const w = writer();
    const results = await w.updateRecords('target', 'Account', [{ Id: 'x', ParentId: 'y' }, {}]);
    expect(w.updates).toBe(2);
    expect(w.updated).toEqual([
      { seq: 0, objectApiName: 'Account', recordId: 'x', fields: { ParentId: 'y' } },
      { seq: 1, objectApiName: 'Account', recordId: '', fields: {} },
    ]);
    expect(results).toEqual([
      { id: 'x', success: true, errors: [] },
      { id: '', success: true, errors: [] },
    ]);
  });

  it('answers with no row a query that names a placeholder, and sends every other', async () => {
    const w = writer();
    const [{ id }] = await w.insertRecords('target', 'Account', [{ Name: 'A' }]);
    const query = vi.fn(async () => [{ Id: 'real' }]);
    const guarded = w.guardQueries(query);
    expect(await guarded('target', `SELECT Id FROM Account WHERE Id IN ('${id}')`)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(
      await guarded('target', `SELECT Id FROM Account WHERE Id IN ('001RHZ000000099AAA')`),
    ).toEqual([{ Id: 'real' }]);
    expect(await guarded('source', 'SELECT Id FROM Account')).toEqual([{ Id: 'real' }]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("the executor's deps for a rehearsal", () => {
  const reads = (): ForgeExecutorDeps => ({
    queryRecords: vi.fn(async () => []),
    insertRecords: vi.fn(async () => []),
    updateRecords: vi.fn(async () => []),
    upsertRecords: vi.fn(async () => []),
    describeFields: vi.fn(async () => []),
    insertFile: vi.fn(async () => ({ id: 'f', success: true, errors: [] })),
    readFileBody: vi.fn(async () => ''),
    remainingFileStorageMB: vi.fn(async () => 100),
    requestsSent: () => 7,
  });

  it('write through the rehearsal writer, never through the run’s writers', async () => {
    const run = reads();
    const w = writer();
    const deps = rehearsalExecutorDeps(run, w);
    await deps.insertRecords('target', 'Account', [{ Name: 'A' }]);
    await deps.updateRecords?.('target', 'Account', [{ Id: 'x' }]);
    expect(run.insertRecords).not.toHaveBeenCalled();
    expect(run.updateRecords).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(1);
    expect(w.updates).toBe(1);
  });

  it('leave out the upsert and every way of copying a file', () => {
    const deps = rehearsalExecutorDeps(reads(), writer());
    expect(deps.upsertRecords).toBeUndefined();
    expect(deps.insertFile).toBeUndefined();
    expect(deps.readFileBody).toBeUndefined();
    expect(deps.remainingFileStorageMB).toBeUndefined();
  });

  it('read as the run reads', async () => {
    const run = reads();
    const deps = rehearsalExecutorDeps(run, writer());
    await deps.describeFields('target', 'Account');
    await deps.queryRecords('source', 'SELECT Id FROM Account');
    expect(run.describeFields).toHaveBeenCalledWith('target', 'Account');
    expect(run.queryRecords).toHaveBeenCalledWith('source', 'SELECT Id FROM Account', undefined);
    expect(deps.requestsSent?.()).toBe(7);
  });
});
