import { describe, it, expect } from 'vitest';
import {
  syncConfigSavePayloadSchema,
  syncExecutePayloadSchema,
  syncObjectPayloadSchema,
  syncScheduleUpsertPayloadSchema,
} from './validatePayload.js';

/**
 * What the bridge accepts is what gets stored: `sync:config:save` hands the
 * parsed config to the config store, a run snapshots it into history, a
 * schedule upsert spreads it into storage. Unknown keys used to ride along
 * untouched, so anything a page put in a payload was persisted and replayed.
 * They are now dropped, while the keys SandForge itself writes — the config id
 * and timestamps, `dryRun: false` — survive.
 */

/** Minimal valid sync config as sent by the webview. */
function validSyncConfig(): Record<string, unknown> {
  return {
    id: 'cfg-1',
    name: 'sync-from-ui',
    description: '',
    sourceOrgId: '00DXXXXXXXXXXXXXXX',
    targetOrgId: '00DYYYYYYYYYYYYYYY',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        batchSize: 200,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

/** Schedule entry as `useSyncScheduleStore` posts it. */
function validSchedule(): Record<string, unknown> {
  return {
    id: 'sched-1',
    name: 'Nightly',
    configId: 'cfg-1',
    cron: '0 2 * * *',
    timezone: 'Europe/Paris',
    enabled: true,
    maxRetries: 1,
    notifyOnComplete: false,
    notifyOnFailure: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
}

describe('unknown keys do not cross the sync boundary', () => {
  it('drops an unknown key from a config saved with sync:config:save', () => {
    const parsed = syncConfigSavePayloadSchema.parse({
      config: { ...validSyncConfig(), evil: '<script>' },
    });

    expect(parsed.config).not.toHaveProperty('evil');
  });

  it('drops an unknown key from a config run with sync:execute', () => {
    const parsed = syncExecutePayloadSchema.parse({
      config: { ...validSyncConfig(), evil: { nested: true } },
    });

    expect(parsed.config).not.toHaveProperty('evil');
  });

  it('drops an unknown key from a sync object', () => {
    const config = validSyncConfig();
    const [object] = config.objects as Array<Record<string, unknown>>;

    const parsed = syncObjectPayloadSchema.parse({ ...object, evil: 1 });

    expect(parsed).not.toHaveProperty('evil');
  });

  it('drops an unknown key from a schedule upsert', () => {
    const parsed = syncScheduleUpsertPayloadSchema.parse({
      schedule: { ...validSchedule(), evil: 'x' },
    });

    expect(parsed.schedule).not.toHaveProperty('evil');
  });

  it('keeps the id, timestamps and dryRun: false SandForge writes on every config', () => {
    const parsed = syncConfigSavePayloadSchema.parse({
      config: { ...validSyncConfig(), dryRun: false },
    });

    expect(parsed.config).toMatchObject({
      id: 'cfg-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      dryRun: false,
    });
  });
});

/**
 * The files option is stored with the configuration a schedule and a pipeline
 * run: dropped at the boundary, a saved configuration would run without the
 * files it was saved to copy.
 */
describe('the files a configuration copies', () => {
  it('keeps the choice and its two caps', () => {
    const files = { maxFileSizeMB: 10, maxRunMB: 100 };

    const parsed = syncConfigSavePayloadSchema.parse({ config: { ...validSyncConfig(), files } });

    expect(parsed.config.files).toEqual(files);
  });

  it.each([
    [{ maxFileSizeMB: 36, maxRunMB: 100 }, 'files.maxFileSizeMB'],
    [{ maxFileSizeMB: 0, maxRunMB: 100 }, 'files.maxFileSizeMB'],
    [{ maxFileSizeMB: 10, maxRunMB: 2001 }, 'files.maxRunMB'],
    [{ maxFileSizeMB: 10, maxRunMB: 1.5 }, 'files.maxRunMB'],
  ])('refuses caps out of bounds: %j', (files, path) => {
    const parsed = syncExecutePayloadSchema.safeParse({ config: { ...validSyncConfig(), files } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.slice(1).join('.'))).toContain(path);
  });
});
