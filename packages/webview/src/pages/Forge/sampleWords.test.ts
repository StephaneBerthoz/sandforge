import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import { drawWords, wholeReasonWords } from './sampleWords';

const t = i18n.t.bind(i18n);

describe('the words of a sample', () => {
  it('says why an object goes whole, and how the roots were drawn', () => {
    expect(wholeReasonWords(t, 'catalog')).toBe('the price catalog, small enough to go whole');
    expect(wholeReasonWords(t, 'asked')).toBe('asked');
    expect(drawWords(t, 'uniform')).toBe('spread over the org');
    expect(drawWords(t, 'recent')).toBe('the newest first');
  });
});
