import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { NAV_GROUPS } from '../../navigation/navGroups';
import { useAppStore } from '../../stores/useAppStore';
import { AllModulesTile } from './AllModulesTile';

/** The modules a group lists, by route id, in the order shown. */
function listed(groupId: string): string[] {
  return within(screen.getByTestId(`home-group-${groupId}`))
    .getAllByRole('button')
    .map((button) => (button.getAttribute('data-testid') ?? '').replace(/^open-|-btn$/g, ''));
}

describe('AllModulesTile', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home', navigationIntent: null });
  });

  it('lists every module in the launcher’s five groups, in their order, each group named', () => {
    render(<AllModulesTile sandboxRegistered />);
    const tile = screen.getByTestId('quick-actions-tile');
    expect(within(tile).getByRole('heading', { level: 3 }).textContent).toBe('All modules');
    expect(
      within(tile)
        .getAllByRole('group')
        .map((group) => group.getAttribute('data-testid')),
    ).toEqual(NAV_GROUPS.map((group) => `home-group-${group.id}`));
    expect(
      within(tile)
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Fill an org',
      'Copy between orgs',
      'Protect and restore',
      'Watch and compare',
      'Automate',
    ]);
    expect(listed('fill')).toEqual(['seed', 'frozen']);
    expect(listed('copy')).toEqual(['forge', 'sync', 'autopilot', 'migration']);
    expect(listed('protect')).toEqual(['recovery', 'checkpoint', 'dataops']);
    expect(listed('watch')).toEqual(['monitor', 'compare', 'reports']);
    expect(listed('automate')).toEqual(['automation', 'ai']);
  });

  it('says what each module does on screen, in the sentence the launcher gives on hover', () => {
    render(<AllModulesTile sandboxRegistered />);
    const forge = screen.getByTestId('open-forge-btn');
    expect(forge.textContent).toBe(`Forge${en.moduleSummary.forge}`);
    expect(screen.getByTestId('open-sync-btn').textContent).toBe(`Sync${en.moduleSummary.sync}`);
  });

  it('lists Back into service once a sandbox is registered, the only kind of org a refresh happens to', () => {
    const { unmount } = render(<AllModulesTile sandboxRegistered={false} />);
    expect(listed('protect')).toEqual(['checkpoint', 'dataops']);
    unmount();

    render(<AllModulesTile sandboxRegistered />);
    expect(listed('protect')[0]).toBe('recovery');
  });

  it('lists no Grappe, whose page is retired', () => {
    render(<AllModulesTile sandboxRegistered />);
    expect(screen.queryByTestId('open-grappe-btn')).toBeNull();
  });

  it('opens the module a row names', () => {
    render(<AllModulesTile sandboxRegistered />);
    fireEvent.click(screen.getByTestId('open-recovery-btn'));
    expect(useAppStore.getState().currentRoute).toBe('recovery');
    fireEvent.click(screen.getByTestId('open-automation-btn'));
    expect(useAppStore.getState().currentRoute).toBe('automation');
  });
});
