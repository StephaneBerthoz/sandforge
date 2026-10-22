import { describe, expect, it } from 'vitest';
import { BACKUP_MAX_AGE_DAYS_DEFAULT, backupMaxAgeDays, putBackKept } from './backupRetention';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

describe('backupMaxAgeDays', () => {
  it('reads the setting, its default when unset, and 0 when it keeps every backup', () => {
    const setting = (value: unknown) => ({
      getSandforgeSetting: <T>(key: string, fallback: T): T =>
        (key === 'backup.maxAgeDays' ? value : fallback) as T,
    });
    expect(backupMaxAgeDays({ getSandforgeSetting: <T>(_k: string, f: T): T => f })).toBe(
      BACKUP_MAX_AGE_DAYS_DEFAULT,
    );
    expect(backupMaxAgeDays(setting(7))).toBe(7);
    expect(backupMaxAgeDays(setting(0))).toBe(0);
    expect(backupMaxAgeDays(setting('thirty'))).toBe(0);
    expect(backupMaxAgeDays(undefined)).toBe(0);
  });
});

describe('putBackKept', () => {
  const plan = [
    {
      objectApiName: 'Account',
      backup: 'sync-before-a',
      ids: [fakeId('001', 1), fakeId('001', 2)],
    },
    { objectApiName: 'Contact', backup: 'sync-before-b', ids: [fakeId('003', 1)] },
  ];

  it('leaves out what a backup no longer kept would have put back, and counts it', () => {
    const read = putBackKept(
      plan,
      (id) => (id === 'sync-before-b' ? { timestamp: '2026-10-01T00:00:00.000Z' } : undefined),
      30,
    );

    expect(read.kept.map((object) => object.objectApiName)).toEqual(['Contact']);
    expect(read.notKept).toBe(2);
    expect(read.keptUntil).toBe('2026-10-31T00:00:00.000Z');
  });

  it('dates no end when the retention keeps every backup', () => {
    const read = putBackKept(plan, () => ({ timestamp: '2026-10-01T00:00:00.000Z' }), 0);

    expect(read.kept).toHaveLength(2);
    expect(read.notKept).toBe(0);
    expect(read.keptUntil).toBeUndefined();
  });
});
