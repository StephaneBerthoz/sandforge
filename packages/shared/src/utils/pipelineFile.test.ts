import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod';

import type {
  PipelineFileDraft,
  PipelineFileIssue,
  PipelineFileNoteCode,
  PipelineFileSettingKey,
  SandforgePipelineFile,
} from '../types/pipelineFile.types.js';
import {
  PIPELINE_FILE_NOTE_CODES,
  PIPELINE_FILE_SETTINGS,
  PIPELINE_FILE_SUFFIX,
  PIPELINE_FILE_VERSION,
  PIPELINE_STEP_ORG_FIELDS,
  exporterVersionOf,
  parsePipelineFile,
  pipelineFileDigest,
  pipelineFileNameOf,
  pipelineFileOrgRefs,
  readPipelineFile,
  sandforgePipelineFileSchema,
  writePipelineFile,
} from './pipelineFile.js';

/*
 * Read by the type checker (`tsc -p tsconfig.test.json`): what the schema
 * reads is a pipeline file, and a pipeline file is what it reads, so the
 * export never writes a field the command line drops, nor the other way round.
 */
expectTypeOf<z.output<typeof sandforgePipelineFileSchema>>().toEqualTypeOf<SandforgePipelineFile>();

/** Two orgs, a step of each kind that names one, and a Sync configuration between them. */
function draft(): PipelineFileDraft {
  return {
    exportedAt: '2026-11-20T08:00:00.000Z',
    sandforgeVersion: '1.81.0',
    pipeline: {
      id: 'pl-nightly',
      name: 'Nightly reset',
      description: 'Compare, then sync and seed the target.',
      steps: [
        {
          id: 's1',
          name: 'Health',
          type: 'precheck',
          config: { orgId: 'reg-target', failOnCritical: true },
          continueOnError: false,
        },
        {
          id: 's2',
          name: 'Differences',
          type: 'compare',
          config: { sourceOrgId: 'reg-source', targetOrgId: 'reg-target' },
          continueOnError: false,
        },
        {
          id: 's3',
          name: 'Go?',
          type: 'approval',
          config: { message: 'Write to the target?' },
          continueOnError: false,
          timeout: 600_000,
        },
        {
          id: 's4',
          name: 'Accounts',
          type: 'sync',
          config: { configId: 'cfg-accounts' },
          continueOnError: false,
          retries: 1,
        },
        {
          id: 's5',
          name: 'Demo data',
          type: 'seed',
          config: { orgId: 'reg-target', templateId: 'tpl-saved-1' },
          continueOnError: true,
        },
      ],
      variables: [
        { name: 'batch', type: 'number', defaultValue: '200', required: false, description: '' },
        { name: 'apiKey', type: 'secret', required: true, description: 'Read from the CI.' },
      ],
      tags: ['nightly'],
    },
    schedule: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
    orgs: {
      'reg-source': {
        alias: 'UAT-SOURCE',
        organizationId: '00D000000000001AAA',
        kind: 'scratch',
        staging: false,
      },
      'reg-target': {
        alias: 'UAT',
        organizationId: '00D000000000002AAA',
        kind: 'sandbox',
        staging: true,
        name: 'Acme UAT',
      },
    },
    syncConfigs: {
      'cfg-accounts': {
        id: 'cfg-accounts',
        name: 'Accounts+Contacts',
        sourceOrgId: 'reg-source',
        targetOrgId: 'reg-target',
        objects: [{ objectApiName: 'Account' }],
      },
    },
    seedTemplates: { 'tpl-saved-1': { id: 'tpl-saved-1', name: 'Demo', objects: [] } },
    maskingTemplates: {},
    settings: { 'pipeline.timeout': 300_000, 'sync.maxRecordsPerObject': 1000 },
    notes: [
      {
        code: 'APPROVAL_NEEDS_PERSON',
        step: 'Go?',
        text: 'Approval step "Go?" asks a person.',
      },
    ],
  };
}

/** The file `draft()` writes, as a reader reads it. */
function written(): SandforgePipelineFile {
  const result = writePipelineFile(draft());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.file;
}

/** The issues a JSON value is refused with, by path. */
function issuesOf(value: unknown): PipelineFileIssue[] {
  const read = parsePipelineFile(value);
  if (read.ok) throw new Error('the file read');
  return read.refusal.issues;
}

/** A written file, as plain JSON a test can edit the way a person edits the file. */
function editable(): Record<string, unknown> & {
  pipeline: { steps: Array<Record<string, unknown>>; variables: Array<Record<string, unknown>> };
  orgs: Record<string, Record<string, unknown>>;
  syncConfigs: Record<string, Record<string, unknown>>;
  settings: Record<string, unknown>;
} {
  return JSON.parse(JSON.stringify(written()));
}

