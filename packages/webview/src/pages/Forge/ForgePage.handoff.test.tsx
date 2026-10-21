import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ForgePage } from './ForgePage';
import { useAppStore } from '../../stores/useAppStore';
import { useForgeStore } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import type { SalesforceOrg } from '@sandforge/shared';

/**
 * The record Home's hero hands over arrives with the navigation, and Forge
 * starts its run from it as it opens.
 *
 * Home wrote it into the Forge store itself, which put the store's module and
 * zod on Home. The input step takes the record from the config it finds as it
 * mounts, so the page sets that config before the step renders: the stand-in
 * below reads the store as it renders, as `useForgeForm` does.
 */
vi.mock('./ForgeInput', () => ({
  ForgeInput: () => (
    <p data-testid="input-saw">{useForgeStore.getState().config?.recordId ?? 'nothing'}</p>
  ),
}));

const ORG = { id: 'org-1', alias: 'Dev', username: 'dev@example.com' } as SalesforceOrg;

describe('ForgePage, opened from Home with a record', () => {
  beforeEach(() => {
    useForgeStore.setState({ config: null, phase: 'input' });
    useOrgStore.setState({ orgs: [ORG], selectedOrgId: 'org-1' });
    useAppStore.setState({ currentRoute: 'home', navigationIntent: null });
  });

  it('starts a run from the record before the input step renders, and reads the handover once', () => {
    useAppStore
      .getState()
      .navigate('forge', { recordId: '001000000000001AAA', sourceOrgId: 'org-1' });

    render(<ForgePage />);

    expect(screen.getByTestId('input-saw').textContent).toBe('001000000000001AAA');
    expect(useForgeStore.getState().config).toEqual({
      inputMode: 'record',
      recordId: '001000000000001AAA',
      depth: 'direct',
      sourceOrgId: 'org-1',
      targetOrgId: '',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    });
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });

  it('leaves the run as it is when Forge is opened with no record', () => {
    useAppStore.getState().navigate('forge');

    render(<ForgePage />);

    expect(screen.getByTestId('input-saw').textContent).toBe('nothing');
    expect(useForgeStore.getState().config).toBeNull();
  });

  it('takes no record meant for another page', () => {
    useAppStore.setState({
      currentRoute: 'forge',
      navigationIntent: { route: 'seed', recordId: '001000000000001AAA' },
    });

    render(<ForgePage />);

    expect(useForgeStore.getState().config).toBeNull();
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'seed',
      recordId: '001000000000001AAA',
    });
  });
});
