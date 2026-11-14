import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { PipelineDefinition, PipelineExportOutcome, PipelineStep } from '@sandforge/shared';
import { PIPELINE_FILE_SETTINGS, readPipelineFile } from '@sandforge/shared';
import {
  PIPELINE_SETTING_DEFAULTS,
  buildPipelineExport,
  pipelineExportDigest,
  type ExportedOrgSource,
  type PipelineExportInput,
} from './pipelineExport.js';

const USERNAME = 'admin.person@example.com.uat';
const DEV_USERNAME = 'dev.person@example.com.dev';

/** The registry: a Staging sandbox with an alias, a sandbox known by its username, a production org. */
const ORGS: Record<string, ExportedOrgSource> = {
  'org-uat': {
    alias: 'UAT',
    username: USERNAME,
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    staging: true,
    organizationName: 'Acme UAT',
    authMethod: 'sfdx_import',
  },
  'org-dev': {
    // The registry keeps the username as the alias of an org that has none.
    alias: DEV_USERNAME,
    username: DEV_USERNAME,
    orgId: '00D000000000002AAA',
    orgType: 'Sandbox',
    authMethod: 'usernamePassword',
  },
  'org-prod': {
    alias: 'PROD',
    username: 'admin.person@example.com',
    orgId: '00D000000000003AAA',
    orgType: 'Production',
    authMethod: 'oauth_web',
  },
};

const SYNC_CONFIG = {
  id: 'cfg-accounts',
  name: 'Accounts+Contacts',
  sourceOrgId: 'org-dev',
  targetOrgId: 'org-uat',
  objects: [{ objectApiName: 'Account' }],
};

const SEED_TEMPLATE = {
  id: 'seed-demo',
  name: 'Demo accounts',
  objects: [],
  updatedAt: '2026-11-01',
};

const MASKING_TEMPLATE = {
  id: 'mask-people',
  name: 'People',
  description: '',
  complianceFramework: 'custom',
  rules: [{ fieldPattern: 'Contact.Email', strategy: 'fake', description: '' }],
  saved: true,
  createdAt: '2026-11-01T00:00:00.000Z',
};

function step(
  id: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
): PipelineStep {
  return { id, name, type, config, continueOnError: false } as PipelineStep;
}

function nightly(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: 'pipe-nightly',
    name: 'Nightly reset',
    description: 'Every night',
    version: 1,
    steps: [
      step('s-approve', 'Go?', 'approval', { timeoutMinutes: 60 }),
      step('s-sync', 'Accounts', 'sync', { configId: 'cfg-accounts' }),
      step('s-seed', 'Seed demo', 'seed', { orgId: 'org-uat', templateId: 'seed-demo' }),
      step('s-mask', 'Mask people', 'anonymize', { orgId: 'org-uat', templateId: 'mask-people' }),
      step('s-rewind', 'Back', 'rewind', {
        orgId: 'org-uat',
        checkpointId: 'cp-1',
        maxRecords: 100,
      }),
    ],
    triggers: [
      {
        id: 't-1',
        type: 'schedule',
        enabled: true,
        config: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
      },
    ],
    variables: [
      {
        name: 'apiToken',
        type: 'secret',
        defaultValue: 'hunter2-secret-value',
        required: true,
        description: '',
      },
      { name: 'region', type: 'string', defaultValue: 'eu', required: false, description: '' },
    ],
    tags: ['nightly'],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<PipelineExportInput> = {}): PipelineExportInput {
  return {
    pipeline: nightly(),
    org: (orgId) => (Object.hasOwn(ORGS, orgId) ? ORGS[orgId] : undefined),
    syncConfig: (id) => (id === SYNC_CONFIG.id ? SYNC_CONFIG : undefined),
    seedTemplate: (id) => (id === SEED_TEMPLATE.id ? SEED_TEMPLATE : undefined),
    maskingTemplate: (id) => (id === MASKING_TEMPLATE.id ? MASKING_TEMPLATE : undefined),
    setting: (_key, fallback) => fallback,
    sandforgeVersion: '1.81.0',
    exportedAt: '2026-11-20T10:00:00.000Z',
    machineTimezone: 'Europe/Paris',
    now: Date.parse('2026-11-20T10:00:00.000Z'),
    ...overrides,
  };
}