describe('writePipelineFile and readPipelineFile', () => {
  it('writes a file that reads back as written, its digest still that of what it holds', () => {
    const result = writePipelineFile(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.sandforgePipeline).toBe(PIPELINE_FILE_VERSION);
    expect(result.file.exportedBy).toBe('SandForge 1.81.0');
    expect(result.file.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.text.endsWith('\n')).toBe(true);
    const read = readPipelineFile(result.text);
    expect(read).toEqual({ ok: true, file: result.file, digestMatches: true });
  });

  it('keeps the digest when only when, by which release, or what the notes say changes', () => {
    const first = written();
    const later = writePipelineFile({
      ...draft(),
      exportedAt: '2027-01-02T03:04:05.000Z',
      sandforgeVersion: '1.82.0',
      notes: [],
    });
    expect(later.ok && later.file.digest).toBe(first.digest);
  });

  it('changes the digest with anything a run does differently', () => {
    const digest = written().digest;
    const changed: Array<(d: PipelineFileDraft) => void> = [
      (d) => (d.pipeline.steps[4].config['templateId'] = 'prebuilt-minimal-demo'),
      (d) => (d.orgs['reg-target'].staging = false),
      (d) => (d.orgs['reg-target'].organizationId = '00D000000000003AAA'),
      (d) => (d.settings['sync.maxRecordsPerObject'] = 2000),
      (d) => (d.schedule = { cron: '0 3 * * *', timezone: 'Europe/Paris' }),
      (d) => (d.schedule = null),
      (d) => (d.syncConfigs['cfg-accounts']['upsertKey'] = 'Id'),
      (d) => (d.seedTemplates['tpl-saved-1']['name'] = 'Demo 2'),
      (d) => (d.pipeline.steps[0].continueOnError = true),
    ];
    for (const change of changed) {
      const d = draft();
      change(d);
      const result = writePipelineFile(d);
      expect(result.ok, String(change)).toBe(true);
      expect(result.ok && result.file.digest, String(change)).not.toBe(digest);
    }
  });

  it('reads the digest the same whatever order a hand puts the keys in', () => {
    const file = editable();
    const reversed = (fields: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(fields).reverse());
    // The configurations and a step's configuration keep the keys they were
    // written with, in the order a hand leaves them.
    file.syncConfigs['cfg-accounts'] = reversed(file.syncConfigs['cfg-accounts']);
    file.pipeline.steps[0] = reversed(file.pipeline.steps[0]);
    file.pipeline.steps[0]['config'] = reversed(
      file.pipeline.steps[0]['config'] as Record<string, unknown>,
    );
    file.orgs['reg-target'] = reversed(file.orgs['reg-target']);
    const read = parsePipelineFile(reversed(file));
    expect(read.ok && read.digestMatches).toBe(true);
  });

  it('tells a file edited by hand since its export, and still reads it', () => {
    const file = editable();
    file.orgs['reg-target']['organizationId'] = '00D000000000009AAA';
    const read = readPipelineFile(JSON.stringify(file, null, 2));
    expect(read.ok).toBe(true);
    expect(read.ok && read.digestMatches).toBe(false);
  });

  it('keeps the fields of a step it does not read, as the editor saved them', () => {
    const d = draft();
    d.pipeline.steps[0]['canvas'] = { x: 120, y: 40 };
    const result = writePipelineFile(d);
    expect(result.ok && result.file.pipeline.steps[0]['canvas']).toEqual({ x: 120, y: 40 });
    const read = result.ok ? readPipelineFile(result.text) : undefined;
    expect(read?.ok && read.file.pipeline.steps[0]['canvas']).toEqual({ x: 120, y: 40 });
  });

  it('refuses to write a draft a reader would refuse, with every issue', () => {
    const d = draft();
    d.orgs['reg-source'].alias = 'admin@example.com';
    d.pipeline.variables[1].defaultValue = 'sk-live';
    const result = writePipelineFile(d);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual([
      'pipeline.variables.1.defaultValue',
      'orgs.reg-source.alias',
    ]);
  });
});

