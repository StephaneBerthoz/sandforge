import { describe, it, expect } from 'vitest';
import { TEMPLATE_FIELD_PATTERN } from '@sandforge/shared';
import type { AnonymizationTemplateRule } from '@sandforge/shared';

import { ANONYMIZATION_TEMPLATES } from './anonymizationTemplates.js';

/** The methods the DataOps masking engine applies; any other name is left as it is. */
const ENGINE_METHODS = [
  'mask',
  'hash',
  'fake',
  'nullify',
  'shuffle',
  'truncate',
  'constant',
  'preserve_format',
];

/** Every rule of every template that ships, named by template and field. */
const RULES: Array<[string, AnonymizationTemplateRule]> = ANONYMIZATION_TEMPLATES.flatMap(
  (template) =>
    template.rules.map((rule): [string, AnonymizationTemplateRule] => [
      `${template.name} ${rule.fieldPattern}`,
      rule,
    ]),
);

describe('the masking templates that ship', () => {
  it.each(RULES)('%s names its field Object.Field, with a method DataOps applies', (_, rule) => {
    expect(rule.fieldPattern).toMatch(TEMPLATE_FIELD_PATTERN);
    expect(ENGINE_METHODS).toContain(rule.ruleType);
  });

  it('gives every constant the value it writes and every truncation the length it keeps', () => {
    // Without them the run wrote an empty website and emptied every postal
    // code, under names that promise a placeholder and a shortened code.
    const constants = RULES.filter(([, r]) => r.ruleType === 'constant');
    const truncations = RULES.filter(([, r]) => r.ruleType === 'truncate');
    expect(constants.length + truncations.length).toBeGreaterThan(0);
    for (const [where, rule] of constants) {
      expect(rule.config?.constantValue ?? '', where).toMatch(/\S/);
    }
    for (const [where, rule] of truncations) {
      expect(rule.config?.truncateLength ?? 0, where).toBeGreaterThan(0);
    }
  });

  it('carries no salt: the run supplies the key a hash is made with', () => {
    // A salt in a template ships to everyone who installs SandForge, and
    // anyone holding it can hash a list of addresses and match the digests.
    for (const [where, rule] of RULES) {
      expect(Object.keys(rule.config ?? {}), where).not.toContain('hashSalt');
    }
  });
});
