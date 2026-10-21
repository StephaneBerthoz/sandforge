import { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * When the input step's other panels load. Each stand-in notes when its
 * module is evaluated: the step imported them up front, so every panel showing
 * Forge parsed the past runs' removal and the Template and AI tabs before it
 * painted its Record ID field.
 */
const evaluated = vi.hoisted(() => new Set<string>());

function stand(name: string) {
  evaluated.add(name);
  return { [name]: () => <div data-testid={`panel-${name}`}>{name}</div> };
}

vi.mock('./ForgeHistoryPanel', () => stand('ForgeHistoryPanel'));
vi.mock('./ForgeTemplatePanel', () => stand('ForgeTemplatePanel'));
vi.mock('./ForgeAIPanel', () => stand('ForgeAIPanel'));

import * as panels from './forgeInputPanels';

describe('forgeInputPanels', () => {
  it('loads no panel until it is drawn, then that panel only', async () => {
    expect([...evaluated]).toEqual([]);

    const { ForgeAIPanel } = panels as unknown as Record<string, React.FC>;
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <ForgeAIPanel />
      </Suspense>,
    );

    expect(screen.getByTestId('loading')).toBeDefined();
    expect(await screen.findByTestId('panel-ForgeAIPanel')).toBeDefined();
    expect([...evaluated]).toEqual(['ForgeAIPanel']);
  });

  it('loads each panel under its own name', async () => {
    for (const name of ['ForgeHistoryPanel', 'ForgeTemplatePanel']) {
      const Panel = (panels as unknown as Record<string, React.FC>)[name];
      const { unmount } = render(
        <Suspense fallback={null}>
          <Panel />
        </Suspense>,
      );
      expect(await screen.findByTestId(`panel-${name}`)).toBeDefined();
      unmount();
    }
  });
});