describe('parsePipelineFile: what is no pipeline file', () => {
  it('refuses a text that is not JSON, saying where it stops reading', () => {
    const read = readPipelineFile('{ "sandforgePipeline": 1,');
    expect(read.ok).toBe(false);
    expect(!read.ok && read.refusal.code).toBe('PIPELINE_FILE_NOT_JSON');
    expect(!read.ok && read.refusal.message).toMatch(/is not JSON at line 1, column \d+/);
  });

  it('never echoes the text of a file that is not JSON, which may be any file at all', () => {
    // The parser's own message quotes the text it stopped on: a file given by
    // mistake — an environment file — would land in a terminal or a CI log.
    const read = readPipelineFile('API_TOKEN=abc123secret');
    expect(!read.ok && read.refusal.code).toBe('PIPELINE_FILE_NOT_JSON');
    expect(JSON.stringify(read)).not.toContain('abc123');
    expect(JSON.stringify(read)).not.toContain('API_TOKEN');
  });

  it('refuses JSON that is no pipeline file, and says where one comes from', () => {
    for (const value of [
      { id: 'pl-1', name: 'A saved pipeline', steps: [] },
      [{ sandforgePipeline: 1 }],
      'pipeline',
      null,
    ]) {
      const read = parsePipelineFile(value);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.refusal.code).toBe('PIPELINE_FILE_NOT_A_PIPELINE');
      expect(!read.ok && read.refusal.message).toMatch(/Export/);
    }
  });

  it('refuses a version a later release wrote, naming that release', () => {
    const read = parsePipelineFile({
      sandforgePipeline: 2,
      exportedBy: 'SandForge 1.83.0',
      pipeline: { anything: 'new' },
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal).toMatchObject({
      code: 'PIPELINE_FILE_NEWER',
      fileVersion: 2,
      exporterVersion: '1.83.0',
      issues: [],
    });
    expect(read.refusal.message).toMatch(/SandForge 1\.83\.0/);
    expect(read.refusal.message).toMatch(/version 2/);
    expect(read.refusal.message).toMatch(/reads version 1/);
  });

  it('refuses a newer version whose writer it cannot name, without making one up', () => {
    const read = parsePipelineFile({ sandforgePipeline: 3, exportedBy: 'someone' });
    expect(!read.ok && read.refusal.code).toBe('PIPELINE_FILE_NEWER');
    expect(!read.ok && read.refusal.exporterVersion).toBeUndefined();
  });

  it('refuses a version that is no whole number from 1 as an invalid file', () => {
    for (const version of [0, -1, 1.5, '1', true]) {
      const file = { ...editable(), sandforgePipeline: version };
      const read = parsePipelineFile(file);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.refusal.code, String(version)).toBe('PIPELINE_FILE_INVALID');
      expect(!read.ok && read.refusal.issues.map((i) => i.path)).toContain('sandforgePipeline');
    }
  });
});

