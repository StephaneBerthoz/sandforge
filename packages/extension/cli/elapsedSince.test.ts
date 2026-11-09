import { afterEach, describe, expect, it, vi } from 'vitest';
import { elapsedSince } from './elapsedSince.js';

describe('elapsedSince', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the milliseconds since the start, on the clock now unless told the end', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:15:05.000Z'));
    const startedAt = Date.now();
    vi.setSystemTime(new Date('2026-11-09T10:15:07.500Z'));

    expect(elapsedSince(startedAt)).toBe(2_500);
    expect(elapsedSince(startedAt, startedAt + 40)).toBe(40);
  });

  it('gives none, never less, once the machine set its clock back past the start', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:15:05.000Z'));
    const startedAt = Date.now();
    vi.setSystemTime(startedAt - 1_250);

    expect(elapsedSince(startedAt)).toBe(0);
    expect(elapsedSince(startedAt, startedAt - 1)).toBe(0);
  });
});
