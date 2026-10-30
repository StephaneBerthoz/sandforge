import { describe, it, expect } from 'vitest';
import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  APPROVAL_MAX_MESSAGE_LENGTH,
  approvalDefect,
  approvalTimeoutMinutes,
  CHECKPOINT_STEP_DEFAULT_KEEP_DAYS,
  isPipelineStepType,
  isRetiredPipelineStepType,
  PIPELINE_STEP_TYPES,
  pipelineAnonymizeStepConfigSchema,
  pipelineCheckpointStepConfigSchema,
  pipelineRewindStepConfigSchema,
  pipelineSeedStepConfigSchema,
  rewindGrantDigest,
  type PipelineRewindStepConfig,
} from './pipelineStepRules';

describe('step types', () => {
  it('knows Approval and Sync, and none of the types SandForge no longer has', () => {
    expect(isPipelineStepType('approval')).toBe(true);
    expect(isPipelineStepType('sync')).toBe(true);
    for (const retired of ['script', 'loop', 'parallel']) {
      expect(isPipelineStepType(retired)).toBe(false);
      expect(isRetiredPipelineStepType(retired)).toBe(true);
    }
  });

  it('calls a type nobody ever had neither current nor retired', () => {
    expect(isPipelineStepType('dataops')).toBe(false);
    expect(isRetiredPipelineStepType('dataops')).toBe(false);
    expect(isRetiredPipelineStepType(undefined)).toBe(false);
  });

  it('lists no type twice', () => {
    expect(new Set(PIPELINE_STEP_TYPES).size).toBe(PIPELINE_STEP_TYPES.length);
  });

  it('knows the Checkpoint and Rewind steps, and Seed and Anonymize under the one name each has', () => {
    for (const type of ['checkpoint', 'rewind', 'seed', 'anonymize']) {
      expect(isPipelineStepType(type)).toBe(true);
    }
    for (const spelling of ['take-checkpoint', 'Rewind', 'anonymise', 'mask']) {
      expect(isPipelineStepType(spelling)).toBe(false);
    }
  });
});

/** The first issue a schema refused `value` on, as `path: message`; undefined when it read. */
function refusalOf(
  schema: {
    safeParse(value: unknown): {
      success: boolean;
      error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
    };
  },
  value: unknown,
): string | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return undefined;
  const issue = parsed.error?.issues[0];
  return issue ? `${issue.path.join('.')}: ${issue.message}` : 'refused';
}

const CHECKPOINT = 'ck-20261022-140512-a1b2';

