import { describe, expect, it } from 'vitest';

import { forgeGraphViewSchema } from '../schemas/forge.schema.js';
import { FORGE_GRAPH_VIEWS, isForgeGraphView } from './forge-graph-view.js';

// That the webview's shared code reads it without zod is checked on the build
// itself: scripts/check-webview-assets.mjs refuses a panel base that holds zod.
describe('the values of the graph view setting', () => {
  it('are the values the schema accepts', () => {
    expect([...FORGE_GRAPH_VIEWS].sort()).toEqual([...forgeGraphViewSchema.options].sort());
  });

  it.each(['auto', 'graph', 'table'])('reads %s as a value of the setting', (value) => {
    expect(isForgeGraphView(value)).toBe(true);
  });

  it.each([undefined, null, '', 'Graph', 'list', 3, {}])(
    'refuses %s, which the setting does not offer',
    (value) => {
      expect(isForgeGraphView(value)).toBe(false);
    },
  );
});
