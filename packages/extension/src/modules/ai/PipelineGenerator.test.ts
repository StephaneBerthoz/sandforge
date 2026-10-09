import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { PipelineGenerator, suggestionText, type OrgInfo } from './PipelineGenerator';
import type { AIProvider } from './types.js';

const testOrgs: OrgInfo[] = [
  { orgId: 'org-001', alias: 'production', type: 'production' },
  { orgId: 'org-002', alias: 'devbox', type: 'sandbox' },
  { orgId: 'org-003', alias: 'scratch01', type: 'scratch' },
];

describe('PipelineGenerator', () => {
  let mockProvider: Mock<AIProvider>;
  let generator: PipelineGenerator;

  beforeEach(() => {
    mockProvider = vi.fn<AIProvider>().mockResolvedValue('{}');
    generator = new PipelineGenerator(mockProvider);
  });

  // --- Keyword extraction ---

  /** The step types the step executor registers, as the Automation page lists them. */
  const RUNNABLE = ['delay', 'condition', 'backup', 'compare', 'precheck', 'notification'];

  it('draws a Backup step, which a pipeline runs, from a wish to back up', async () => {
    const pipeline = await generator.generatePipeline('backup accounts daily', testOrgs);
    expect(pipeline.steps.map((s) => s.type)).toEqual(['backup']);
    expect(pipeline.steps[0].config['objects']).toEqual(['Account']);
    expect(pipeline.schedule).toBe('0 0 * * *');
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('reads "back up" in two words as a wish to back up', async () => {
    const pipeline = await generator.generatePipeline('back up contact records', testOrgs);
    expect(pipeline.steps.map((s) => s.type)).toEqual(['backup']);
  });

  it.each([
    ['diff production and devbox', 'compare'],
    ['check the org every morning', 'precheck'],
    ['monitor devbox hourly', 'precheck'],
    ['alert me, then compare.', 'notification'],
  ])('draws from "%s" a %s step', async (description, type) => {
    const pipeline = await generator.generatePipeline(description, testOrgs);
    expect(pipeline.steps.map((s) => s.type)).toContain(type);
  });

  it.each([
    'backup accounts daily',
    'compare then sync account data and monitor',
    'anonymize contact email data, then back up and alert',
    'diff production and devbox, purge and seed, then check',
  ])('draws from "%s" only step types a pipeline runs', async (description) => {
    const pipeline = await generator.generatePipeline(description, testOrgs);
    expect(pipeline.steps.length).toBeGreaterThan(0);
    for (const step of pipeline.steps) expect(RUNNABLE).toContain(step.type);
  });

  it.each([
    ['sync accounts', 'sync'],
    ['generate test contact records', 'seed'],
    ['anonymize contact email data', 'dataops'],
    ['delete old cases', 'dataops'],
  ])(
    'draws no step from "%s", which writes to an org, and points to the %s page',
    async (description, page) => {
      const pipeline = await generator.generatePipeline(description, testOrgs);
      expect(pipeline.steps).toEqual([]);
      // A code and the page's key, which the page words in the reader's language.
      expect(pipeline.suggestions).toEqual([{ code: 'WRITES_TO_ORG', page }]);
      // The model is not asked: its draft would hold the step a pipeline refuses.
      expect(mockProvider).not.toHaveBeenCalled();
    },
  );

  it('keeps the steps it can run and says where the writing work runs', async () => {
    const pipeline = await generator.generatePipeline(
      'compare then sync account data and monitor',
      testOrgs,
    );
    expect(pipeline.steps.map((s) => s.type)).toEqual(['compare', 'precheck']);
    expect(pipeline.suggestions).toEqual([{ code: 'WRITES_TO_ORG', page: 'sync' }]);
  });

  it('gives one suggestion per page, however many of its words appear', async () => {
    const pipeline = await generator.generatePipeline('sync and synchronize data', testOrgs);
    expect(pipeline.suggestions).toHaveLength(1);
  });

  it('should not produce duplicate step types', async () => {
    const pipeline = await generator.generatePipeline('check and monitor and watch', testOrgs);
    expect(pipeline.steps.filter((s) => s.type === 'precheck')).toHaveLength(1);
  });

  // --- Org resolution ---

  it('puts the two orgs a comparison names under the ids its check reads', async () => {
    const pipeline = await generator.generatePipeline('compare production to devbox', testOrgs);
    const compareStep = pipeline.steps.find((s) => s.type === 'compare');
    expect(compareStep?.config['sourceOrgId']).toBe('org-001');
    expect(compareStep?.config['targetOrgId']).toBe('org-002');
  });

  it('puts the one org a backup names under orgId', async () => {
    const pipeline = await generator.generatePipeline('backup account in devbox', testOrgs);
    const backupStep = pipeline.steps.find((s) => s.type === 'backup');
    expect(backupStep?.config['orgId']).toBe('org-002');
  });

  // --- Salesforce object detection ---

  it('should detect Salesforce object names in description', async () => {
    const pipeline = await generator.generatePipeline(
      'backup account and contact records',
      testOrgs,
    );
    const backupStep = pipeline.steps.find((s) => s.type === 'backup');
    const objects = backupStep?.config['objects'] as string[];
    expect(objects).toContain('Account');
    expect(objects).toContain('Contact');
  });

  // --- Schedule extraction ---

  it('should extract daily schedule', async () => {
    const pipeline = await generator.generatePipeline('compare data daily', testOrgs);
    expect(pipeline.schedule).toBe('0 0 * * *');
  });

  it('should extract nightly schedule', async () => {
    const pipeline = await generator.generatePipeline('nightly backup of account', testOrgs);
    expect(pipeline.schedule).toBe('0 2 * * *');
  });

  // --- Trigger extraction ---

  it.each([
    'backup data on deploy to devbox',
    'backup data after deploy to devbox',
    'backup data on error',
    'backup data on change',
  ])(
    'draws no trigger from a wish no trigger that starts runs can meet: %s',
    async (description) => {
      // A Deployment Complete trigger starts nothing; a schedule or a refresh
      // trigger would start the pipeline at a time the wish did not name.
      const pipeline = await generator.generatePipeline(description, testOrgs);
      expect(pipeline.steps.some((s) => s.type === 'backup')).toBe(true);
      expect(pipeline.triggers).toBeUndefined();
    },
  );

  it('leaves out of a model draft every trigger that starts nothing', async () => {
    mockProvider.mockResolvedValue(
      JSON.stringify({
        name: 'x',
        steps: [{ name: 's', type: 'backup' }],
        triggers: ['deployment_complete', 'event', 'webhook', 'on_deploy', 'sandbox_refresh'],
      }),
    );
    const pipeline = await generator.generatePipeline('prepare the box', testOrgs);
    expect(mockProvider).toHaveBeenCalled();
    expect(pipeline.triggers).toEqual(['sandbox_refresh']);
  });

  it.each(['compare devbox with prod after refresh', 'compare devbox with prod on refresh'])(
    'draws a sandbox refresh trigger from a refresh, which SandForge notices: %s',
    async (description) => {
      const pipeline = await generator.generatePipeline(description, testOrgs);
      expect(pipeline.triggers).toContain('sandbox_refresh');
    },
  );

  it('keeps a sandbox refresh trigger the model puts in its draft', async () => {
    mockProvider.mockResolvedValue(
      JSON.stringify({
        name: 'x',
        steps: [{ name: 's', type: 'backup' }],
        triggers: ['sandbox_refresh', 'manual'],
      }),
    );
    const pipeline = await generator.generatePipeline('prepare the box', testOrgs);
    expect(mockProvider).toHaveBeenCalled();
    expect(pipeline.triggers).toEqual(['sandbox_refresh', 'manual']);
  });

  // --- Pipeline name ---

  it('should generate a descriptive pipeline name', async () => {
    const pipeline = await generator.generatePipeline('backup account data daily', testOrgs);
    expect(pipeline.name).toMatch(/^Pipeline_/);
    expect(pipeline.name.length).toBeGreaterThan('Pipeline_'.length);
  });

  // --- AI fallback ---

  it('should fall back to AI when no keywords match', async () => {
    mockProvider.mockResolvedValue(
      JSON.stringify({
        name: 'AI Pipeline',
        description: 'Generated by AI',
        steps: [{ name: 'step1', type: 'compare', config: {}, description: 'AI step' }],
      }),
    );

    const pipeline = await generator.generatePipeline(
      'do something very custom and unusual',
      testOrgs,
    );
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(pipeline.name).toBe('AI Pipeline');
    expect(pipeline.steps).toHaveLength(1);
  });

  it('reads the steps of a draft the model wrapped in a markdown fence', async () => {
    const draft = {
      name: 'Fenced Pipeline',
      steps: [{ name: 'step1', type: 'compare', config: {}, description: 'AI step' }],
    };
    mockProvider.mockResolvedValue(`\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``);

    const pipeline = await generator.generatePipeline('do something very unusual', testOrgs);

    expect(pipeline.name).toBe('Fenced Pipeline');
    expect(pipeline.steps).toEqual([
      { name: 'step1', type: 'compare', config: {}, description: 'AI step' },
    ]);
  });

  it('leaves out of a model draft every step a pipeline cannot run, and says why', async () => {
    mockProvider.mockResolvedValue(
      JSON.stringify({
        name: 'x',
        steps: [
          { name: 'a', type: 'sync', config: {}, description: '' },
          { name: 'b', type: 'backup', config: {}, description: '' },
          { name: 'c', type: 'monitor', config: {}, description: '' },
          { name: 'd', type: 'seed', config: {}, description: '' },
        ],
      }),
    );

    const pipeline = await generator.generatePipeline('prepare the box', testOrgs);

    expect(pipeline.steps.map((s) => s.type)).toEqual(['backup']);
    expect(pipeline.suggestions).toEqual([
      { code: 'WRITES_TO_ORG', page: 'sync' },
      { code: 'STEP_NOT_RUNNABLE', stepType: 'monitor' },
      { code: 'WRITES_TO_ORG', page: 'seed' },
    ]);
  });

  it('gives one suggestion per page a model draft names, however many of its steps do', async () => {
    mockProvider.mockResolvedValue(
      JSON.stringify({
        steps: [
          { name: 'a', type: 'anonymize', config: {}, description: '' },
          { name: 'b', type: 'delete', config: {}, description: '' },
          { name: 'c', type: 'compare', config: {}, description: '' },
        ],
      }),
    );

    const pipeline = await generator.generatePipeline('tidy the box', testOrgs);

    expect(pipeline.suggestions).toEqual([{ code: 'WRITES_TO_ORG', page: 'dataops' }]);
  });

  it('says each suggestion in English for the log', () => {
    expect(suggestionText({ code: 'WRITES_TO_ORG', page: 'dataops' })).toContain(
      'run it from the DataOps page',
    );
    expect(suggestionText({ code: 'STEP_NOT_RUNNABLE', stepType: 'monitor' })).toBe(
      'A pipeline cannot run a monitor step, so the draft leaves it out.',
    );
  });

  it('should return empty pipeline when AI returns invalid JSON', async () => {
    mockProvider.mockResolvedValue('not json');
    const pipeline = await generator.generatePipeline('something unusual', testOrgs);
    expect(pipeline.steps).toEqual([]);
  });

  it('should not call AI when keyword-based steps are found', async () => {
    await generator.generatePipeline('backup account data', testOrgs);
    expect(mockProvider).not.toHaveBeenCalled();
  });
});