describe('pipelineCheckpointStepConfigSchema', () => {
  const step = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    orgId: 'org-1',
    mode: 'everything',
    ...patch,
  });

  it('takes everything people work in, kept thirty days unless it says otherwise', () => {
    const read = pipelineCheckpointStepConfigSchema.parse(step());
    expect(read).toEqual({ orgId: 'org-1', mode: 'everything', keepDays: 30 });
    expect(CHECKPOINT_STEP_DEFAULT_KEEP_DAYS).toBe(30);
    expect(pipelineCheckpointStepConfigSchema.parse(step({ keepDays: 0 })).keepDays).toBe(0);
  });

  it('takes the objects picked, those left out, a limit and the fields not compared', () => {
    const asked = step({
      mode: 'picked',
      objects: ['Account', 'Case'],
      excluded: ['Task'],
      maxTotal: 250_000,
      ignoredFields: ['Case.Last_Touched__c'],
      name: 'Nightly {date}',
    });
    expect(refusalOf(pipelineCheckpointStepConfigSchema, asked)).toBeUndefined();
  });

  it('refuses objects without "picked", and "picked" without objects', () => {
    expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ mode: 'picked' }))).toMatch(
      /^objects: Name the objects/,
    );
    expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ objects: ['Account'] }))).toMatch(
      /^objects: Name the objects/,
    );
    expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ mode: 'all' }))).toMatch(/^mode/);
  });

  it('refuses an org it does not name, an object named twice or not by its API name', () => {
    for (const orgId of ['', '   ', 42]) {
      expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ orgId }))).toMatch(/^orgId/);
    }
    for (const objects of [[], ['Account', 'Account'], ['Account WHERE Id != null']]) {
      expect(
        refusalOf(pipelineCheckpointStepConfigSchema, step({ mode: 'picked', objects })),
      ).toMatch(/^objects/);
    }
    expect(
      refusalOf(pipelineCheckpointStepConfigSchema, step({ excluded: ['Case', 'Case'] })),
    ).toMatch(/^excluded/);
  });

  it('refuses a keeping time outside whole days up to ten years, and a limit below one record', () => {
    for (const keepDays of [-1, 1.5, 3651, '30']) {
      expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ keepDays }))).toMatch(
        /^keepDays/,
      );
    }
    for (const maxTotal of [0, 1.5, '500000']) {
      expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ maxTotal }))).toMatch(
        /^maxTotal/,
      );
    }
  });

  it('refuses a fields list that names a field without its object, or one twice', () => {
    for (const ignoredFields of [['Last_Touched__c'], ['Case.A__c', 'Case.A__c']]) {
      expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ ignoredFields }))).toMatch(
        /^ignoredFields/,
      );
    }
  });

  it('refuses a name that is blank, more than one line, or too long once its date is put in', () => {
    for (const name of ['', '  ', 'Before\nUAT', `${'x'.repeat(100)} {date}`]) {
      expect(refusalOf(pipelineCheckpointStepConfigSchema, step({ name }))).toMatch(/^name/);
    }
    // 99 characters and a date of 20 is 119: a name a checkpoint can have.
    expect(
      refusalOf(pipelineCheckpointStepConfigSchema, step({ name: `${'x'.repeat(99)}{date}` })),
    ).toBeUndefined();
    expect(
      refusalOf(pipelineCheckpointStepConfigSchema, step({ name: `${'x'.repeat(101)}{date}` })),
    ).toMatch(/^name: A checkpoint name is at most 120 characters/);
  });
});

/** A Rewind step's configuration as the page would save one, every field said. */
const rewindConfig = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  orgId: 'org-1',
  checkpointId: CHECKPOINT,
  maxRecords: 500,
  ...patch,
});

describe('pipelineRewindStepConfigSchema', () => {
  it('accepts nothing it is not told to, and refuses when people are active unless told not to', () => {
    expect(pipelineRewindStepConfigSchema.parse(rewindConfig())).toEqual({
      orgId: 'org-1',
      checkpointId: CHECKPOINT,
      maxRecords: 500,
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptRecreate: false,
      acceptOutside: false,
      acceptUnseen: false,
      refuseWhenActive: true,
    });
  });

  it('takes the objects a rewind is limited to, and each acceptance said', () => {
    const asked = rewindConfig({
      objects: ['Case', 'Contact'],
      acceptAutomation: true,
      acceptNoUndo: true,
      acceptRecreate: true,
      acceptOutside: true,
      acceptUnseen: true,
      refuseWhenActive: false,
    });
    expect(refusalOf(pipelineRewindStepConfigSchema, asked)).toBeUndefined();
  });

  it('refuses a step with no bound on the records it rewinds, or one below a record', () => {
    const unbound = rewindConfig();
    delete unbound['maxRecords'];
    expect(refusalOf(pipelineRewindStepConfigSchema, unbound)).toMatch(/^maxRecords/);
    for (const maxRecords of [0, -1, 2.5, '500', null]) {
      expect(refusalOf(pipelineRewindStepConfigSchema, rewindConfig({ maxRecords }))).toMatch(
        /^maxRecords/,
      );
    }
  });

  it('refuses the latest checkpoint, and any id that is no checkpoint id', () => {
    for (const checkpointId of ['latest', 'LATEST', ' latest ']) {
      expect(refusalOf(pipelineRewindStepConfigSchema, rewindConfig({ checkpointId }))).toBe(
        'checkpointId: A Rewind step names its checkpoint by its id, never latest',
      );
    }
    for (const checkpointId of [
      '',
      'pv-20261022-141030-c3d4',
      '../ck-20261022-140512-a1b2',
      'Before UAT',
    ]) {
      expect(refusalOf(pipelineRewindStepConfigSchema, rewindConfig({ checkpointId }))).toMatch(
        /^checkpointId: Expected an id shaped ck-/,
      );
    }
  });

  it('refuses an org it does not name, and objects that are none, named twice or not by API name', () => {
    expect(refusalOf(pipelineRewindStepConfigSchema, rewindConfig({ orgId: '' }))).toMatch(
      /^orgId/,
    );
    for (const objects of [[], ['Case', 'Case'], ['Case; DELETE']]) {
      expect(refusalOf(pipelineRewindStepConfigSchema, rewindConfig({ objects }))).toMatch(
        /^objects/,
      );
    }
  });

  it('refuses an acceptance that is not a yes or a no', () => {
    for (const said of [
      'acceptAutomation',
      'acceptNoUndo',
      'acceptRecreate',
      'acceptOutside',
      'acceptUnseen',
      'refuseWhenActive',
    ]) {
      expect(refusalOf(pipelineRewindStepConfigSchema, rewindConfig({ [said]: 'yes' }))).toMatch(
        new RegExp(`^${said}`),
      );
    }
  });
});

