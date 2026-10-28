import { describe, it, expect } from 'vitest';
import { guardTierOf, type GuardTier } from './org-kind';
import { pipelineWriteVerdict } from './pipelineWriteVerdict';

describe('pipelineWriteVerdict', () => {
  it('refuses a production org, which no answer lets a pipeline write into', () => {
    expect(pipelineWriteVerdict('production')).toBe('refused');
  });

  it('asks an Approval step before a write into a sandbox marked Staging', () => {
    expect(pipelineWriteVerdict('staging')).toBe('needsApproval');
  });

  it('lets a pipeline write into a sandbox, a scratch org or a Developer Edition org', () => {
    expect(pipelineWriteVerdict('development')).toBe('allowed');
    expect(pipelineWriteVerdict('scratch')).toBe('allowed');
  });

  it('refuses an org the registry does not know or cannot type, read as production', () => {
    expect(pipelineWriteVerdict(guardTierOf(undefined))).toBe('refused');
    expect(pipelineWriteVerdict(guardTierOf({ orgType: 'Trial' }))).toBe('refused');
  });

  it('reads a Developer Edition registered as production as the development org it is', () => {
    expect(
      pipelineWriteVerdict(
        guardTierOf({ orgType: 'Production', metadata: { edition: 'Developer Edition' } }),
      ),
    ).toBe('allowed');
  });

  it('reads the Staging mark of a sandbox, and of a sandbox alone', () => {
    expect(pipelineWriteVerdict(guardTierOf({ orgType: 'Sandbox', staging: true }))).toBe(
      'needsApproval',
    );
    expect(pipelineWriteVerdict(guardTierOf({ orgType: 'Scratch', staging: true }))).toBe(
      'allowed',
    );
  });

  it('refuses a tier the guard does not know', () => {
    expect(pipelineWriteVerdict('constructor' as GuardTier)).toBe('refused');
  });
});
