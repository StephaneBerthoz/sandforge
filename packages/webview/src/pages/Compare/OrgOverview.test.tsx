import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { OrgOverview } from './OrgOverview';

/** Per-channel answers; a channel left unset answers nothing. */
const mockAnswers: Record<string, { data: unknown; loading: boolean; error: string | null }> = {};

/** Each query the overview asked for, and whether it was held back. */
const mockAsked: Array<{ type: string; payload: unknown; skip: boolean }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown, options?: { skip?: boolean }) => {
    mockAsked.push({ type, payload, skip: options?.skip ?? false });
    const answer = mockAnswers[type] ?? { data: null, loading: false, error: null };
    return { ...answer, refetch: vi.fn() };
  },
}));

const PAIR = { sourceOrgId: 'org-1', targetOrgId: 'org-2' };

describe('OrgOverview', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockAnswers)) delete mockAnswers[key];
    mockAsked.length = 0;
  });

  it('asks the orgs nothing, and says what it waits for, until two different orgs are picked', () => {
    render(<OrgOverview {...PAIR} orgsPicked={false} />);
    expect(screen.getByTestId('compare-overview-needs')).toBeDefined();
    expect(screen.queryByTestId('compare-overview')).toBeNull();
    expect(mockAsked.length).toBeGreaterThan(0);
    expect(mockAsked.every((asked) => asked.skip)).toBe(true);
  });

  it('reads the objects, the permission sets and profiles, and the settings of the two orgs at once', () => {
    render(<OrgOverview {...PAIR} orgsPicked />);
    const sent = mockAsked.filter((asked) => !asked.skip);
    expect(sent.map((asked) => asked.type)).toEqual([
      'compare:snapshots',
      'compare:permissions',
      'compare:drift',
    ]);
    for (const asked of sent) expect(asked.payload).toEqual(PAIR);
  });

  it('holds a place for each section while its orgs are read', () => {
    for (const type of ['compare:snapshots', 'compare:permissions', 'compare:drift']) {
      mockAnswers[type] = { data: null, loading: true, error: null };
    }
    render(<OrgOverview {...PAIR} orgsPicked />);
    const overview = screen.getByTestId('compare-overview');
    expect(within(overview).getAllByTestId('skeleton')).toHaveLength(3);
    expect(within(overview).queryByRole('alert')).toBeNull();
  });

  it('says, section by section, an answer that carried nothing to show, and the error a read gave', () => {
    mockAnswers['compare:snapshots'] = {
      data: null,
      loading: false,
      error: 'INVALID_SESSION_ID: Session expired or invalid',
    };
    render(<OrgOverview {...PAIR} orgsPicked />);
    expect(screen.getByTestId('compare-snapshots-error').textContent).toContain(
      'INVALID_SESSION_ID: Session expired or invalid',
    );
    expect(screen.getByTestId('compare-permissions-error').textContent).toContain(
      'compare:permissions returned no permission data',
    );
    expect(screen.getByTestId('compare-drift-error').textContent).toContain(
      'compare:drift returned no settings to compare',
    );
  });
});
