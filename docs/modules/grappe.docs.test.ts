/**
 * Doc/code drift guard for the Grappe setting page.
 *
 * Grappe had a page of its own: four counters, a "Run in progress" card and a
 * "How Grappe works" card, with a how-to that had the reader open it beside a
 * Seed and come back to it during the run. It named no module and no org, and
 * Seed, Sync and Autopilot already showed the same partitions, from the same
 * store, in their own run screens. The page is retired; the setting and the
 * panel of the run screens stay. `docs/modules/grappe.md` is the page of the
 * setting now: what the panel shows, in which runs, from which threshold, and
 * that it makes no run faster.
 *
 * Each test states the code it depends on, and fails first if that code moved.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the assertions below are LF-anchored and miss on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'grappe.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const MANIFEST = JSON.parse(source('packages/extension/package.json')) as {
  contributes: {
    configuration: { properties: Record<string, { default?: unknown }> };
    commands: Array<{ command: string }>;
  };
};
const EN = JSON.parse(source('packages/webview/src/i18n/locales/en.json')) as {
  grappe: Record<string, string>;
};

/** The run screens that mount the panel, each by the file that mounts it. */
const RUN_SCREENS = [
  ['Seed', 'packages/webview/src/pages/Seed/Step7_Execute.tsx', 'Execute step'],
  ['Sync', 'packages/webview/src/pages/Sync/SyncPage.tsx', 'Execute step'],
  ['Autopilot', 'packages/webview/src/pages/Autopilot/AutopilotPage.tsx', 'dependency graph'],
] as const;

/** A number as the page writes it: 10000 → "10,000". */
const written = (value: unknown): string => Number(value).toLocaleString('en-US');

describe('docs/modules/grappe.md', () => {
  it('is the page of a setting: no how-to, no page, no command, no shortcut', () => {
    expect(DOC).not.toContain('<!-- how-to:start');
    expect(DOC).not.toMatch(/Grappe page|page Grappe|Open Grappe|Ctrl\+Shift\+R|Ctrl\+7/i);
    expect(DOC).not.toMatch(/side panel|launcher/i);
    // Anchor: the page and its command are gone from the code too.
    expect(MANIFEST.contributes.commands.map((c) => c.command)).not.toContain(
      'sandforge.openGrappe',
    );
    expect(source('packages/webview/src/PanelRouter.tsx')).not.toContain('pages/Grappe/');
  });

  it('names the three settings, with the defaults the manifest declares', () => {
    const props = MANIFEST.contributes.configuration.properties;
    expect(props['sandforge.grappe.enabled']?.default).toBe(false);
    expect(DOC).toContain('`sandforge.grappe.enabled`');
    expect(DOC).toMatch(/off by default/);
    for (const key of ['autoActivateThreshold', 'grappeSize']) {
      const setting = `sandforge.grappe.${key}`;
      expect(props[setting], setting).toBeDefined();
      expect(DOC).toContain(`\`${setting}\``);
      expect(DOC, setting).toContain(`${written(props[setting]?.default)} by default`);
    }
  });

  it('says where the panel is read: in the run screen of each module that mounts it', () => {
    for (const [module, file, where] of RUN_SCREENS) {
      expect(source(file), file).toContain("from '../../components/GrappeProgressPanel'");
      expect(DOC, module).toMatch(new RegExp(`\\*\\*${module}\\*\\*[^\\n]*${where}`));
    }
  });

  it('names what the panel shows in the words it shows them', () => {
    const panel = source('packages/webview/src/components/GrappeProgressPanel.tsx');
    for (const key of ['partitions', 'totalRecords', 'completed']) {
      expect(panel).toContain(`'grappe.${key}'`);
      expect(DOC, key).toContain(`**${EN.grappe[key]}**`);
    }
    expect(panel).toContain("'grappe.processedCount'");
    expect(panel).toContain("'grappe.failedCount'");
    expect(DOC).toMatch(/processed and failed/);
  });

  it('says an Autopilot run is reported at its start and its end only', () => {
    // executePlan brackets the run with grappe:started and grappe:completed,
    // and reports no partition in between.
    const autopilot = source('packages/extension/src/modules/autopilot/AutopilotOrchestrator.ts');
    expect(autopilot).toMatch(/type: 'grappe:started',/);
    expect(autopilot).toMatch(/type: 'grappe:completed',/);
    expect(autopilot).not.toMatch(/type: 'grappe:partitionProgress',/);
    expect(DOC).toMatch(/\*\*Autopilot\*\*[^\n]*only its start and its end/);
  });

  it('says Grappe makes no run faster', () => {
    expect(DOC).toContain('Grappe does not make a run faster');
    expect(DOC).toMatch(/sequential/);
  });
});
