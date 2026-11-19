import { describe, expect, it } from 'vitest';
import { storageCountedWords } from './storageCounted';

const t = (key: string, options?: Record<string, unknown>): string =>
  `${key}${options ? ` ${JSON.stringify(options)}` : ''}`;
const mb = (value: number): string => String(value);

describe('what a storage gate counted off what the target says it has left', () => {
  it('says what runs from this machine wrote that Salesforce has not counted yet', () => {
    expect(storageCountedWords({ uncountedWrites: { mb: 2.1, runs: 1, minutes: 2 } }, t, mb)).toBe(
      ' common.refusal.storageUncounted {"mb":"2.1","window":10}',
    );
  });

  it('says the rounding of what the target says when it alone refused, after the writes', () => {
    expect(
      storageCountedWords(
        { uncountedWrites: { mb: 1.2, runs: 2, minutes: 4 }, roundingMB: 0.5 },
        t,
        mb,
      ),
    ).toBe(
      ' common.refusal.storageUncounted {"mb":"1.2","window":10}' +
        ' common.refusal.storageRounding {"mb":"0.5"}',
    );
  });

  it('says what a fit kept for those writes, its budget carrying the MB alone', () => {
    expect(storageCountedWords({ uncountedMB: 2 }, t, mb)).toBe(
      ' common.refusal.storageUncounted {"mb":"2","window":10}',
    );
    expect(storageCountedWords({ uncountedMB: undefined }, t, mb)).toBe('');
  });

  it('says nothing when the gate took nothing off, or the figures are not the host’s', () => {
    expect(storageCountedWords({ estimateMB: 3, remainingMB: 5 }, t, mb)).toBe('');
    expect(storageCountedWords(undefined, t, mb)).toBe('');
    expect(storageCountedWords({ uncountedWrites: { mb: '2' }, roundingMB: -1 }, t, mb)).toBe('');
  });
});
