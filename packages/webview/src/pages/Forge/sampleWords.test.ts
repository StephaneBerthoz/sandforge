import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import { drawWords, mbOf, percentOf, wholeReasonWords } from './sampleWords';

const t = i18n.t.bind(i18n);

describe('the words of a sample', () => {
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

  it('says why an object goes whole, and how the roots were drawn', () => {
    expect(wholeReasonWords(t, 'catalog')).toBe('the price catalog, small enough to go whole');
    expect(wholeReasonWords(t, 'asked')).toBe('asked');
    expect(drawWords(t, 'uniform')).toBe('spread over the org');
    expect(drawWords(t, 'recent')).toBe('the newest first');
  });
});
