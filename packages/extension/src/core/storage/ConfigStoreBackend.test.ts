import { describe, it, expect } from 'vitest';
import { InMemoryConfigStoreBackend } from './ConfigStoreBackend';
import type { ConfigEntry } from './ConfigStoreBackend';

describe('InMemoryConfigStoreBackend', () => {
  it('should return empty data initially', () => {
    const backend = new InMemoryConfigStoreBackend();

    expect(backend.getData()).toEqual({});
  });

  it('should persist and retrieve data', () => {
    const backend = new InMemoryConfigStoreBackend();
    const data: Record<string, ConfigEntry> = {
      theme: { value: '"dark"', category: 'settings' },
      lang: { value: '"fr"', category: 'settings' },
    };

    backend.setData(data);

    expect(backend.getData()).toEqual(data);
  });

  it('should return a copy of data (not a reference)', () => {
    const backend = new InMemoryConfigStoreBackend();
    const data: Record<string, ConfigEntry> = {
      key: { value: '"val"', category: 'general' },
    };

    backend.setData(data);
    const retrieved = backend.getData();
    retrieved['extra'] = { value: '"new"', category: 'general' };

    expect(backend.getData()).not.toHaveProperty('extra');
  });

  it('should overwrite previous data on setData', () => {
    const backend = new InMemoryConfigStoreBackend();

    backend.setData({ a: { value: '"1"', category: 'c1' } });
    backend.setData({ b: { value: '"2"', category: 'c2' } });

    const data = backend.getData();
    expect(data).not.toHaveProperty('a');
    expect(data['b']).toEqual({ value: '"2"', category: 'c2' });
  });
});
