import { describe, expect, it } from 'vitest';
import type { SeedTemplate } from '@sandforge/shared';
import { CRM_STARTER } from '@sandforge/shared';

import {
  PIPELINE_SEED_REFUSAL,
  aiRuleFields,
  pipelineSeedAsked,
  pipelineSeedTierRefusal,
} from './seedPipeline.js';

/** A template the Seed page saved: five accounts, named by Faker. */
function savedTemplate(extra: Partial<SeedTemplate> = {}): SeedTemplate {
  return {
    id: 'tpl-saved',
    name: 'Five accounts',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 5,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [
          { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company' } },
        ],
      },
    ],
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

/** The same template with its name filled by an AI rule. */
function withAiName(): SeedTemplate {
  const template = savedTemplate();
  return {
    ...template,
    objects: [
      {
        ...template.objects[0],
        fieldRules: [{ fieldApiName: 'Name', ruleType: 'ai_generate', config: { aiPrompt: 'x' } }],
      },
    ],
  };
}

describe('pipelineSeedTierRefusal', () => {
  it('refuses a production org whatever the Approval step answered', () => {
    for (const approved of [true, false]) {
      const refusal = pipelineSeedTierRefusal('production', { approved }, 'my-org');
      expect(refusal?.code).toBe(PIPELINE_SEED_REFUSAL.production);
      expect(refusal?.message).toMatch(/^my-org is a production org.*Nothing was written\.$/);
    }
  });

  it('refuses a sandbox marked Staging that no Approval step approved, and lets one approved through', () => {
    expect(pipelineSeedTierRefusal('staging', { approved: false }, 'uat')?.code).toBe(
      PIPELINE_SEED_REFUSAL.needsApproval,
    );
    expect(pipelineSeedTierRefusal('staging', { approved: true }, 'uat')).toBeUndefined();
  });

  it('lets a sandbox, a scratch org or a Developer Edition org through without an approval', () => {
    expect(pipelineSeedTierRefusal('development', { approved: false }, 'dev')).toBeUndefined();
    expect(pipelineSeedTierRefusal('scratch', { approved: false }, 'scratch')).toBeUndefined();
  });
});

describe('aiRuleFields', () => {
  it('names each field an AI rule fills, by its object', () => {
    expect(aiRuleFields(withAiName())).toEqual(['Account.Name']);
  });

  it('names none for a template of Faker rules', () => {
    expect(aiRuleFields(savedTemplate())).toEqual([]);
  });
});

describe('pipelineSeedAsked', () => {
  const none = (): SeedTemplate | undefined => undefined;

  it('reads the template the Seed page saved under the id, as a request of the page reads', () => {
    const chosen = pipelineSeedAsked('org-1', 'tpl-saved', (id) =>
      id === 'tpl-saved' ? savedTemplate() : undefined,
    );
    if (!('asked' in chosen)) throw chosen.refusal;
    expect(chosen.asked.orgId).toBe('org-1');
    expect(chosen.asked.template).toMatchObject({ name: 'Five accounts' });
    expect(chosen.asked.template.objects[0]).toMatchObject({ objectApiName: 'Account' });
  });

  it('reads a template SandForge ships by its id', () => {
    const chosen = pipelineSeedAsked('org-1', CRM_STARTER.id, none);
    if (!('asked' in chosen)) throw chosen.refusal;
    expect(chosen.asked.template.name).toBe(CRM_STARTER.name);
  });

  it('takes the saved template before the shipped one of the same id', () => {
    const chosen = pipelineSeedAsked('org-1', CRM_STARTER.id, () =>
      savedTemplate({ id: CRM_STARTER.id, name: 'Mine' }),
    );
    if (!('asked' in chosen)) throw chosen.refusal;
    expect(chosen.asked.template.name).toBe('Mine');
  });

  it('refuses a template no longer saved, naming its id', () => {
    const chosen = pipelineSeedAsked('org-1', 'tpl-deleted', none);
    if (!('refusal' in chosen)) throw new Error('read a template nobody saved');
    expect(chosen.refusal.code).toBe(PIPELINE_SEED_REFUSAL.templateMissing);
    expect(chosen.refusal.message).toContain('tpl-deleted');
  });

  it('refuses a saved template that no longer reads, with where and why', () => {
    const broken = savedTemplate();
    broken.objects[0] = { ...broken.objects[0], objectApiName: "Account' OR Name != '" };
    const chosen = pipelineSeedAsked('org-1', 'tpl-saved', () => broken);
    if (!('refusal' in chosen)) throw new Error('read a template the page would refuse');
    expect(chosen.refusal.code).toBe(PIPELINE_SEED_REFUSAL.templateInvalid);
    expect(chosen.refusal.message).toMatch(
      /^The Seed template "Five accounts" no longer validates \(objects\.0\.objectApiName: /,
    );
  });

  it('refuses a template with an AI rule, naming the field, and reads the same with a Faker rule', () => {
    const ai = pipelineSeedAsked('org-1', 'tpl-saved', withAiName);
    if (!('refusal' in ai)) throw new Error('read a template whose rule sends to the AI');
    expect(ai.refusal.code).toBe(PIPELINE_SEED_REFUSAL.templateUsesAi);
    expect(ai.refusal.message).toContain('fills Account.Name with AI rules');

    expect('asked' in pipelineSeedAsked('org-1', 'tpl-saved', () => savedTemplate())).toBe(true);
  });
});
