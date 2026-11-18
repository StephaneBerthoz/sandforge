import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type React from 'react';
import { describe, expect, it } from 'vitest';
import { ChartColumn, ListChecks } from 'lucide-react';

import en from '../i18n/locales/en.json';
import { ALL_ROUTES } from '../stores/useAppStore';
import { HELP_SECTIONS } from '../pages/Help/HelpPage';
import { MODULE_ITEMS, NAV_GROUPS, TOOL_ITEMS, isNavItemShown } from './navGroups';

/** The value at a dotted key of the English catalogue, or undefined. */
function english(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
}

/** The component an item's icon draws. */
const drawn = (icon: React.ReactNode): unknown => (icon as React.ReactElement).type;

describe('NAV_GROUPS', () => {
  it('groups the modules by what they are for, in a fixed order, filling an org first', () => {
    expect(NAV_GROUPS.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ['fill', ['seed', 'frozen']],
      ['copy', ['forge', 'sync', 'autopilot', 'migration']],
      ['protect', ['recovery', 'checkpoint', 'dataops']],
      ['watch', ['monitor', 'compare', 'reports']],
      ['automate', ['automation', 'ai']],
    ]);
  });

  it('names each group and each module by a key of the catalogue', () => {
    for (const group of NAV_GROUPS) {
      expect(group.labelKey).toBe(`sidePanel.group.${group.id}`);
      expect(typeof english(group.labelKey), group.labelKey).toBe('string');
      for (const item of group.items) {
        expect(item.labelKey).toBe(`nav.${item.id}`);
        expect(typeof english(item.labelKey), item.labelKey).toBe('string');
      }
    }
  });

  it('shows Back into service once a sandbox is registered, and every other module always', () => {
    // Grappe was listed while its setting was on; its page is retired, and
    // its progress is read in the run screens of Seed, Sync and Autopilot.
    const conditional = MODULE_ITEMS.filter((item) => item.shownWhen !== undefined).map(
      ({ id, shownWhen }) => [id, shownWhen],
    );
    expect(conditional).toEqual([['recovery', 'sandboxRegistered']]);

    const recovery = MODULE_ITEMS.find((item) => item.id === 'recovery');
    const seed = MODULE_ITEMS.find((item) => item.id === 'seed');
    if (!recovery || !seed) throw new Error('a module is missing');
    const none = { sandboxRegistered: false };
    expect(isNavItemShown(seed, none)).toBe(true);
    expect(isNavItemShown(recovery, none)).toBe(false);
    expect(isNavItemShown(recovery, { sandboxRegistered: true })).toBe(true);
  });

  it('draws Reports with the icon Help draws it with, and Back into service with a checklist', () => {
    const reports = MODULE_ITEMS.find((item) => item.id === 'reports');
    expect(drawn(reports?.icon)).toBe(ChartColumn);
    expect(HELP_SECTIONS.find((section) => section.id === 'reports')?.icon).toBe(ChartColumn);
    expect(drawn(MODULE_ITEMS.find((item) => item.id === 'recovery')?.icon)).toBe(ListChecks);
  });

  it('gives every module its colour', () => {
    expect(MODULE_ITEMS.filter((item) => !item.accent?.startsWith('text-hue-'))).toEqual([]);
  });
});

describe('MODULE_ITEMS and TOOL_ITEMS', () => {
  it('list every module once, in the groups’ order, then the three tools', () => {
    expect(MODULE_ITEMS).toEqual(NAV_GROUPS.flatMap((group) => group.items));
    expect(TOOL_ITEMS.map((item) => item.id)).toEqual(['orgs', 'settings', 'help']);
    const ids = [...MODULE_ITEMS, ...TOOL_ITEMS].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens a route the panel knows, for every row', () => {
    const routes: readonly string[] = ALL_ROUTES;
    for (const item of [...MODULE_ITEMS, ...TOOL_ITEMS]) expect(routes).toContain(item.id);
  });
});

describe('the file the launcher bundles', () => {
  const source = readFileSync(join(__dirname, 'navGroups.tsx'), 'utf8');

  it('imports nothing but its icons, so the launcher stays out of the pages', () => {
    const imports = [...source.matchAll(/^import (type )?[^;]*?from '([^']+)';/gm)]
      .filter(([, typeOnly]) => typeOnly === undefined)
      .map(([, , from]) => from);
    expect(imports).toEqual(['lucide-react']);
  });

  it('writes each row as `id`, `labelKey`, `icon`, which the guides and Help read from the text', () => {
    const rows = [...source.matchAll(/id: '([\w-]+)',\s*labelKey: '[^']+',\s*icon: <(\w+)/g)].map(
      ([, id]) => id,
    );
    expect(rows).toEqual([...MODULE_ITEMS, ...TOOL_ITEMS].map((item) => item.id));
  });
});
