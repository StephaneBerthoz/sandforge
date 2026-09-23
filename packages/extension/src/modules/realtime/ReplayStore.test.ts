import { describe, it, expect } from 'vitest';
import { ReplayStore } from './ReplayStore';

function memoryConfigStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: <T>(key: string): T | undefined => {
      const raw = data.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    set: <T>(key: string, value: T): void => {
      data.set(key, JSON.stringify(value));
    },
    delete: (key: string): boolean => data.delete(key),
  };
}

describe('ReplayStore', () => {
  it('remembers how far each channel of an org was read, across instances', () => {
    const configStore = memoryConfigStore();
    new ReplayStore(configStore, 'org-a').save(new Map([['/data/LeadChangeEvent', 30_071_891]]));

    const next = new ReplayStore(configStore, 'org-a');
    expect(next.get('/data/LeadChangeEvent')).toBe(30_071_891);
    expect(next.get('/data/ContactChangeEvent')).toBeUndefined();
  });

  it('moves one channel on without losing the others', () => {
    const configStore = memoryConfigStore();
    const store = new ReplayStore(configStore, 'org-a');
    store.save(
      new Map([
        ['/data/LeadChangeEvent', 10],
        ['/data/ContactChangeEvent', 20],
      ]),
    );
    store.save(new Map([['/data/LeadChangeEvent', 11]]));

    expect(store.get('/data/LeadChangeEvent')).toBe(11);
    expect(store.get('/data/ContactChangeEvent')).toBe(20);
  });

  it('keeps each org to itself, and forgets one on request', () => {
    const configStore = memoryConfigStore();
    new ReplayStore(configStore, 'org-a').save(new Map([['/data/LeadChangeEvent', 1]]));
    new ReplayStore(configStore, 'org-b').save(new Map([['/data/LeadChangeEvent', 2]]));

    new ReplayStore(configStore, 'org-a').forget();

    expect(new ReplayStore(configStore, 'org-a').get('/data/LeadChangeEvent')).toBeUndefined();
    expect(new ReplayStore(configStore, 'org-b').get('/data/LeadChangeEvent')).toBe(2);
  });

  it('ignores a stored position that is not a number', () => {
    const configStore = memoryConfigStore();
    configStore.set('realtime:replay:org-a', { '/data/LeadChangeEvent': 'soon' });

    expect(new ReplayStore(configStore, 'org-a').get('/data/LeadChangeEvent')).toBeUndefined();
  });
});
