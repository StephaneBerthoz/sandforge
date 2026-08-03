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