describe('pipelineSeedStepConfigSchema', () => {
  it('takes an org and a template, saved or shipped', () => {
    for (const templateId of ['tpl-1', 'prebuilt-sales-pipeline']) {
      expect(
        refusalOf(pipelineSeedStepConfigSchema, { orgId: 'org-1', templateId }),
      ).toBeUndefined();
    }
  });

  it('refuses a step that names no org or no template', () => {
    expect(refusalOf(pipelineSeedStepConfigSchema, { templateId: 'tpl-1' })).toMatch(/^orgId/);
    expect(refusalOf(pipelineSeedStepConfigSchema, { orgId: 'org-1', templateId: ' ' })).toMatch(
      /^templateId: Name the template/,
    );
    expect(refusalOf(pipelineSeedStepConfigSchema, { orgId: 'org-1' })).toMatch(/^templateId/);
  });
});

describe('pipelineAnonymizeStepConfigSchema', () => {
  const masking = { orgId: 'org-1', templateId: 'tpl-gdpr-standard' };

  it('masks every object of a template, or one object, its rows held to a condition', () => {
    expect(refusalOf(pipelineAnonymizeStepConfigSchema, masking)).toBeUndefined();
    expect(
      refusalOf(pipelineAnonymizeStepConfigSchema, {
        ...masking,
        object: 'Contact',
        where: "Title = 'Test contact'",
      }),
    ).toBeUndefined();
  });

  it('reads an empty condition as none, with or without an object', () => {
    expect(
      refusalOf(pipelineAnonymizeStepConfigSchema, { ...masking, where: '  ' }),
    ).toBeUndefined();
  });

  it('refuses a condition without the one object whose rows it filters', () => {
    expect(refusalOf(pipelineAnonymizeStepConfigSchema, { ...masking, where: "Title = 'x'" })).toBe(
      'where: A condition filters the rows of one object: name the object',
    );
  });

  it('refuses an object not named by its API name, a condition too long, and no template', () => {
    expect(
      refusalOf(pipelineAnonymizeStepConfigSchema, { ...masking, object: 'Contact c' }),
    ).toMatch(/^object/);
    expect(
      refusalOf(pipelineAnonymizeStepConfigSchema, {
        ...masking,
        object: 'Contact',
        where: 'x'.repeat(2001),
      }),
    ).toMatch(/^where/);
    expect(refusalOf(pipelineAnonymizeStepConfigSchema, { orgId: 'org-1' })).toMatch(/^templateId/);
  });
});

