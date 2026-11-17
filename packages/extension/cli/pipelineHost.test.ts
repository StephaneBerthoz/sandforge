import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineFileOrg, SalesforceOrg, SandforgePipelineFile } from '@sandforge/shared';
import {
  createPipelineHost,
  hostedPipeline,
  liveKindOf,
  markStaging,
  matchOrg,
  saveCarried,
  shareSnapshots,
  snapshotKeys,
} from './pipelineHost.js';
import { fileConfigStore } from './fileConfigStore.js';
import { ConfigStore } from '../src/core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../src/test/InMemoryConfigStoreBackend.js';

/*
 * The host a pipeline file runs in, and what the file is put into it as: its
 * orgs matched to the ones the aliases reach, the Staging mark on a sandbox
 * alone, the editor's ids rewritten, what it carries saved in the store.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-host-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SANDBOX: PipelineFileOrg = {
  alias: 'UAT',
  organizationId: '00D000000000009AAA',
  kind: 'sandbox',
  staging: true,
};

function store(): ConfigStore {
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  return configStore;
}

/** An org as the host registers it. */
function registered(orgType: string, edition = 'Developer Edition'): SalesforceOrg {
  return {
    id: '00D000000000009AAA',
    orgId: '00D000000000009AAA',
    alias: 'UAT',
    orgType,
    metadata: { apiVersion: '62.0', edition, features: [] },
  } as unknown as SalesforceOrg;
}

describe('matchOrg', () => {
  it('takes the org the file names, its 15-character Id and its 18 alike', () => {
    expect(
      matchOrg('k', 'UAT', SANDBOX, { organizationId: '00D000000000009', kind: 'sandbox' }),
    ).toEqual({ ok: true });
  });

  it('refuses a sandbox that answers as another org, and names --accept-org with its alias and the Id it answers with', () => {
    const moved = matchOrg('reg-uat', 'UAT', SANDBOX, {
      organizationId: '00D000000000007AAA',
      kind: 'sandbox',
    });

    expect(moved).toEqual({
      ok: false,
      code: 'ORG_MOVED',
      message:
        'UAT answers as org 00D000000000007AAA, and the file names 00D000000000009AAA: a ' +
        'sandbox refreshed since is another org, holding production’s data again. Nothing was run.',
      wayOut:
        'check that UAT is the org the pipeline is for, then run again with --accept-org ' +
        'UAT=00D000000000007AAA; or export the pipeline again from the Automation page.',
    });
    expect(
      matchOrg(
        'reg-uat',
        'UAT',
        SANDBOX,
        { organizationId: '00D000000000007AAA', kind: 'sandbox' },
        '00D000000000007AAA',
      ),
    ).toMatchObject({ ok: true, note: expect.stringContaining('as --accept-org reg-uat=') });
    expect(
      matchOrg(
        'reg-uat',
        'UAT',
        SANDBOX,
        { organizationId: '00D000000000007AAA', kind: 'sandbox' },
        '00D000000000007AAA',
        'UAT',
      ),
    ).toMatchObject({
      ok: true,
      note: expect.stringContaining('taken, as --accept-org UAT=00D000000000007AAA says.'),
    });
  });

  it('says the kind changed too when the file names a sandbox and the alias reaches a Developer Edition org, and names the org once in its way out', () => {
    // The key the editor registers an org under is its Organization Id: the
    // way out read "--accept-org <Id>=<Id>".
    const moved = matchOrg('00D000000000009AAA', 'DEVED', SANDBOX, {
      organizationId: '00D000000000007AAA',
      kind: 'developer',
    });

    expect(moved).toMatchObject({
      ok: false,
      code: 'ORG_MOVED',
      message:
        'DEVED answers as org 00D000000000007AAA, and the file names 00D000000000009AAA: another ' +
        'org, of another kind: a Developer Edition org here, a sandbox in the file. Nothing was run.',
    });
    expect(moved.ok === false && moved.message).not.toContain('refreshed');
    expect(moved.ok === false && moved.wayOut).toContain('--accept-org DEVED=00D000000000007AAA;');
    expect(moved.ok === false && moved.wayOut).not.toContain('00D000000000009AAA');
  });

  it('does not pin a scratch org or a Developer Edition org, unless the alias now reaches another kind', () => {
    const scratch: PipelineFileOrg = { ...SANDBOX, kind: 'scratch', staging: false };

    expect(
      matchOrg('k', 'UAT', scratch, { organizationId: '00D000000000007AAA', kind: 'scratch' }),
    ).toMatchObject({ ok: true, note: expect.stringContaining('is not pinned to its Id') });
    expect(
      matchOrg('k', 'UAT', scratch, { organizationId: '00D000000000007AAA', kind: 'production' }),
    ).toMatchObject({ ok: false, code: 'ORG_MOVED' });
  });
});

