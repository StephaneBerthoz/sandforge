import { describe, expect, it, vi } from 'vitest';
import { TargetRecordTypeIdResolver } from './TargetRecordTypeIdResolver.js';

describe('TargetRecordTypeIdResolver', () => {
  it('resolves by DeveloperName via SOQL — never by label', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: '012RT0000000001AAA' }]);
    const resolver = new TargetRecordTypeIdResolver({ query });

    await expect(
      resolver.resolveByDeveloperName('00D-target', 'Account', 'Business_Account'),
    ).resolves.toBe('012RT0000000001AAA');
    expect(query).toHaveBeenCalledWith(
      '00D-target',
      "SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND DeveloperName = 'Business_Account' LIMIT 1",
    );
  });

  it('returns null when the RecordType does not exist in the target', async () => {
    const resolver = new TargetRecordTypeIdResolver({ query: vi.fn().mockResolvedValue([]) });
    await expect(
      resolver.resolveByDeveloperName('00D-target', 'Account', 'Missing_RT'),
    ).resolves.toBeNull();
  });

  it('caches per (org, object, developerName)', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: '012RT1' }]);
    const resolver = new TargetRecordTypeIdResolver({ query });

    await resolver.resolveByDeveloperName('00D-target', 'Account', 'RT');
    await resolver.resolveByDeveloperName('00D-target', 'Account', 'RT');
    await resolver.resolveByDeveloperName('00D-target', 'Contact', 'RT');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('marks a record type the running user cannot use', async () => {
    // Found in the RecordType table and active, yet refused at insert as
    // "not valid for the user": only the describe says so.
    const query = vi.fn().mockResolvedValue([{ Id: '012RT0000000001AAA' }]);
    const describe = vi.fn().mockResolvedValue({
      name: 'Product2',
      fields: [],
      recordTypeInfos: [
        { developerName: 'Sales', recordTypeId: '012RT0000000001AAA', available: false },
        { developerName: 'Master', recordTypeId: '012000000000000AAA', available: true },
      ],
    });
    const resolver = new TargetRecordTypeIdResolver({ query, describe });

    await expect(
      resolver.resolveByDeveloperName('00D-target', 'Product2', 'Sales'),
    ).resolves.toEqual({ unavailable: true, id: '012RT0000000001AAA' });
  });

  it('returns the id of a record type the running user can use', async () => {
    const query = vi.fn().mockResolvedValue([{ Id: '012RT0000000002AAA' }]);
    const describe = vi.fn().mockResolvedValue({
      name: 'Product2',
      fields: [],
      recordTypeInfos: [
        { developerName: 'Sales', recordTypeId: '012RT0000000002AAA', available: true },
      ],
    });
    const resolver = new TargetRecordTypeIdResolver({ query, describe });

    await expect(resolver.resolveByDeveloperName('00D-target', 'Product2', 'Sales')).resolves.toBe(
      '012RT0000000002AAA',
    );
    await resolver.resolveByDeveloperName('00D-target', 'Product2', 'Other');
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('escapes single quotes in SOQL literals', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const resolver = new TargetRecordTypeIdResolver({ query });
    await resolver.resolveByDeveloperName('00D-target', "O'Brien", 'RT');
    expect(query).toHaveBeenCalledWith(
      '00D-target',
      "SELECT Id FROM RecordType WHERE SobjectType = 'O\\'Brien' AND DeveloperName = 'RT' LIMIT 1",
    );
  });
});
