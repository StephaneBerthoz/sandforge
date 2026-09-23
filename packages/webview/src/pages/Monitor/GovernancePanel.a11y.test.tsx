import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GovernancePolicySummary } from '@sandforge/shared';
import '../../i18n';
import { GovernancePanel } from './GovernancePanel';

/** A policy as `governance:policies:list` answers it. */
const policy = (id: string, name: string, ruleCount: number): GovernancePolicySummary => ({
  id,
  name,
  description: 'Checked every week',
  ruleCount,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('GovernancePanel, read by a screen reader', () => {
  it('names each delete button after its policy', () => {
    // The button held a trash icon and nothing else: two policies read as two
    // unnamed buttons.
    render(
      <GovernancePanel
        policies={[policy('pol-1', 'Security baseline', 3), policy('pol-2', 'Data retention', 1)]}
        onDeletePolicy={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete Security baseline' })).toBe(
      screen.getByTestId('delete-policy-pol-1'),
    );
    expect(screen.getByRole('button', { name: 'Delete Data retention' })).toBe(
      screen.getByTestId('delete-policy-pol-2'),
    );
  });
});
