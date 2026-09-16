/**
 * Doc/code drift guard for the Sync module page.
 *
 * Two claims of `docs/modules/sync.md` outlived the code they described. The
 * feature list sold "5 Conflict Strategies -- ... manual merge ...", while the
 * page offers no tab on which a conflict could be reviewed and the strategy of
 * that name resolves to the source values like source wins. It also called
 * transforms "configurable per-field or per-object", while the only rules a
 * screen can produce are object-level ones that rewrite every field of every
 * record. And nothing said that Grappe's threshold is measured with one
 * `SELECT COUNT()` per object, sent before the run and paid for out of the
 * org's daily API budget.
 *
 * Each test states the code it depends on, and fails first if that code moved:
 * an assertion about a page that no longer works this way proves nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the assertions below are LF-anchored and miss on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'sync.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const SYNC_PAGE = source('packages/webview/src/pages/Sync/SyncPage.tsx');
const SYNC_HANDLER = source('packages/extension/src/bridge/handlers/SyncOpsHandler.ts');
const TRANSFORM_PIPELINE = source('packages/extension/src/modules/sync/TransformPipeline.ts');
const TRANSFORM_BUILDER = source('packages/webview/src/pages/Sync/TransformBuilder.tsx');

/** The tabs the page offers, as the array it renders them from. */
const OFFERED_TABS = /const OFFERED_SYNC_TABS: readonly SyncTab\[\] = \[([^\]]*)\]/.exec(SYNC_PAGE);

describe('docs/modules/sync.md', () => {
  it('does not sell a conflict review while the page offers no conflicts tab', () => {
    // Positive control: the tab list is where the page says what it offers. If
    // this match is gone the assertion below is about nothing.
    expect(OFFERED_TABS).not.toBeNull();
    expect(OFFERED_TABS?.[1]).not.toContain("'conflicts'");

    expect(DOC).not.toContain('5 Conflict Strategies');
    expect(DOC).not.toContain('manual merge');
  });

  it('names the four strategies a run acts on', () => {
    for (const strategy of ['Source wins', 'target wins', 'newest wins', 'merge']) {
      expect(DOC).toContain(strategy);
    }
    expect(DOC).toContain('Manual review is not offered');
  });

  it('says a transform rule reaches every field but the one the write matches on', () => {
    // Positive control: the rule loop walks every key of the record, and skips
    // the two the write is addressed by.
    expect(TRANSFORM_PIPELINE).toContain('for (const rule of objectConfig.transformRules)');
    expect(TRANSFORM_PIPELINE).toContain('for (const key of Object.keys(result))');
    expect(TRANSFORM_PIPELINE).toContain(
      "const matchField = objectConfig.externalIdField ?? 'Id';",
    );
    expect(TRANSFORM_PIPELINE).toContain("if (key === matchField || key === 'Id') continue;");

    expect(DOC).toContain('applies to all fields of all objects in the run, except');
    expect(DOC).not.toContain('Configurable per-field or per-object');
  });

  it('says what a formula rule does, and that no rule branches', () => {
    // Positive control: the only formula the pipeline evaluates is the token
    // substitution, and the handler table holds no conditional kind.
    expect(TRANSFORM_PIPELINE).toContain("formula.includes('VALUE')");
    expect(TRANSFORM_PIPELINE).not.toContain('conditional:');

    expect(DOC).toContain('substitutes the field value into the token');
    expect(DOC).toContain('There is no conditional rule');
    expect(DOC).not.toContain('Conditional logic');
  });

  it('says a value mapping rule has no box to fill and so does nothing', () => {
    // Positive control: the type is offered, and the builder's settings table
    // has no entry for it, so the rule can only go out with an empty config.
    expect(TRANSFORM_BUILDER).toContain("'map_value'");
    const configFields = /const CONFIG_FIELDS: Record<string, string\[\]> = \{([^}]*)\}/.exec(
      TRANSFORM_BUILDER,
    );
    expect(configFields).not.toBeNull();
    expect(configFields?.[1]).not.toContain('map_value');

    expect(DOC).toContain('Value mapping takes a table of replacements');
  });

  it('says the Grappe count costs one API request per object', () => {
    // Positive control: the count the sentence is about, as the handler sends
    // it before the run.
    expect(SYNC_HANDLER).toContain('`SELECT COUNT() FROM ${safeObj}`');

    expect(DOC).toContain('`SELECT COUNT()` per object');
    expect(DOC).toContain("counts against the org's daily API request limit");
    expect(DOC).toContain('`sandforge.grappe.enabled`');
  });
});