describe('liveKindOf', () => {
  it('reads the kind of org from its registered type and edition', () => {
    expect(liveKindOf(registered('Sandbox'))).toBe('sandbox');
    expect(liveKindOf(registered('Scratch'))).toBe('scratch');
    expect(liveKindOf(registered('Developer'))).toBe('developer');
    expect(liveKindOf(registered('Production', 'Enterprise Edition'))).toBe('production');
  });
});

describe('markStaging', () => {
  it('sets the file’s Staging mark on a sandbox, and says it is not read of another kind', () => {
    const saved: SalesforceOrg[] = [];
    const registry = { updateOrgMetadata: (org: SalesforceOrg) => saved.push(org) };

    expect(markStaging(registry, registered('Sandbox'), SANDBOX, 'UAT').org.staging).toBe(true);
    expect(saved).toHaveLength(1);

    const scratch = markStaging(registry, registered('Scratch'), SANDBOX, 'UAT');
    expect(scratch.org.staging).toBeUndefined();
    expect(scratch.note).toContain('the mark is read of a sandbox alone, and not set');
    expect(saved).toHaveLength(1);
  });
});

/** A file with a Seed step and a Sync step, each naming orgs by the editor's keys. */
function fileOf(): Pick<SandforgePipelineFile, 'pipeline' | 'syncConfigs' | 'exportedAt'> {
  return {
    exportedAt: '2026-11-20T10:00:00.000Z',
    pipeline: {
      id: 'pipe-1',
      name: 'Nightly',
      description: '',
      steps: [
        { id: 's1', name: 'Fill', type: 'seed', config: { orgId: 'reg-uat', templateId: 't' } },
        { id: 's2', name: 'Push', type: 'sync', config: { configId: 'cfg' } },
      ],
      variables: [{ name: 'token', type: 'secret', required: true, description: '' }],
      tags: [],
    },
    syncConfigs: { cfg: { id: 'cfg', sourceOrgId: 'reg-src', targetOrgId: 'reg-uat' } },
  };
}

describe('hostedPipeline', () => {
  it('rewrites each org the steps and the Sync configurations name to the id it is registered under here', () => {
    const ids: Record<string, string> = {
      'reg-uat': '00D000000000009AAA',
      'reg-src': '00D000000000008AAA',
    };

    const hosted = hostedPipeline(fileOf(), (key) => ids[key]);

    expect((hosted.pipeline.steps[0] as { config: unknown }).config).toEqual({
      orgId: '00D000000000009AAA',
      templateId: 't',
    });
    expect(hosted.syncConfigs).toEqual([
      { id: 'cfg', sourceOrgId: '00D000000000008AAA', targetOrgId: '00D000000000009AAA' },
    ]);
    // The file itself is left as it is.
    expect(fileOf().syncConfigs['cfg']?.targetOrgId).toBe('reg-uat');
  });

  it('saves a variable the run requires and the file gives no value as not required: the command line holds it', () => {
    const hosted = hostedPipeline(fileOf(), () => undefined);

    expect(hosted.pipeline['variables']).toEqual([
      expect.objectContaining({ name: 'token', required: false }),
    ]);
    expect(hosted.pipeline).toMatchObject({ version: 1, triggers: [] });
  });
});

describe('saveCarried', () => {
  it('saves the Sync configurations and the templates the file carries, never one SandForge ships', () => {
    const configStore = store();

    saveCarried(
      configStore,
      {
        seedTemplates: {
          mine: { id: 'mine', name: 'Mine' },
          'prebuilt-minimal-demo': { id: 'prebuilt-minimal-demo' },
        },
        maskingTemplates: { 'tpl-gdpr-standard': { id: 'tpl-gdpr-standard' } },
      },
      { syncConfigs: [{ id: 'cfg', name: 'Accounts' }] },
    );

    expect(configStore.getKeysByPrefix('').sort()).toEqual(
      expect.arrayContaining(['seed:template:mine', 'sync:config:cfg']),
    );
    expect(configStore.get('seed:template:prebuilt-minimal-demo')).toBeUndefined();
    expect(configStore.getKeysByPrefix('anonymization:template:')).toEqual([]);
  });
});

