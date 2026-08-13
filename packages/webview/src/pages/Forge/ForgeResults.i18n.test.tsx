import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeExecutionError } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import { ForgeResults } from './ForgeResults';

/* `t` echoes its key, so any label still hardcoded in the component shows up
   as English prose instead of a key. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const STAGES = ['insert', 'query', 'scope'] as const;

const errors: ForgeExecutionError[] = STAGES.map((stage) => ({
  objectApiName: `Obj_${stage}`,
  stage,
  failedCount: 2,
  attemptedCount: 5,
  samples: [],
}));

const graph = {
  nodes: [],
  edges: [],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const result = {
  id: 'exec-001',
  startedAt: Date.now() - 10_000,
  completedAt: Date.now(),
  totalRecords: 10,
  totalSuccess: 4,
  totalFailures: 6,
  status: 'partial' as const,
  graph,
  idRemapCount: 0,
  duration: 10_000,
  timestamp: '2026-03-20T10:00:00.000Z',
  errors,
};

vi.mock('../../stores/useForgeStore', () => {
  /* Built lazily: the factory is hoisted above `graph` and `result`. */
  const state = (): Record<string, unknown> => ({
    graph,
    result,
    logs: [],
    reset: vi.fn(),
    forgeAgain: vi.fn(),
    setPhase: vi.fn(),
    setGraph: vi.fn(),
  });
  const store = Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(state()),
    { getState: state },
  );
  return { useForgeStore: store };
});

describe('ForgeResults — translated stage badges', () => {
  it('resolves every stage badge through i18n', () => {
    render(<ForgeResults />);
    const rows = screen.getAllByTestId('forge-errors-row');
    expect(rows.length).toBe(STAGES.length);
    for (const [i, stage] of STAGES.entries()) {
      expect(rows[i]?.textContent).toContain(`forge.stage.${stage}`);
    }
  });

  it('backs every rendered key with an entry in the reference locale', () => {
    for (const stage of STAGES) {
      expect(typeof en.forge.stage[stage]).toBe('string');
    }
  });
});