describe('parsePipelineFile: what a version-1 file must hold', () => {
  it('lists every issue it finds, not the first alone', () => {
    const file = editable();
    delete file['digest'];
    file.orgs['reg-source']['organizationId'] = '001000000000001AAA';
    file['exportedAt'] = 'yesterday';
    const read = parsePipelineFile(file);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe('PIPELINE_FILE_INVALID');
    expect(read.refusal.issues.map((i) => i.path).sort()).toEqual([
      'digest',
      'exportedAt',
      'orgs.reg-source.organizationId',
    ]);
    expect(read.refusal.message).toMatch(/3 issues/);
  });

  it('refuses a key it does not know, rather than run without what a hand meant', () => {
    const file = editable();
    file.orgs['reg-target']['stagging'] = true;
    file['schedul'] = null;
    expect(issuesOf(file).map((i) => i.path)).toEqual(['orgs.reg-target', '']);
  });

  it('never holds a username: an alias or a name shaped as one does not read', () => {
    const file = editable();
    file.orgs['reg-source']['alias'] = 'integration.user@acme.example';
    file.orgs['reg-target']['name'] = 'admin@acme.example.uat';
    const issues = issuesOf(file);
    expect(issues.map((i) => i.path)).toEqual(['orgs.reg-source.alias', 'orgs.reg-target.name']);
    expect(issues[0].message).toMatch(/username/);
    expect(issues[0].message).toMatch(/--org reg-source=<alias>/);
  });

  it('reads an org known by no alias of its own, which the run then maps', () => {
    const d = draft();
    delete d.orgs['reg-source'].alias;
    const result = writePipelineFile(d);
    expect(result.ok).toBe(true);
  });

  it('never holds the value of a secret variable, and names how to give it', () => {
    const file = editable();
    file.pipeline.variables[1]['defaultValue'] = 'sk-live-123';
    const [issue] = issuesOf(file);
    expect(issue.path).toBe('pipeline.variables.1.defaultValue');
    expect(issue.message).toMatch(/--var-env apiKey=/);
    expect(JSON.stringify(issuesOf(file))).not.toContain('sk-live-123');
  });

  it('reads the Staging mark of a sandbox alone, as Production Guard does', () => {
    for (const kind of ['scratch', 'developer', 'production'] as const) {
      const file = editable();
      file.orgs['reg-source']['staging'] = true;
      file.orgs['reg-source']['kind'] = kind;
      const [issue] = issuesOf(file);
      expect(issue.path).toBe('orgs.reg-source.staging');
      expect(issue.message).toMatch(/sandbox alone/);
    }
  });

  it('refuses an org key the command line could not map with --org key=alias', () => {
    const file = editable();
    file.orgs['reg source'] = file.orgs['reg-source'];
    file.orgs['reg=x'] = file.orgs['reg-source'];
    expect(issuesOf(file).map((i) => i.path)).toEqual(['orgs.reg source', 'orgs.reg=x']);
  });

  it('refuses an Organization Id that is no org of Salesforce', () => {
    for (const id of ['00D00000000000', '001000000000001AAA', '00D000000000001AAA-', '']) {
      const file = editable();
      file.orgs['reg-source']['organizationId'] = id;
      expect(issuesOf(file).map((i) => i.path)).toEqual(['orgs.reg-source.organizationId']);
    }
    const file = editable();
    file.orgs['reg-source']['organizationId'] = '00D000000000001';
    expect(parsePipelineFile(file).ok).toBe(true);
  });

  it('refuses a step that names an org the file does not hold', () => {
    const file = editable();
    file.pipeline.steps[0]['config'] = { orgId: 'reg-gone' };
    const [issue] = issuesOf(file);
    expect(issue.path).toBe('pipeline.steps.0.config.orgId');
    expect(issue.message).toMatch(/Precheck|"Health"/);
    expect(issue.message).toMatch(/reg-gone/);
  });

  it('refuses a Sync step whose configuration the file does not hold', () => {
    const file = editable();
    file.pipeline.steps[3]['config'] = { configId: 'cfg-gone' };
    const [issue] = issuesOf(file);
    expect(issue.path).toBe('pipeline.steps.3.config.configId');
    expect(issue.message).toMatch(/cfg-gone/);
  });

  it('refuses a Sync configuration that names an org the file does not hold', () => {
    const file = editable();
    file.syncConfigs['cfg-accounts']['targetOrgId'] = 'reg-gone';
    const [issue] = issuesOf(file);
    expect(issue.path).toBe('syncConfigs.cfg-accounts.targetOrgId');
  });

  it('refuses a configuration or a template filed under another id than its own', () => {
    const file = editable();
    file.syncConfigs['cfg-other'] = { ...file.syncConfigs['cfg-accounts'] };
    (file['seedTemplates'] as Record<string, Record<string, unknown>>)['tpl-saved-1']['id'] =
      'tpl-x';
    expect(issuesOf(file).map((i) => i.path)).toEqual([
      'syncConfigs.cfg-other.id',
      'seedTemplates.tpl-saved-1.id',
    ]);
  });

  it('reads a step of a type this release does not have, which the run refuses by name', () => {
    const file = editable();
    file.pipeline.steps.push({ id: 's9', name: 'Old', type: 'script', config: {} });
    file.pipeline.steps.push({ id: 's10', name: 'New', type: 'forge', config: { orgId: 'x' } });
    file['digest'] = pipelineFileDigest(file as unknown as SandforgePipelineFile);
    const read = parsePipelineFile(file);
    expect(read.ok && read.digestMatches).toBe(true);
  });

  it('refuses a step with no id or name, which neither a route nor --approve could name', () => {
    const file = editable();
    file.pipeline.steps[0]['id'] = '';
    delete file.pipeline.steps[1]['name'];
    expect(issuesOf(file).map((i) => i.path)).toEqual([
      'pipeline.steps.0.id',
      'pipeline.steps.1.name',
    ]);
  });

  it('reads a note whose code this release does not know, and refuses one that is no code', () => {
    const file = editable();
    (file['notes'] as unknown[]).push({ code: 'SOMETHING_LATER', text: 'A later note.' });
    expect(parsePipelineFile(file).ok).toBe(true);
    (file['notes'] as unknown[]).push({ code: 'not a code', text: 'x' });
    expect(issuesOf(file).map((i) => i.path)).toEqual(['notes.2.code']);
  });
});

