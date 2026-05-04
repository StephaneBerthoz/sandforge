import { describe, it, expect } from 'vitest';
import { RingBuffer } from './RingBuffer';

describe('RingBuffer', () => {
  it('push under capacity returns no eviction and preserves order', () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.push(1)).toBeUndefined();
    expect(buf.push(2)).toBeUndefined();
    expect(buf.push(3)).toBeUndefined();
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.length).toBe(3);
  });

  it('push at capacity is full but does not yet evict', () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) {
      expect(buf.push(i)).toBeUndefined();
    }
    expect(buf.toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(buf.length).toBe(5);
  });

  it('push past capacity evicts the oldest and keeps the last N in order', () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) buf.push(i);
    expect(buf.push(6)).toBe(1);
    expect(buf.push(7)).toBe(2);
    expect(buf.toArray()).toEqual([3, 4, 5, 6, 7]);
    expect(buf.length).toBe(5);
  });

  it('chronological wraparound stays correct after partial wrap', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  it('range filter returns matching items in chronological order', () => {
    const buf = new RingBuffer<number>(100);
    for (let i = 0; i < 100; i++) buf.push(i);
    const evens = buf.range((n) => n % 2 === 0);
    expect(evens).toHaveLength(50);
    expect(evens[0]).toBe(0);
    expect(evens.at(-1)).toBe(98);
  });

  it('clear resets length and allows reuse', () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) buf.push(i);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    buf.push(42);
    expect(buf.length).toBe(1);
    expect(buf.toArray()).toEqual([42]);
  });

  it('rejects invalid capacities', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(NaN)).toThrow();
    expect(() => new RingBuffer(Infinity)).toThrow();
  });
});
