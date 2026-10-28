import { describe, expect, it } from 'vitest';

import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';
import { ANONYMIZATION_TEMPLATES } from '../src/bridge/templates/anonymizationTemplates.js';
import { LOCALE_DATA } from '../src/modules/seed/LocaleData.js';
import {
  ENV_SCHEMA_DESCRIPTIONS,
  ENV_SCHEMA_RECORD_KEYS,
  figure,
} from './env-schema-descriptions.js';
import { bareEnvFileJsonSchema, describeSchema, hoveredNodes } from './write-env-schema.js';

type Node = Record<string, unknown>;

/** The node of `schema` at `steps`, each a keyword or a key under it. */
function nodeAt(schema: Node, ...steps: Array<string | number>): Node {
  return steps.reduce<Node>(
    (at, step) => (at as Record<string | number, Node>)[step] as Node,
    schema,
  );
}

/** The texts, without the one at `path`. */
function without(path: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ENV_SCHEMA_DESCRIPTIONS).filter(([key]) => key !== path),
  );
}

describe('the texts of each key of sandforge.yaml', () => {
  it('give every key of the file’s schema a text, and none to a key it does not have', () => {
    const problems = describeSchema(bareEnvFileJsonSchema());

    expect(problems.missing).toEqual([]);
    expect(problems.orphaned).toEqual([]);
    // Every key, every key of a mapping the file names, every shape told by
    // its kind or its mode: 131 texts for the 120 keys the design counted.
    const own = hoveredNodes(bareEnvFileJsonSchema()).filter((node) => node.own);
    expect(own).toHaveLength(Object.keys(ENV_SCHEMA_DESCRIPTIONS).length);
    expect(own.length).toBeGreaterThanOrEqual(120);
  });

  it('name a key left without a text, and a text left without its key', () => {
    // Negative controls: one key dropped from the texts, one misspelt key added.
    const dropped = describeSchema(
      bareEnvFileJsonSchema(),
      without('resources.<name>{seed}.objects[].count'),
    );
    expect(dropped.missing).toEqual(['resources.<name>{seed}.objects[].count']);

    const misspelt = describeSchema(bareEnvFileJsonSchema(), {
      ...ENV_SCHEMA_DESCRIPTIONS,
      'resources.<name>{seed}.cout': 'How many records.',
    });
    expect(misspelt.missing).toEqual([]);
    expect(misspelt.orphaned).toEqual(['resources.<name>{seed}.cout']);
  });

  it('name every value of a key whose values are listed, in backticks', () => {
    expect(describeSchema(bareEnvFileJsonSchema()).unnamed).toEqual([]);

    // Negative controls: a kind of org, a version and a category of personal
    // field the texts do not name, one in each way a value is listed.
    const stage = bareEnvFileJsonSchema();
    (
      nodeAt(stage, 'properties', 'targets', 'properties', 'kinds', 'items')['enum'] as string[]
    ).push('stage');
    expect(describeSchema(stage).unnamed).toEqual([{ path: 'targets.kinds[]', values: ['stage'] }]);

    const later = bareEnvFileJsonSchema();
    nodeAt(later, 'properties', 'version')['const'] = 2;
    expect(describeSchema(later).unnamed).toEqual([{ path: 'version', values: ['2'] }]);

    const health = bareEnvFileJsonSchema();
    const forge = nodeAt(health, 'properties', 'resources', 'additionalProperties', 'oneOf', 1);
    const rules = nodeAt(forge, 'properties', 'anonymize', 'properties', 'rules');
    (nodeAt(rules, 'propertyNames')['enum'] as string[]).push('health');
    expect(describeSchema(health).unnamed).toEqual([
      { path: 'resources.<name>{forge}.anonymize.rules', values: ['health'] },
    ]);
  });

  it('name the templates and locales a key takes as the code has them, not as they once were', () => {
    // The lists are read from the code: a template that ships with a later
    // SandForge changes the text, and the shipped file is stale until written again.
    const seedTemplate = ENV_SCHEMA_DESCRIPTIONS['resources.<name>{seed}.template'] ?? '';
    for (const { id } of PREBUILT_SEED_TEMPLATES) expect(seedTemplate).toContain(`\`${id}\``);

    const maskTemplate = ENV_SCHEMA_DESCRIPTIONS['resources.<name>{mask}.rules{object}.template'];
    expect(ANONYMIZATION_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const { id } of ANONYMIZATION_TEMPLATES) expect(maskTemplate).toContain(`\`${id}\``);

    const locale = ENV_SCHEMA_DESCRIPTIONS['resources.<name>{seed}.locale'] ?? '';
    for (const name of Object.keys(LOCALE_DATA)) expect(locale).toContain(`\`${name}\``);
  });

  it('name each mapping whose keys the file chooses by a word its paths use', () => {
    const paths = new Set(hoveredNodes(bareEnvFileJsonSchema()).map((node) => node.path));
    for (const [mapping, word] of Object.entries(ENV_SCHEMA_RECORD_KEYS)) {
      expect(paths.has(`${mapping}.<${word}>`), mapping).toBe(true);
    }
  });

  it('say what the file holds, never an org, a user or a record of one', () => {
    // An Organization Id, a record id, a username: none belongs in a hover
    // every user of the extension reads.
    for (const [path, text] of Object.entries(ENV_SCHEMA_DESCRIPTIONS)) {
      expect(text, path).not.toMatch(/\b00D[A-Za-z0-9]{12}/);
      expect(text, path).not.toMatch(/\b[A-Za-z0-9]{3}[0-9][A-Za-z0-9]{11}(?:[A-Za-z0-9]{3})?\b/);
      expect(text, path).not.toMatch(/[\w.+-]+@[\w-]+\.(?!invalid\b)[a-z]{2,}/i);
    }
  });
});

describe('figure', () => {
  it('writes a whole number with its thousands grouped, whatever locale Node runs in', () => {
    expect(figure(200)).toBe('200');
    expect(figure(1_000)).toBe('1,000');
    expect(figure(1_000_000)).toBe('1,000,000');
    expect(figure(2 ** 32 - 1)).toBe('4,294,967,295');
    expect(figure(-12_345)).toBe('-12,345');
    expect(figure(0.01)).toBe('0.01');
  });
});
