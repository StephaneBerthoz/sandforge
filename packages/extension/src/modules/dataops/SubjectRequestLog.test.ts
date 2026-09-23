import { describe, it, expect } from 'vitest';
import type { SubjectRequestEvent } from '@sandforge/shared';

import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { SubjectRequestLog } from './SubjectRequestLog.js';

function store(): ConfigStore {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  return configStore;
}

const searched = (at: string): SubjectRequestEvent => ({
  kind: 'searched',
  at,
  searchedBy: ['email'],
  objects: [{ objectApiName: 'Contact', found: 2, truncated: false }],
});

describe('SubjectRequestLog', () => {
  it('opens a request with its first event, and adds the next ones to it', () => {
    const log = new SubjectRequestLog(store());

    log.record('req-1', 'org-1', searched('2026-09-23T10:00:00.000Z'));
    log.record('req-1', 'org-1', { kind: 'exported', at: '2026-09-23T10:05:00.000Z', records: 2 });

    expect(log.list()).toEqual([
      {
        requestId: 'req-1',
        orgId: 'org-1',
        openedAt: '2026-09-23T10:00:00.000Z',
        events: [
          searched('2026-09-23T10:00:00.000Z'),
          { kind: 'exported', at: '2026-09-23T10:05:00.000Z', records: 2 },
        ],
      },
    ]);
    expect(log.has('req-1', 'org-1')).toBe(true);
    expect(log.has('req-1', 'org-2')).toBe(false);
  });

  it('lists the newest request first, and keeps the log across a restart', () => {
    const configStore = store();
    new SubjectRequestLog(configStore).record(
      'req-1',
      'org-1',
      searched('2026-09-23T10:00:00.000Z'),
    );
    new SubjectRequestLog(configStore).record(
      'req-2',
      'org-1',
      searched('2026-09-23T11:00:00.000Z'),
    );

    expect(new SubjectRequestLog(configStore).list().map((e) => e.requestId)).toEqual([
      'req-2',
      'req-1',
    ]);
  });

  it('drops the oldest request past its bound', () => {
    const log = new SubjectRequestLog(store(), 2);

    for (const id of ['req-1', 'req-2', 'req-3']) {
      log.record(id, 'org-1', searched('2026-09-23T10:00:00.000Z'));
    }

    expect(log.list().map((e) => e.requestId)).toEqual(['req-3', 'req-2']);
  });

  it('leaves out an entry it cannot read rather than show it wrong', () => {
    const configStore = store();
    configStore.set(
      'dataops:subject-requests',
      [
        { requestId: 'req-1', orgId: 'org-1', openedAt: 'x', events: [{ kind: 'searched' }] },
        { requestId: 'req-2', orgId: 'org-1', openedAt: 'y', events: [] },
      ],
      'audit',
    );

    expect(new SubjectRequestLog(configStore).list().map((e) => e.requestId)).toEqual(['req-2']);
  });
});