describe('parsePipelineFile: the settings a run reads', () => {
  it('refuses a setting no step reads, naming those it takes', () => {
    const file = editable();
    file.settings['sync.maxRecordPerObject'] = 1000;
    const [issue] = issuesOf(file);
    expect(issue.path).toBe('settings');
    expect(issue.message).toMatch(/sync\.maxRecordPerObject/);
    expect(issue.message).toMatch(/sync\.maxRecordsPerObject/);
  });

  it("refuses a value past a setting's bounds, or of another type, as the editor's settings do", () => {
    const cases: Array<[string, unknown]> = [
      ['sync.maxRecordsPerObject', 50_001],
      ['sync.maxRecordsPerObject', 1.5],
      ['pipeline.timeout', 1000],
      ['backup.maxAgeDays', -1],
      ['safety.auditLogging', 'false'],
      ['grappe.grappeSize', 0],
    ];
    for (const [key, value] of cases) {
      const file = editable();
      file.settings[key] = value;
      expect(
        issuesOf(file).map((i) => i.path),
        `${key}=${String(value)}`,
      ).toEqual([`settings.${key}`]);
    }
  });

  it('names each setting it takes once, with a rule a value is held to', () => {
    expectTypeOf<keyof typeof PIPELINE_FILE_SETTINGS>().toEqualTypeOf<PipelineFileSettingKey>();
    for (const [key, rule] of Object.entries(PIPELINE_FILE_SETTINGS)) {
      if (rule.type === 'boolean') expect(rule, key).toEqual({ type: 'boolean' });
      else expect(rule.minimum, key).toBeTypeOf('number');
    }
  });
});

describe('pipelineFileOrgRefs', () => {
  it('lists each place an org is named: the steps in order, then the Sync configurations', () => {
    expect(pipelineFileOrgRefs(written())).toEqual([
      { key: 'reg-target', field: 'orgId', stepId: 's1' },
      { key: 'reg-source', field: 'sourceOrgId', stepId: 's2' },
      { key: 'reg-target', field: 'targetOrgId', stepId: 's2' },
      { key: 'reg-target', field: 'orgId', stepId: 's5' },
      { key: 'reg-source', field: 'sourceOrgId', syncConfigId: 'cfg-accounts' },
      { key: 'reg-target', field: 'targetOrgId', syncConfigId: 'cfg-accounts' },
    ]);
  });

  it('reads the org fields of every step type that writes to or reads an org', () => {
    expect(PIPELINE_STEP_ORG_FIELDS).toEqual({
      backup: ['orgId'],
      compare: ['sourceOrgId', 'targetOrgId'],
      precheck: ['orgId'],
      seed: ['orgId'],
      anonymize: ['orgId'],
      checkpoint: ['orgId'],
      rewind: ['orgId'],
    });
  });

  it('leaves out a field that names no org, which the step check refuses as the editor does', () => {
    const file = written();
    file.pipeline.steps[0].config = { orgId: '' };
    file.pipeline.steps[1].config = { sourceOrgId: 42 };
    expect(pipelineFileOrgRefs(file).filter((ref) => ref.stepId !== undefined)).toEqual([
      { key: 'reg-target', field: 'orgId', stepId: 's5' },
    ]);
  });
});

describe('the names a pipeline file goes by', () => {
  it('names the file after its pipeline, in characters every system takes', () => {
    expect(pipelineFileNameOf('Nightly reset')).toBe(`nightly-reset${PIPELINE_FILE_SUFFIX}`);
    expect(pipelineFileNameOf('Réinit. nocturne / UAT')).toBe(
      'reinit-nocturne-uat.sandforge-pipeline.json',
    );
    expect(pipelineFileNameOf('夜間リセット')).toBe('pipeline.sandforge-pipeline.json');
    expect(pipelineFileNameOf('  ')).toBe('pipeline.sandforge-pipeline.json');
    expect(pipelineFileNameOf('a'.repeat(300))).toBe(`${'a'.repeat(80)}${PIPELINE_FILE_SUFFIX}`);
  });

  it('reads the release a file names as its writer', () => {
    expect(exporterVersionOf('SandForge 1.81.0')).toBe('1.81.0');
    expect(exporterVersionOf('SandForge 1.82.0-beta.1')).toBe('1.82.0-beta.1');
    expect(exporterVersionOf('SandForge')).toBeUndefined();
    expect(exporterVersionOf('SandForge 1.81.0; rm -rf ~')).toBeUndefined();
  });

  it('knows each note code an export writes', () => {
    expectTypeOf<(typeof PIPELINE_FILE_NOTE_CODES)[number]>().toEqualTypeOf<PipelineFileNoteCode>();
    expect(new Set(PIPELINE_FILE_NOTE_CODES).size).toBe(PIPELINE_FILE_NOTE_CODES.length);
  });
});
