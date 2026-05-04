import { describe, it, expect, vi } from 'vitest';
import { ReferenceDataMapper } from './ReferenceDataMapper.js';

describe('ReferenceDataMapper', () => {
  it('returns empty result when there are no source records', async () => {
    const query = vi.fn();
    const mapper = new ReferenceDataMapper(query);
    const result = await mapper.resolve('BusinessHours', [], 'tgt');
    expect(result.mappings).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves source IDs to target IDs by Name (default match field)', async () => {
    const query = vi.fn().mockResolvedValue([
      { Id: '01mTGT001', Name: 'Default' },
      { Id: '01mTGT002', Name: '24/7 Support' },
    ]);
    const mapper = new ReferenceDataMapper(query);
    const result = await mapper.resolve(
      'BusinessHours',
      [
        { Id: '01mSRC001', Name: 'Default' },
        { Id: '01mSRC002', Name: '24/7 Support' },
      ],
      'tgt-org',
    );

    expect(query).toHaveBeenCalledWith(
      'tgt-org',
      `SELECT Id, Name FROM BusinessHours WHERE Name IN ('Default', '24/7 Support')`,
    );
    expect(result.mappings).toEqual([
      { sourceId: '01mSRC001', targetId: '01mTGT001', matchedBy: 'Name', matchValue: 'Default' },
      {
        sourceId: '01mSRC002',
        targetId: '01mTGT002',
        matchedBy: 'Name',
        matchValue: '24/7 Support',
      },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it('reports source records that have no matching target row as unmatched', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: '01mTGT001', Name: 'Default' }]);
    const mapper = new ReferenceDataMapper(query);
    const result = await mapper.resolve(
      'BusinessHours',
      [
        { Id: '01mSRC001', Name: 'Default' },
        { Id: '01mSRC002', Name: 'Custom' },
      ],
      'tgt',
    );

    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0].sourceId).toBe('01mSRC001');
    expect(result.unmatched).toEqual([{ sourceId: '01mSRC002', matchValue: 'Custom' }]);
  });

  it('honours an explicit matchField override', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: '012TGT', DeveloperName: 'CaseStandard' }]);
    const mapper = new ReferenceDataMapper(query);
    const result = await mapper.resolve(
      'CustomRefData__c',
      [{ Id: 'a01SRC', DeveloperName: 'CaseStandard' }],
      'tgt',
      'DeveloperName',
    );

    expect(query.mock.calls[0][1]).toContain('SELECT Id, DeveloperName');
    expect(query.mock.calls[0][1]).toContain('WHERE DeveloperName IN');
    expect(result.mappings[0].matchedBy).toBe('DeveloperName');
  });

  it('escapes single quotes in match values to prevent SOQL injection', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const mapper = new ReferenceDataMapper(query);
    await mapper.resolve('BusinessHours', [{ Id: '01mSRC', Name: "Bob's Workshop" }], 'tgt');

    expect(query.mock.calls[0][1]).toBe(
      `SELECT Id, Name FROM BusinessHours WHERE Name IN ('Bob\\'s Workshop')`,
    );
  });

  it('rejects invalid SOQL identifiers (defence-in-depth)', async () => {
    const mapper = new ReferenceDataMapper(vi.fn());
    await expect(mapper.resolve('Bad; Object', [{ Id: '01m', Name: 'X' }], 'tgt')).rejects.toThrow(
      /Invalid Salesforce API name/,
    );
  });

  it('skips source records missing the match value (no Id, no Name)', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const mapper = new ReferenceDataMapper(query);
    const result = await mapper.resolve(
      'BusinessHours',
      [
        { Id: '01mSRC', Name: '' },
        { Id: '01mOK', Name: 'OK' },
      ],
      'tgt',
    );

    // Only 'OK' is included in the IN clause
    expect(query.mock.calls[0][1]).toBe(`SELECT Id, Name FROM BusinessHours WHERE Name IN ('OK')`);
    // 'OK' was not found on target → unmatched
    expect(result.mappings).toEqual([]);
    expect(result.unmatched).toEqual([{ sourceId: '01mOK', matchValue: 'OK' }]);
  });

  it('dedupes identical match values in the IN clause', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: '01mTGT', Name: 'Default' }]);
    const mapper = new ReferenceDataMapper(query);
    await mapper.resolve(
      'BusinessHours',
      [
        { Id: '01mSRC1', Name: 'Default' },
        { Id: '01mSRC2', Name: 'Default' },
      ],
      'tgt',
    );

    expect(query.mock.calls[0][1]).toBe(
      `SELECT Id, Name FROM BusinessHours WHERE Name IN ('Default')`,
    );
  });
});
