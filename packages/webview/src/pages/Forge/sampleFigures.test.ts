import { describe, it, expect } from 'vitest';
import '../../i18n';
import { mbOf, percentOf, sampleNumber } from './sampleFigures';

describe('the figures of a sample', () => {
  it('says bytes in MB to a tenth', () => {
    expect(mbOf(3_355_443)).toBe('3.2');
    expect(mbOf(432_013_312)).toBe('412');
    expect(mbOf(0)).toBe('0');
  });

  // A sample of a large org keeps a fraction of a per cent of its roots:
  // rounded to a whole, it read as none.
  it('says a share as a percentage the eye reads, never a fraction of one as none', () => {
    expect(percentOf(0.0041)).toBe('0.41');
    expect(percentOf(0.000012)).toBe('0.0012');
    expect(percentOf(0.034)).toBe('3.4');
    expect(percentOf(0.256)).toBe('26');
    expect(percentOf(1)).toBe('100');
    expect(percentOf(0)).toBe('0');
  });

  it('says a number in the interface language', () => {
    expect(sampleNumber(1200)).toBe('1,200');
  });
});
