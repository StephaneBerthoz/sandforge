import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { PIPELINE_FILE_SETTINGS } from '@sandforge/shared';

/**
 * The settings a pipeline file carries (`PIPELINE_FILE_SETTINGS` in shared)
 * are settings of the extension, each with the type and the bounds the
 * manifest holds it to. A file read past those bounds would run a pipeline
 * with a value the editor could not have been given; a setting renamed in the
 * manifest alone would travel in the file and be read by nothing.
 */

interface ContributedSetting {
  type: string;
  minimum?: number;
  maximum?: number;
}

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, ContributedSetting> } };
};

const contributed = manifest.contributes.configuration.properties;

describe('the settings a pipeline file carries', () => {
  it('are settings of the extension, with the type and the bounds the manifest gives them', () => {
    for (const [key, rule] of Object.entries(PIPELINE_FILE_SETTINGS)) {
      const setting = contributed[`sandforge.${key}`];
      expect(setting, key).toBeDefined();
      expect(
        { type: setting.type, minimum: setting.minimum, maximum: setting.maximum },
        key,
      ).toEqual({ type: rule.type, minimum: rule.minimum, maximum: rule.maximum });
    }
  });
});