describe('shareSnapshots', () => {
  it('lists in the backups folder the snapshots the run took, and leaves those listed before', () => {
    const hostStore = store();
    hostStore.set('backup:old', { operationId: 'old' }, 'backups');
    const before = snapshotKeys(hostStore);
    hostStore.set('backup:new', { operationId: 'new' }, 'backups');
    hostStore.set('backup:new:Contact', [{ Id: '003' }], 'backups');

    expect(shareSnapshots(hostStore, dir, before)).toBe(2);
    const listed = JSON.parse(readFileSync(join(dir, 'snapshots.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(
      Object.keys(listed)
        .filter((key) => key.startsWith('backup:'))
        .sort(),
    ).toEqual(['backup:new', 'backup:new:Contact']);
  });

  it('lists each under the alias the run reached its org by, its Organization Id kept beside it', () => {
    // Listed under the Id the host registers an org by, the restore the run
    // printed was refused "taken from org 00D… and cannot be restored into
    // org UAT": the same org.
    const hostStore = store();
    const before = snapshotKeys(hostStore);
    hostStore.set('backup:masked', { operationId: 'masked', orgId: SANDBOX.organizationId }, 'b');
    hostStore.set(
      'backup:kept',
      { operationId: 'kept', orgId: SANDBOX.organizationId, organizationId: '00D000000000009' },
      'b',
    );
    hostStore.set('backup:elsewhere', { operationId: 'elsewhere', orgId: 'unknown' }, 'b');
    hostStore.set('backup:masked:Contact', [{ Id: '003', orgId: 'x' }], 'b');

    shareSnapshots(hostStore, dir, before, (id) =>
      id === SANDBOX.organizationId ? 'UAT' : undefined,
    );

    const listed = fileConfigStore(join(dir, 'snapshots.json'));
    const valueOf = (key: string): unknown => listed.get(key);
    expect(valueOf('backup:masked')).toEqual({
      operationId: 'masked',
      orgId: 'UAT',
      organizationId: SANDBOX.organizationId,
    });
    expect(valueOf('backup:kept')).toEqual({
      operationId: 'kept',
      orgId: 'UAT',
      organizationId: '00D000000000009',
    });
    expect(valueOf('backup:elsewhere')).toEqual({ operationId: 'elsewhere', orgId: 'unknown' });
    expect(valueOf('backup:masked:Contact')).toEqual([{ Id: '003', orgId: 'x' }]);
  });
});

describe('createPipelineHost', () => {
  it('runs a pipeline as the Automation page does, its Approval answered by the command line, its notification printed', async () => {
    const printed: string[] = [];
    const pipelineHost = createPipelineHost({
      storeDir: join(dir, 'store'),
      backupDir: join(dir, 'backups'),
      log: () => undefined,
      setting: <T>(_key: string, fallback: T): T => fallback,
      notify: (message) => printed.push(message),
      sandforgeVersion: '1.81.0',
      askApproval: async () => ({ decision: 'approve', via: 'commandLine' }),
    });
    try {
      const run = await pipelineHost.host.request({
        id: 'cli-run-1',
        type: 'pipeline:execute',
        responseType: 'pipeline:run:response',
        payload: {
          pipeline: {
            id: 'p-host',
            name: 'Headless',
            steps: [
              { id: 's1', name: 'Gate', type: 'approval', config: { timeoutMinutes: 1 } },
              { id: 's2', name: 'Tell', type: 'notification', config: { message: 'Done.' } },
            ],
          },
        },
        timeoutMs: 10_000,
      });

      expect(run.outcome).toBe('answered');
      expect(run.message?.payload).toMatchObject({
        status: 'completed',
        stepResults: [
          { stepName: 'Gate', approval: { decision: 'approved', via: 'commandLine' } },
          { stepName: 'Tell', status: 'completed' },
        ],
      });
      expect(printed).toEqual(['Headless: Done.']);
      // The run is the request's, by the id the command line gave it.
      expect(
        pipelineHost.host.posted.some(
          (message) =>
            message.type === 'pipeline:step' &&
            (message.payload as { operationId?: string }).operationId === 'cli-run-1',
        ),
      ).toBe(true);
    } finally {
      pipelineHost.dispose();
    }
  });

  it('refuses a backups folder it cannot keep snapshots in, before anything is built', () => {
    // A folder under a file, which no one can make.
    writeFileSync(join(dir, 'a-file'), '');
    expect(() =>
      createPipelineHost({
        storeDir: join(dir, 'store'),
        backupDir: join(dir, 'a-file', 'backups'),
        log: () => undefined,
        setting: <T>(_key: string, fallback: T): T => fallback,
        notify: () => undefined,
        sandforgeVersion: '1.81.0',
      }),
    ).toThrow();
  });
});
