import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  FORGE_GRAPH_MAX_OBJECTS,
  FORGE_GRAPH_MIN_PANEL_PX,
  FORGE_GRAPH_SLOW_OBJECTS,
  forgeGraphIsLarge,
  forgeObjectsView,
  useForgeObjectsView,
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
    expect(forgeObjectsView('table', 'graph', 400)).toBe('graph');
    expect(forgeObjectsView('auto', 'table', 2)).toBe('table');
  });

  it('lists a small graph in a table under auto on a panel too narrow to draw it', () => {
    // At 360 pixels the minimap's strip left no room for a node: four
    // objects opened at the smallest zoom, all but one outside the box.
    expect(forgeObjectsView('auto', null, 4, true)).toBe('table');
    expect(forgeObjectsView('auto', null, 4, false)).toBe('graph');
  });

  it('leaves a narrow panel to the setting that names a view, and to the switch', () => {
    expect(forgeObjectsView('graph', null, 4, true)).toBe('graph');
    expect(forgeObjectsView('auto', 'graph', 4, true)).toBe('graph');
  });
});

// Laid out and drawn, 1,950 objects held the panel still at every redraw:
// neither the setting nor a pick made on a small graph draws a large one.
describe('a large graph', () => {
  it('is one past 150 objects, or any clone of the whole org whatever it holds', () => {
    expect(forgeGraphIsLarge(FORGE_GRAPH_SLOW_OBJECTS)).toBe(false);
    expect(forgeGraphIsLarge(FORGE_GRAPH_SLOW_OBJECTS + 1)).toBe(true);
    expect(forgeGraphIsLarge(3, true)).toBe(true);
  });

  it('is listed whatever the setting says or the graph picked on a smaller one', () => {
    expect(forgeObjectsView('graph', null, 400, false, true)).toBe('table');
    expect(forgeObjectsView('auto', 'graph', 400, false, true, false)).toBe('table');
  });

  it('is drawn once the graph is picked on a large graph', () => {
    expect(forgeObjectsView('auto', 'graph', 400, false, true, true)).toBe('graph');
    expect(forgeObjectsView('auto', 'table', 400, false, true, true)).toBe('table');
  });

  it('keeps the pick made on it for the next large one, and a pick on a small one away from it', () => {
    useForgeViewStore.setState({ setting: 'auto', choice: null, choiceOnLarge: false });
    useForgeViewStore.getState().choose('graph', true);
    expect(useForgeViewStore.getState()).toMatchObject({ choice: 'graph', choiceOnLarge: true });
    useForgeViewStore.getState().choose('graph');
    expect(useForgeViewStore.getState()).toMatchObject({ choice: 'graph', choiceOnLarge: false });
  });
});

describe('useForgeObjectsView', () => {
  const realMatchMedia = window.matchMedia;
  let matches = false;
  const listeners = new Set<() => void>();

  beforeEach(() => {
    useForgeViewStore.setState({ setting: 'auto', choice: null, choiceOnLarge: false });
    matches = false;
    listeners.clear();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query === `(max-width: ${String(FORGE_GRAPH_MIN_PANEL_PX - 1)}px)` && matches;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('follows the width of the panel: a table while it is narrow, the graph once widened', () => {
    matches = true;
    const { result } = renderHook(() => useForgeObjectsView(4));
    expect(result.current).toBe('table');

    act(() => {
      matches = false;
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe('graph');
  });

  it('lists the graph of a clone of the whole org, however few objects it holds, under the graph setting', () => {
    useForgeViewStore.setState({ setting: 'graph' });
    const { result } = renderHook(() => useForgeObjectsView(4, true));
    expect(result.current).toBe('table');
  });

  it('draws the graph where the panel cannot be measured', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const { result } = renderHook(() => useForgeObjectsView(4));
    expect(result.current).toBe('graph');
  });
});

describe('useForgeViewStore', () => {
  beforeEach(() => {
    useForgeViewStore.setState({ setting: 'auto', choice: null });
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
    expect(forgeObjectsView(setting, choice, 400)).toBe('graph');
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

  /** The narrowest panel the graph is drawn in, as a number. */
  const namesTheWidth = (text: string): boolean =>
    new RegExp(`(^|\\D)${String(FORGE_GRAPH_MIN_PANEL_PX)}(\\D|$)`).test(text);

  it.each(['', '.fr', '.de', '.es', '.ja', '.pt-br'])(
    'package.nls%s.json names the panel width under which auto lists the objects',
    (suffix) => {
      const bundle = JSON.parse(
        readFileSync(join(EXTENSION, `package.nls${suffix}.json`), 'utf8'),
      ) as Record<string, string>;
      expect(namesTheWidth(bundle['config.forge.graphView.description'])).toBe(true);
    },
  );

  it.each([
    ['README.md'],
    ['packages', 'extension', 'README.md'],
    ['docs', 'forge-quickstart.md'],
    ['docs', 'forge-reference.md'],
  ])('%s names the width too', (...path) => {
    const lines = readFileSync(join(REPO, ...path), 'utf8')
      .split('\n')
      .filter((line) => line.includes('`auto`') && namesTheNumber(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(namesTheWidth(line)).toBe(true);
  });

  it.each(['en', 'fr', 'de', 'es', 'ja', 'pt-BR'])(
    'the %s help on Forge names the width',
    (locale) => {
      const catalogue = JSON.parse(
        readFileSync(join(__dirname, '..', 'i18n', 'locales', `${locale}.json`), 'utf8'),
      ) as { help: { forgeContent: string } };
      expect(namesTheWidth(catalogue.help.forgeContent)).toBe(true);
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
