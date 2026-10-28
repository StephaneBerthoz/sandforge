import { describe, expect, it } from 'vitest';

import {
  PIPELINE_MASKING_REFUSAL,
  pipelineMaskingAsked,
  pipelineMaskingTierRefusal,
} from './anonymizePipeline.js';
import { PIPELINE_SEED_REFUSAL } from './seedPipeline.js';

/** The templates the tests know: one that ships, and nothing else. */
const shipped = (templateId: string): boolean => templateId === 'tpl-gdpr-standard';

describe('pipelineMaskingTierRefusal', () => {
  it('refuses a production org whatever the Approval step answered', () => {
    for (const approved of [true, false]) {
      const refusal = pipelineMaskingTierRefusal('production', { approved }, 'my-org');
      expect(refusal?.code).toBe(PIPELINE_MASKING_REFUSAL.production);
      expect(refusal?.message).toMatch(/^my-org is a production org.*Nothing was masked\.$/);
    }
  });

  it('refuses a sandbox marked Staging that no Approval approved, and lets it through once one did', () => {
    expect(pipelineMaskingTierRefusal('staging', { approved: false }, 'uat')?.code).toBe(
      PIPELINE_MASKING_REFUSAL.needsApproval,
    );
    expect(pipelineMaskingTierRefusal('staging', { approved: true }, 'uat')).toBeUndefined();
  });

  it('lets a Developer Edition or a scratch org through with no Approval', () => {
    expect(pipelineMaskingTierRefusal('development', { approved: false }, 'dev')).toBeUndefined();
    expect(pipelineMaskingTierRefusal('scratch', { approved: false }, 'scratch')).toBeUndefined();
  });

  it("refuses with the codes a pipeline's Seed is refused with, so the page words both alike", () => {
    expect(PIPELINE_MASKING_REFUSAL.orgUnknown).toBe(PIPELINE_SEED_REFUSAL.orgUnknown);
    expect(PIPELINE_MASKING_REFUSAL.production).toBe(PIPELINE_SEED_REFUSAL.production);
    expect(PIPELINE_MASKING_REFUSAL.needsApproval).toBe(PIPELINE_SEED_REFUSAL.needsApproval);
  });
});

describe('pipelineMaskingAsked', () => {
  const asked = (request: Partial<Parameters<typeof pipelineMaskingAsked>[0]> = {}) =>
    pipelineMaskingAsked({ orgId: 'org-1', templateId: 'tpl-gdpr-standard', ...request }, shipped);

  it('asks for a snapshot whatever the step says, with the object and the condition it holds to', () => {
    expect(asked({ object: 'Contact', where: " LastName LIKE 'A%' " })).toEqual({
      asked: {
        orgId: 'org-1',
        templateId: 'tpl-gdpr-standard',
        objects: ['Contact'],
        where: "LastName LIKE 'A%'",
        snapshot: true,
      },
    });
    expect(asked()).toEqual({
      asked: { orgId: 'org-1', templateId: 'tpl-gdpr-standard', snapshot: true },
    });
  });

  it('refuses a step given retries, and takes the same step given none', () => {
    const refused = asked({ retries: 1 });
    expect('refusal' in refused && refused.refusal.code).toBe(PIPELINE_MASKING_REFUSAL.retries);
    expect('asked' in asked({ retries: 0 })).toBe(true);
  });

  it('refuses a condition with no object, and takes the same condition with one', () => {
    const refused = asked({ where: "LastName LIKE 'A%'" });
    expect('refusal' in refused && refused.refusal.code).toBe(
      PIPELINE_MASKING_REFUSAL.filterNeedsObject,
    );
    expect('asked' in asked({ where: "LastName LIKE 'A%'", object: 'Contact' })).toBe(true);
    // A blank condition filters nothing, as on the page.
    expect('asked' in asked({ where: '  ' })).toBe(true);
  });

  it('refuses a condition the page would refuse, one that goes on past the filter', () => {
    const refused = asked({ object: 'Contact', where: "LastName LIKE 'A%' LIMIT 1" });
    expect('refusal' in refused && refused.refusal.code).toBe(PIPELINE_MASKING_REFUSAL.invalid);
    expect('refusal' in refused && refused.refusal.message).toMatch(/^The masking step is not/);
  });

  it('refuses a template neither shipped nor saved, and takes one that is', () => {
    const refused = asked({ templateId: 'tpl-deleted' });
    expect('refusal' in refused && refused.refusal.code).toBe(
      PIPELINE_MASKING_REFUSAL.templateMissing,
    );
    expect('refusal' in refused && refused.refusal.message).toContain('tpl-deleted');
  });
});
