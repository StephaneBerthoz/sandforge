import { describe, it, expect } from 'vitest';
import { BUILTIN_PIPELINE_TEMPLATES } from './pipeline-marketplace.js';

describe('BUILTIN_PIPELINE_TEMPLATES', () => {
  it('gives each template its own id, a name, a description and at least one step', () => {
    const ids = BUILTIN_PIPELINE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of BUILTIN_PIPELINE_TEMPLATES) {
      expect(template.name.trim()).not.toBe('');
      expect(template.description.trim()).not.toBe('');
      expect(template.steps.length).toBeGreaterThan(0);
    }
  });

  it('holds no step a pipeline never runs: no Restore, no Delete', () => {
    // The Emergency Rollback, the Stale Data Cleanup and others held one, and
    // installed, their pipeline never started.
    const types = BUILTIN_PIPELINE_TEMPLATES.flatMap((template) =>
      template.steps.map((step) => step.type),
    );
    expect(types).not.toContain('restore');
    expect(types).not.toContain('delete');
  });

  it('names no object a backup cannot take, and masks and seeds with a template that ships', () => {
    for (const step of BUILTIN_PIPELINE_TEMPLATES.flatMap((template) => template.steps)) {
      if (step.type === 'backup') {
        for (const object of step.config['objects'] as string[]) {
          expect(object).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
          expect(object).not.toMatch(/^__/);
        }
      }
      if (step.type === 'anonymize') expect(step.config['templateId']).toMatch(/^tpl-/);
      if (step.type === 'seed') expect(step.config['templateId']).toMatch(/^prebuilt-/);
    }
  });
});
