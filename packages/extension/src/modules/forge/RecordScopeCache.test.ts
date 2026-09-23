import { describe, it, expect } from 'vitest';
import { RecordScopeCache } from './RecordScopeCache.js';

describe('RecordScopeCache', () => {
  it('starts empty', () => {
    const cache = new RecordScopeCache();
    expect(cache.size).toBe(0);
    expect(cache.objectCount).toBe(0);
    expect(cache.has('Account')).toBe(false);
    expect(cache.get('Account')).toBeUndefined();
  });

  it('stores ids for an object', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001A', '001B']);
    expect(cache.has('Account')).toBe(true);
    expect(cache.get('Account')?.size).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.objectCount).toBe(1);
  });

  it('dedupes ids on repeated add', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001A', '001B']);
    cache.add('Account', ['001B', '001C']);
    expect(cache.get('Account')?.size).toBe(3);
    expect(cache.size).toBe(3);
  });

  it('keeps separate buckets per object', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001A']);
    cache.add('Contact', ['003A', '003B']);
    expect(cache.size).toBe(3);
    expect(cache.objectCount).toBe(2);
    expect(cache.get('Account')?.has('001A')).toBe(true);
    expect(cache.get('Contact')?.has('003B')).toBe(true);
  });

  it('skips empty/falsy ids', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001A', '', '001B']);
    expect(cache.size).toBe(2);
  });

  it('has() returns false for an object that was added with no ids', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', []);
    expect(cache.has('Account')).toBe(false);
    expect(cache.objectCount).toBe(0);
  });

  it('clear empties everything', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001A']);
    cache.add('Contact', ['003A']);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.objectCount).toBe(0);
    expect(cache.has('Account')).toBe(false);
  });

  it('scopes an object still to be read by every id cached for it', () => {
    const cache = new RecordScopeCache();
    cache.add('Contact', ['003A']);
    cache.add('Contact', ['003B']);
    expect([...(cache.scopeOf('Contact') ?? [])]).toEqual(['003A', '003B']);
    expect(cache.scopeOf('Account')).toBeUndefined();
  });

  it('keeps an id met after the object was read, and leaves it out of its scope', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001ROOT']);
    cache.addRead('Account', ['001ROOT', '001READ']);
    // Named by a row read afterwards: nothing will read it now.
    cache.add('Account', ['001PARENT']);
    expect([...(cache.get('Account') ?? [])]).toEqual(['001ROOT', '001READ', '001PARENT']);
    expect([...(cache.scopeOf('Account') ?? [])]).toEqual(['001ROOT', '001READ']);
  });

  it('keeps in scope an id cached before the read, whether the read returned it or not', () => {
    // The standard price book is put in scope before anything is read, and
    // left out of the rows of the price book read.
    const cache = new RecordScopeCache();
    cache.add('Pricebook2', ['01sSTANDARD']);
    cache.addRead('Pricebook2', ['01sCUSTOM']);
    expect([...(cache.scopeOf('Pricebook2') ?? [])]).toEqual(['01sSTANDARD', '01sCUSTOM']);
  });

  it('forgets what was read on clear', () => {
    const cache = new RecordScopeCache();
    cache.addRead('Account', ['001A']);
    cache.clear();
    cache.add('Account', ['001B']);
    expect([...(cache.scopeOf('Account') ?? [])]).toEqual(['001B']);
  });

  it('exposes entries iterator', () => {
    const cache = new RecordScopeCache();
    cache.add('Account', ['001A']);
    cache.add('Contact', ['003A', '003B']);
    const entries = [...cache.entries()].map(([k, v]) => [k, v.size] as const);
    expect(entries).toEqual([
      ['Account', 1],
      ['Contact', 2],
    ]);
  });
});
