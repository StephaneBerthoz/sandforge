import { describe, it, expect, vi } from 'vitest';
import type { Memento } from 'vscode';
import { MementoConfigStoreBackend } from './MementoConfigStoreBackend';
import type { ConfigEntry } from './ConfigStoreBackend';

function createMockMemento(): Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: vi.fn(<T>(key: string, defaultValue?: T): T => {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue as T;
    }),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
}

describe('MementoConfigStoreBackend', () => {
  it('should return empty data when globalState is empty', () => {
    const memento = createMockMemento();
    const backend = new MementoConfigStoreBackend(memento);

    expect(backend.getData()).toEqual({});
  });

  it('should persist and retrieve data via Memento', () => {
    const memento = createMockMemento();
    const backend = new MementoConfigStoreBackend(memento);
    const data: Record<string, ConfigEntry> = {
      theme: { value: '"dark"', category: 'settings' },
    };

    backend.setData(data);

    expect(backend.getData()).toEqual(data);
    expect(memento.update).toHaveBeenCalledWith('sandforge.configStore', data);
  });

  it('should load pre-existing data from Memento', () => {
    const memento = createMockMemento();
    const existingData: Record<string, ConfigEntry> = {
      lang: { value: '"en"', category: 'settings' },
    };
    (memento.update as ReturnType<typeof vi.fn>)('sandforge.configStore', existingData);

    const backend = new MementoConfigStoreBackend(memento);

    expect(backend.getData()).toEqual(existingData);
  });
});
