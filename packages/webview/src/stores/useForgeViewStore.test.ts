import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  FORGE_GRAPH_MAX_OBJECTS,
  FORGE_GRAPH_SLOW_OBJECTS,
  forgeGraphIsLarge,
  forgeObjectsView,
  useForgeViewStore,
} from './useForgeViewStore';

describe('forgeObjectsView', () => {
  it('draws a graph of up to the threshold as a graph under auto, and lists a larger one', () => {
    expect(forgeObjectsView('auto', null, FORGE_GRAPH_MAX_OBJECTS)).toBe('graph');
    expect(forgeObjectsView('auto', null, FORGE_GRAPH_MAX_OBJECTS + 1)).toBe('table');
    expect(forgeObjectsView('auto', null, 400)).toBe('table');
  });

  it('shows what the setting names when it names a view, whatever the graph holds', () => {
    expect(forgeObjectsView('graph', null, 400)).toBe('graph');
    expect(forgeObjectsView('table', null, 2)).toBe('table');
  });

  it('shows the view picked with the switch over the setting', () => {
    expect(forgeObjectsView('table', 'graph', 100)).toBe('graph');
    expect(forgeObjectsView('auto', 'table', 2)).toBe('table');
  });

  // A graph picked on a run of a dozen objects, or set, drew 1,950 of them.
  it('lists a large graph unless the graph was picked on a large one', () => {
    expect(forgeObjectsView('graph', null, 400, true)).toBe('table');
    expect(forgeObjectsView('auto', 'graph', 400, true, false)).toBe('table');
    expect(forgeObjectsView('auto', 'graph', 400, true, true)).toBe('graph');
    expect(forgeObjectsView('graph', 'table', 400, true, true)).toBe('table');
  });
});

describe('forgeGraphIsLarge', () => {
  it('holds past the objects a graph is drawn of, and of every clone of the whole org', () => {
    expect(forgeGraphIsLarge(FORGE_GRAPH_SLOW_OBJECTS)).toBe(false);
    expect(forgeGraphIsLarge(FORGE_GRAPH_SLOW_OBJECTS + 1)).toBe(true);
    expect(forgeGraphIsLarge(3, true)).toBe(true);
  });
});

describe('useForgeViewStore', () => {
  beforeEach(() => {
    useForgeViewStore.setState({ setting: 'auto', choice: null, choiceOnLarge: false });
  });

  it('takes each value the setting offers', () => {
    for (const value of ['table', 'graph', 'auto'] as const) {
      useForgeViewStore.getState().adoptSetting(value);
      expect(useForgeViewStore.getState().setting).toBe(value);
    }
  });

  it('keeps the setting it holds when a message names none, or a value the setting does not offer', () => {
    useForgeViewStore.getState().adoptSetting('table');

    useForgeViewStore.getState().adoptSetting(undefined);
    useForgeViewStore.getState().adoptSetting('list');

    expect(useForgeViewStore.getState().setting).toBe('table');
  });

  it('keeps the view picked with the switch when the setting changes afterwards', () => {
    useForgeViewStore.getState().choose('graph');
    useForgeViewStore.getState().adoptSetting('table');

    const { setting, choice } = useForgeViewStore.getState();
    expect(forgeObjectsView(setting, choice, 100)).toBe('graph');
  });

  it('keeps whether the view was picked on a large graph', () => {
    useForgeViewStore.getState().choose('graph', true);
    expect(useForgeViewStore.getState().choiceOnLarge).toBe(true);
    useForgeViewStore.getState().choose('table');
    expect(useForgeViewStore.getState().choiceOnLarge).toBe(false);
  });
});

describe('the setting as it is described', () => {
  const REPO = join(__dirname, '..', '..', '..', '..');
  const EXTENSION = join(REPO, 'packages', 'extension');
  /** The number, as a number: not the 25 of 250 or of 2025. */
  const namesTheNumber = (text: string): boolean =>
    new RegExp(`(^|\\D)${String(FORGE_GRAPH_MAX_OBJECTS)}(\\D|$)`).test(text);

  it.each(['', '.fr', '.de', '.es', '.ja', '.pt-br'])(
    'package.nls%s.json names the number of objects auto draws as a graph',
    (suffix) => {
      const bundle = JSON.parse(
        readFileSync(join(EXTENSION, `package.nls${suffix}.json`), 'utf8'),
      ) as Record<string, string>;
      expect(namesTheNumber(bundle['config.forge.graphView.description'])).toBe(true);
    },
  );

  it.each([['README.md'], ['packages', 'extension', 'README.md'], ['docs', 'forge-quickstart.md']])(
    '%s names it too',
    (...path) => {
      const lines = readFileSync(join(REPO, ...path), 'utf8')
        .split('\n')
        .filter((line) => line.includes('`auto`') && line.includes('graph'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(namesTheNumber(line)).toBe(true);
    },
  );

  it.each(['en', 'fr', 'de', 'es', 'ja', 'pt-BR'])('the %s help on Forge names it', (locale) => {
    const catalogue = JSON.parse(
      readFileSync(join(__dirname, '..', 'i18n', 'locales', `${locale}.json`), 'utf8'),
    ) as { help: { forgeContent: string } };
    expect(namesTheNumber(catalogue.help.forgeContent)).toBe(true);
  });

  it.each(['', '.nls.fr', '.nls.de', '.nls.es', '.nls.ja', '.nls.pt-br'])(
    'the Get Started steps on Forge and on the settings name it (%s)',
    (suffix) => {
      for (const step of ['forge-clone', 'settings']) {
        const body = readFileSync(join(EXTENSION, 'walkthrough', `${step}${suffix}.md`), 'utf8');
        expect(namesTheNumber(body), `${step}${suffix}.md`).toBe(true);
      }
    },
  );
});