describe('rewindGrantDigest', () => {
  const read = (patch: Record<string, unknown> = {}): PipelineRewindStepConfig =>
    pipelineRewindStepConfigSchema.parse(rewindConfig(patch));
  const digest = (patch: Record<string, unknown> = {}): string => rewindGrantDigest(read(patch));

  it('is sha256 and 64 hexadecimal digits', () => {
    expect(digest()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is the same however the configuration orders its keys and its objects', () => {
    const config = read({ objects: ['Contact', 'Case'], acceptOutside: true });
    const reordered = Object.fromEntries(
      Object.entries(config).reverse(),
    ) as PipelineRewindStepConfig;
    expect(rewindGrantDigest(reordered)).toBe(rewindGrantDigest(config));
    expect(digest({ objects: ['Case', 'Contact'], acceptOutside: true })).toBe(
      rewindGrantDigest(config),
    );
  });

  it('is the same for an acceptance left out and the same one said no to', () => {
    expect(digest({ acceptAutomation: false, refuseWhenActive: true })).toBe(digest());
  });

  it('changes with every field of what the step does to the org', () => {
    const base = digest();
    const changes: Array<[string, Record<string, unknown>]> = [
      ['the org', { orgId: 'org-2' }],
      ['the checkpoint', { checkpointId: 'ck-20261023-020000-b2c3' }],
      ['the bound on records', { maxRecords: 501 }],
      ['the objects named', { objects: ['Case'] }],
      ['the refusal when people are active', { refuseWhenActive: false }],
      ['accepting automation', { acceptAutomation: true }],
      ['accepting deletions Undo cannot bring back', { acceptNoUndo: true }],
      ['accepting records made again', { acceptRecreate: true }],
      ['accepting records outside', { acceptOutside: true }],
      ['accepting records out of sight', { acceptUnseen: true }],
    ];
    const digests = new Set([base]);
    for (const [what, patch] of changes) {
      const changed = digest(patch);
      expect(changed, what).not.toBe(base);
      digests.add(changed);
    }
    // Each change gives a digest of its own, none another's.
    expect(digests.size).toBe(changes.length + 1);
    expect(digest({ objects: ['Case', 'Contact'] })).not.toBe(digest({ objects: ['Case'] }));
  });

  it('is unchanged by what the step is called, described as, or a key the configuration does not define', () => {
    const config = read();
    const dressed = {
      ...config,
      name: 'Nightly reset',
      description: 'Back to the baseline every night',
      note: 'ask before Friday',
    } as PipelineRewindStepConfig;
    expect(rewindGrantDigest(dressed)).toBe(rewindGrantDigest(config));
    // Read through the schema, the keys it does not define are not kept at all.
    expect(
      rewindGrantDigest(
        pipelineRewindStepConfigSchema.parse({ ...rewindConfig(), name: 'Nightly reset' }),
      ),
    ).toBe(rewindGrantDigest(config));
  });
});

describe('approvalTimeoutMinutes', () => {
  it('waits an hour when the step says nothing', () => {
    expect(approvalTimeoutMinutes({})).toBe(APPROVAL_DEFAULT_TIMEOUT_MINUTES);
    expect(approvalTimeoutMinutes(undefined)).toBe(60);
  });

  it('takes a whole number of minutes from one up to a day', () => {
    expect(approvalTimeoutMinutes({ timeoutMinutes: 1 })).toBe(1);
    expect(approvalTimeoutMinutes({ timeoutMinutes: 1440 })).toBe(1440);
  });

  it('refuses no wait, a wait past a day, a fraction, and text', () => {
    for (const timeoutMinutes of [0, -5, 1441, 2.5, '30', Number.NaN]) {
      expect(approvalTimeoutMinutes({ timeoutMinutes })).toBeUndefined();
    }
  });
});

describe('approvalDefect', () => {
  it('finds nothing wrong with a step that names neither a wait nor a message', () => {
    expect(approvalDefect({})).toBeUndefined();
  });

  it('names the wait before the message', () => {
    expect(approvalDefect({ timeoutMinutes: 0, message: 42 })).toBe('timeout');
  });

  it('refuses a message that is not text, or longer than it may be', () => {
    expect(approvalDefect({ message: 42 })).toBe('message');
    expect(approvalDefect({ message: 'x'.repeat(APPROVAL_MAX_MESSAGE_LENGTH + 1) })).toBe(
      'message',
    );
    expect(approvalDefect({ message: 'Look at the comparison first.' })).toBeUndefined();
  });
});
