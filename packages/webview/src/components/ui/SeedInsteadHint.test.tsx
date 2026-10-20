import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SeedInsteadHint } from './SeedInsteadHint';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';

describe('SeedInsteadHint', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useAppStore.setState({ currentRoute: 'forge', navigationIntent: null });
  });

  it("opens Seed's template gallery on the org to fill", () => {
    useOrgStore.setState({
      orgs: [{ id: 'dev', status: 'connected', orgType: 'Developer' }] as never,
      selectedOrgId: 'dev',
    });
    render(<SeedInsteadHint testId="hint" />);

    fireEvent.click(screen.getByTestId('hint-action'));

    expect(useAppStore.getState().currentRoute).toBe('seed');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'seed',
      seedMode: 'quick-seed',
      targetOrgId: 'dev',
    });
  });

  it('is not shown when the only org is a production org', () => {
    useOrgStore.setState({
      orgs: [{ id: 'prod', status: 'connected', orgType: 'Production' }] as never,
      selectedOrgId: 'prod',
    });
    render(<SeedInsteadHint testId="hint" />);

    expect(screen.queryByTestId('hint')).toBeNull();
  });
});