function exported(
  outcome: PipelineExportOutcome,
): Extract<PipelineExportOutcome, { exported: true }> {
  if (!outcome.exported) throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  return outcome;
}

describe('a pipeline exported as a file', () => {
  it('carries its orgs by alias and Organization Id, its configuration and templates in line, and no secret value', () => {
    const out = exported(buildPipelineExport(input()));
    const read = readPipelineFile(out.text);
    if (!read.ok) throw new Error(read.refusal.message);
    const { file } = read;

    expect(read.digestMatches).toBe(true);
    expect(out.digest).toBe(file.digest);
    expect(out.fileName).toBe('nightly-reset.sandforge-pipeline.json');
    expect(file.orgs['org-uat']).toEqual({
      alias: 'UAT',
      organizationId: '00D000000000001AAA',
      kind: 'sandbox',
      staging: true,
      name: 'Acme UAT',
    });
    expect(file.syncConfigs).toEqual({ 'cfg-accounts': SYNC_CONFIG });
    expect(file.seedTemplates).toEqual({ 'seed-demo': SEED_TEMPLATE });
    expect(file.maskingTemplates).toEqual({ 'mask-people': MASKING_TEMPLATE });
    expect(file.pipeline.variables[0]).toEqual({
      name: 'apiToken',
      type: 'secret',
      required: true,
      description: '',
    });
    expect(file.schedule).toEqual({ cron: '0 2 * * *', timezone: 'Europe/Paris' });
    expect(Object.keys(file.pipeline).sort()).toEqual(
      ['description', 'id', 'name', 'steps', 'tags', 'variables'].sort(),
    );
    expect(out.text).not.toContain('hunter2-secret-value');
  });

  it('never holds a username: an org known by its username alone goes without an alias, and a note says how to run it', () => {
    const out = exported(buildPipelineExport(input()));

    for (const text of [
      out.text,
      ...Object.values(out.launchers).map((launcher) => launcher.text),
    ]) {
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain(DEV_USERNAME);
      expect(text).not.toContain('admin.person@');
    }
    const read = readPipelineFile(out.text);
    if (!read.ok) throw new Error(read.refusal.message);
    expect(read.file.orgs['org-dev']).toEqual({
      organizationId: '00D000000000002AAA',
      kind: 'sandbox',
      staging: false,
    });
    expect(out.notes).toContainEqual(
      expect.objectContaining({
        code: 'ORG_NO_ALIAS',
        org: 'org-dev',
        text: expect.stringContaining('--org org-dev=<alias>'),
      }),
    );
  });

  it('notes what each step asks where VS Code is not: the Rewind confirmation, its checkpoint, the Staging Approval', () => {
    const out = exported(buildPipelineExport(input()));

    expect(out.steps.map((s) => [s.name, s.fate, s.notes])).toEqual([
      ['Go?', 'asks', ['STAGING_NEEDS_PERSON']],
      ['Accounts', 'runs', []],
      ['Seed demo', 'runs', []],
      ['Mask people', 'runs', []],
      ['Back', 'asks', ['REWIND_NEEDS_CONFIRMATION', 'REWIND_CHECKPOINT_ELSEWHERE']],
    ]);
    expect(out.notes).toContainEqual(
      expect.objectContaining({
        code: 'REWIND_NEEDS_CONFIRMATION',
        step: 'Back',
        text: expect.stringContaining('--confirm-rewind UAT'),
      }),
    );
    expect(out.notes).toContainEqual(
      expect.objectContaining({
        code: 'SECRET_NOT_EXPORTED',
        text: expect.stringContaining('--var-env apiToken=SANDFORGE_VAR_APITOKEN'),
      }),
    );
    expect(out.notes).toContainEqual(
      expect.objectContaining({ code: 'ORG_NOT_SIGNED_IN', org: 'org-dev' }),
    );
    expect(out.orgs.find((org) => org.key === 'org-uat')).toEqual({
      key: 'org-uat',
      alias: 'UAT',
      name: 'Acme UAT',
      kind: 'sandbox',
      staging: true,
      cliHolds: true,
      writtenBy: ['Accounts', 'Seed demo', 'Mask people', 'Back'],
      readBy: [],
    });
    expect(out.orgs.find((org) => org.key === 'org-dev')).toMatchObject({
      cliHolds: false,
      writtenBy: [],
      readBy: ['Accounts'],
    });
    expect(out.variables).toEqual([
      {
        name: 'apiToken',
        type: 'secret',
        required: true,
        valued: false,
        env: 'SANDFORGE_VAR_APITOKEN',
      },
      { name: 'region', type: 'string', required: false, valued: true },
    ]);
  });

  it('asks a person, and not a line ahead, only for an Approval before a write to a Staging sandbox', () => {
    const pipeline = nightly({
      steps: [
        step('s-approve', 'Go?', 'approval', {}),
        step('s-seed', 'Seed dev', 'seed', {
          orgId: 'org-dev',
          templateId: 'prebuilt-minimal-demo',
        }),
      ],
    });
    const out = exported(buildPipelineExport(input({ pipeline })));

    expect(out.steps[0]).toMatchObject({ fate: 'asks', notes: ['APPROVAL_NEEDS_PERSON'] });
    expect(out.notes[0]?.text).toContain('--approve "Go?"');
    // A shipped template goes by its id alone.
    const read = readPipelineFile(out.text);
    expect(read.ok && read.file.seedTemplates).toEqual({});
  });

  it('marks refused the step the editor’s check refuses, with its words, and a write to a production org', () => {
    const pipeline = nightly({
      steps: [
        step('s-restore', 'Restore it', 'restore', { orgId: 'org-uat' }),
        step('s-seed', 'Seed prod', 'seed', { orgId: 'org-prod', templateId: 'prebuilt-x' }),
        step('s-precheck', 'Health', 'precheck', { orgId: 'org-prod' }),
      ],
    });
    const out = exported(
      buildPipelineExport(
        input({
          pipeline,
          stepRefusal: (s) =>
            s.type === 'restore' ? `Step "${s.name}" cannot run in a pipeline.` : undefined,
          problems: ['Step "Restore it" cannot run in a pipeline.'],
        }),
      ),
    );

    expect(out.steps.map((s) => [s.name, s.fate, s.refusal])).toEqual([
      ['Restore it', 'refused', 'Step "Restore it" cannot run in a pipeline.'],
      [
        'Seed prod',
        'refused',
        'Step "Seed prod" writes to "PROD", a production org: the command line never writes to a ' +
          'production org, whatever an Approval answers.',
      ],
      ['Health', 'runs', undefined],
    ]);
    expect(out.problems).toEqual(['Step "Restore it" cannot run in a pipeline.']);
  });

  it('carries the settings the steps read that differ from their defaults, and refuses one past its bounds', () => {
    const lowered = exported(
      buildPipelineExport(
        input({
          setting: <T>(key: string, fallback: T): T =>
            (key === 'sync.maxRecordsPerObject' ? 1_000 : fallback) as T,
        }),
      ),
    );
    const read = readPipelineFile(lowered.text);
    expect(read.ok && read.file.settings).toEqual({ 'sync.maxRecordsPerObject': 1_000 });

    const past = buildPipelineExport(
      input({
        setting: <T>(key: string, fallback: T): T =>
          (key === 'backup.maxCount' ? 500 : fallback) as T,
      }),
    );
    expect(past).toMatchObject({
      exported: false,
      code: 'FILE_INVALID',
      issues: [expect.objectContaining({ path: 'settings.backup.maxCount' })],
    });
  });

  it('reads a schedule saved without a zone in this machine’s, and keeps a handed-over schedule on a new export', () => {
    const noZone = nightly({
      triggers: [{ id: 't', type: 'schedule', enabled: true, config: { cron: '30 6 * * 1-5' } }],
    });
    expect(
      exported(
        buildPipelineExport(input({ pipeline: noZone, machineTimezone: 'America/New_York' })),
      ).schedule,
    ).toEqual({ cron: '30 6 * * 1-5', timezone: 'America/New_York' });

    const off = nightly({
      triggers: [{ id: 't', type: 'schedule', enabled: false, config: { cron: '0 2 * * *' } }],
    });
    expect(exported(buildPipelineExport(input({ pipeline: off }))).schedule).toBeNull();

    const handedOver = {
      ...off,
      runsOutside: {
        since: '2026-11-20T10:00:00.000Z',
        runner: 'cron' as const,
        file: 'nightly-reset.sandforge-pipeline.json',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    };
    expect(exported(buildPipelineExport(input({ pipeline: handedOver }))).schedule).toEqual({
      cron: '0 2 * * *',
      timezone: 'Europe/Paris',
    });
  });

  it('notes a trigger only the editor watches', () => {
    const pipeline = nightly({
      triggers: [
        { id: 't', type: 'sandbox_refresh', enabled: true, config: { orgId: 'org-uat' } },
        { id: 'u', type: 'webhook', enabled: false, config: {} },
      ],
    });
    const out = exported(buildPipelineExport(input({ pipeline })));
    expect(out.notes.filter((n) => n.code === 'TRIGGER_NOT_EXPORTED')).toHaveLength(1);
    expect(out.schedule).toBeNull();
    expect(out.launchers.cron.schedule).toBeUndefined();
  });

  it('reads an org id from a saved pipeline as data: one named constructor is no org it holds', () => {
    const pipeline = nightly({
      steps: [step('s-seed', 'Seed', 'seed', { orgId: 'constructor', templateId: 'prebuilt-x' })],
    });
    expect(buildPipelineExport(input({ pipeline }))).toMatchObject({
      exported: false,
      code: 'ORG_UNKNOWN',
    });
  });

  it('is refused, with what to do, for an org no longer registered, a configuration no longer saved, two schedules', () => {
    expect(
      buildPipelineExport(input({ org: (id) => (id === 'org-uat' ? undefined : ORGS[id]) })),
    ).toMatchObject({
      exported: false,
      code: 'ORG_UNKNOWN',
      message: expect.stringContaining('Step "Accounts" names an org that is no longer registered'),
    });
    expect(buildPipelineExport(input({ syncConfig: () => undefined }))).toMatchObject({
      exported: false,
      code: 'SYNC_CONFIG_UNKNOWN',
    });
    const twice = nightly({
      triggers: [
        { id: 'a', type: 'schedule', enabled: true, config: { cron: '0 2 * * *' } },
        { id: 'b', type: 'schedule', enabled: true, config: { cron: '0 3 * * *' } },
      ],
    });
    expect(buildPipelineExport(input({ pipeline: twice }))).toMatchObject({
      exported: false,
      code: 'SCHEDULES_MANY',
    });
  });

  it('has the same digest exported a day later, and another once a setting changed', () => {
    const today = exported(buildPipelineExport(input()));
    expect(pipelineExportDigest(input({ exportedAt: '2026-11-21T10:00:00.000Z' }))).toBe(
      today.digest,
    );
    expect(
      pipelineExportDigest(
        input({
          setting: <T>(key: string, fallback: T): T =>
            (key === 'pipeline.timeout' ? 600_000 : fallback) as T,
        }),
      ),
    ).not.toBe(today.digest);
    expect(pipelineExportDigest(input({ syncConfig: () => undefined }))).toBeUndefined();
  });
});

describe('the defaults of the settings a pipeline file carries', () => {
  it('are the manifest’s, for every setting the file takes', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { contributes: { configuration: { properties: Record<string, { default?: unknown }> } } };
    const properties = manifest.contributes.configuration.properties;
    expect(Object.keys(PIPELINE_SETTING_DEFAULTS).sort()).toEqual(
      Object.keys(PIPELINE_FILE_SETTINGS).sort(),
    );
    for (const [key, value] of Object.entries(PIPELINE_SETTING_DEFAULTS)) {
      expect(properties[`sandforge.${key}`]?.default, key).toBe(value);
    }
  });
});
