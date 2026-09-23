import { describe, it, expect } from 'vitest';
import { CHANGE_LOOK, CHANGE_ORDER } from './changeLook';

describe('CHANGE_LOOK', () => {
  it('draws what only the source holds as the addition a deployment makes', () => {
    expect(CHANGE_LOOK.removed).toEqual({
      variant: 'success',
      symbol: '+',
      textClass: 'text-status-success',
    });
  });

  it('draws what only the target holds as a removal, which no deployment makes', () => {
    expect(CHANGE_LOOK.added).toEqual({
      variant: 'error',
      symbol: '-',
      textClass: 'text-status-error',
    });
  });

  it('draws what both hold differently as a replacement', () => {
    expect(CHANGE_LOOK.modified).toEqual({
      variant: 'warning',
      symbol: '~',
      textClass: 'text-status-warning',
    });
  });

  it('counts what a deployment creates first, then what it leaves, then what it replaces', () => {
    expect(CHANGE_ORDER).toEqual(['removed', 'added', 'modified']);
  });
});
