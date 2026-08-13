import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXAMPLES_DIR = fileURLToPath(new URL('.', import.meta.url));

const PIPELINES = ['github-actions.yml', 'gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'];

/**
 * `pnpm build:shared` emits the `@sandforge/shared` dist/ that every other
 * package imports, so anything reading those types has to run after it.
 * `pnpm validate` chains it first; a hand-rolled stage may not.
 */
const BUILDS_SHARED = /pnpm (?:validate|build:shared)\b/;
const NEEDS_SHARED = /pnpm (?:typecheck|lint|test)\b/;

/**
 * Only the lines the CI platform executes. The `#` / `//` header blocks of
 * these examples name the very commands under test, so a raw file scan would
 * grade the prose instead of the pipeline.
 */
function commandLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('//'));
}

function read(name: string): string {
  // Normalised: the assertions are LF-anchored and miss on a CRLF checkout.
  return readFileSync(join(EXAMPLES_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

describe('ci-examples quality stage', () => {
  describe.each(PIPELINES)('%s', (pipeline) => {
    it('runs the quality gates through pnpm validate', () => {
      const runs = commandLines(read(pipeline)).filter((line) => BUILDS_SHARED.test(line));

      expect(runs.some((line) => line.includes('pnpm validate'))).toBe(true);
    });

    it('builds @sandforge/shared before anything that consumes it', () => {
      const lines = commandLines(read(pipeline));
      const firstBuild = lines.findIndex((line) => BUILDS_SHARED.test(line));
      const firstConsumer = lines.findIndex((line) => NEEDS_SHARED.test(line));

      if (firstConsumer === -1) {
        return;
      }
      expect(firstBuild).toBeGreaterThan(-1);
      expect(firstBuild).toBeLessThan(firstConsumer);
    });
  });

  it('documents the same command order in README.md', () => {
    const bullet = read('README.md')
      .split(/\r?\n/)
      .find((line) => line.includes('**Quality gates**'));

    expect(bullet).toBeDefined();
    expect(bullet).toContain('pnpm validate');

    const build = bullet?.indexOf('pnpm build:shared') ?? -1;
    const typecheck = bullet?.indexOf('pnpm typecheck') ?? -1;
    expect(build).toBeGreaterThan(-1);
    if (typecheck !== -1) {
      expect(build).toBeLessThan(typecheck);
    }
  });
});
