import { describe, expect, it, vi } from 'vitest';
import { TargetRecordTypeIdResolver } from './TargetRecordTypeIdResolver.js';

/** A row of the resolver's query, as the org answers it. */
const row = (Id: string, DeveloperName: string, NamespacePrefix: string | null = null) => ({
  Id,
  DeveloperName,
  NamespacePrefix,
});

const ORG_OWN = '012RT0000000001AAA';
const PACKAGED = '012RT0000000002AAA';

describe('TargetRecordTypeIdResolver', () => {
  it('resolves by DeveloperName via SOQL — never by label', async () => {
    const query = vi.fn().mockResolvedValue([row(ORG_OWN, 'Business_Account')]);
    const resolver = new TargetRecordTypeIdResolver({ query });

    await expect(
      resolver.resolveByDeveloperName('00D-target', 'Account', 'Business_Account'),
    ).resolves.toBe(ORG_OWN);
    expect(query).toHaveBeenCalledWith(
      '00D-target',
      'SELECT Id, DeveloperName, NamespacePrefix FROM RecordType WHERE ' +
        "SobjectType = 'Account' AND DeveloperName = 'Business_Account'",
    );
  });

  it('returns null when the RecordType does not exist in the target', async () => {
    const resolver = new TargetRecordTypeIdResolver({ query: vi.fn().mockResolvedValue([]) });
    await expect(
      resolver.resolveByDeveloperName('00D-target', 'Account', 'Missing_RT'),
    ).resolves.toBeNull();
  });

  it('caches per (org, object, developerName)', async () => {
    const query = vi.fn().mockResolvedValue([row(ORG_OWN, 'RT')]);
    const resolver = new TargetRecordTypeIdResolver({ query });

    await resolver.resolveByDeveloperName('00D-target', 'Account', 'RT');
    await resolver.resolveByDeveloperName('00D-target', 'Account', 'RT');
    await resolver.resolveByDeveloperName('00D-target', 'Contact', 'RT');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('marks a record type the running user cannot use', async () => {
    // Found in the RecordType table and active, yet refused at insert as
    // "not valid for the user": only the describe says so.
    const query = vi.fn().mockResolvedValue([row(ORG_OWN, 'Sales')]);
    const describe = vi.fn().mockResolvedValue({
      name: 'Product2',
      fields: [],
      recordTypeInfos: [
        { developerName: 'Sales', recordTypeId: ORG_OWN, available: false },
        { developerName: 'Master', recordTypeId: '012000000000000AAA', available: true },
      ],
    });
    const resolver = new TargetRecordTypeIdResolver({ query, describe });

    await expect(
      resolver.resolveByDeveloperName('00D-target', 'Product2', 'Sales'),
    ).resolves.toEqual({ unavailable: true, id: ORG_OWN });
  });

  it('returns the id of a record type the running user can use', async () => {
    const query = vi.fn().mockResolvedValue([row(PACKAGED, 'Sales')]);
    const describe = vi.fn().mockResolvedValue({
      name: 'Product2',
      fields: [],
      recordTypeInfos: [{ developerName: 'Sales', recordTypeId: PACKAGED, available: true }],
    });
    const resolver = new TargetRecordTypeIdResolver({ query, describe });

    await expect(resolver.resolveByDeveloperName('00D-target', 'Product2', 'Sales')).resolves.toBe(
      PACKAGED,
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
      'SELECT Id, DeveloperName, NamespacePrefix FROM RecordType WHERE ' +
        "SobjectType = 'O\\'Brien' AND DeveloperName = 'RT'",
    );
  });

  describe('a package’s record type beside the org’s own of the same DeveloperName', () => {
    const both = () =>
      vi.fn().mockResolvedValue([row(ORG_OWN, 'Retail'), row(PACKAGED, 'Retail', 'ns')]);

    it('resolves each by its namespace: the package’s to the package’s, the org’s own to its own', async () => {
      const resolver = new TargetRecordTypeIdResolver({ query: both() });

      await expect(
        resolver.resolveByDeveloperName('00D-target', 'Account', 'Retail', 'ns'),
      ).resolves.toBe(PACKAGED);
      await expect(
        resolver.resolveByDeveloperName('00D-target', 'Account', 'Retail', null),
      ).resolves.toBe(ORG_OWN);
    });

    it('reads `ns__Retail` as package ns’s Retail, asking the org for the DeveloperName alone', async () => {
      const query = both();
      const resolver = new TargetRecordTypeIdResolver({ query });

      await expect(
        resolver.resolveByDeveloperName('00D-target', 'Account', 'ns__Retail'),
      ).resolves.toBe(PACKAGED);
      expect(query).toHaveBeenCalledWith(
        '00D-target',
        expect.stringContaining("DeveloperName = 'Retail'"),
      );
    });

    it('takes a bare name for neither, and names both', async () => {
      const resolver = new TargetRecordTypeIdResolver({ query: both() });

      await expect(
        resolver.resolveByDeveloperName('00D-target', 'Account', 'Retail'),
      ).resolves.toEqual({
        ambiguous: true,
        carriers: [
          { namespacePrefix: null, developerName: 'Retail' },
          { namespacePrefix: 'ns', developerName: 'Retail' },
        ],
      });
    });

    it('never resolves a package’s record type to the org’s own of its DeveloperName', async () => {
      const resolver = new TargetRecordTypeIdResolver({
        query: vi.fn().mockResolvedValue([row(ORG_OWN, 'Retail')]),
      });

      await expect(
        resolver.resolveByDeveloperName('00D-target', 'Account', 'Retail', 'ns'),
      ).resolves.toBeNull();
    });

    it('keeps a bare name working where the target holds one record type of it, packaged or not', async () => {
      const resolver = new TargetRecordTypeIdResolver({
        query: vi.fn().mockResolvedValue([row(PACKAGED, 'Retail', 'ns')]),
      });

      await expect(
        resolver.resolveByDeveloperName('00D-target', 'Account', 'Retail'),
      ).resolves.toBe(PACKAGED);
    });
  });
});
