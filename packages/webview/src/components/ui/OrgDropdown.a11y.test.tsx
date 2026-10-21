import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '../../i18n';
import { OrgDropdown } from './OrgDropdown';
import type { SalesforceOrg } from '@sandforge/shared';

/**
 * The trigger is a custom control: keyboard users get no native select
 * semantics and no native focus ring, so both have to be declared here.
 * Ring tokens are the ones Button.tsx applies, kept literal so a silent
 * drift back to a bare `focus:outline-hidden` fails loudly.
 */
const RING_CLASSES = [
  'focus-visible:outline-hidden',
  'focus-visible:ring-1',
  'focus-visible:ring-(--vscode-focusBorder,#007fd4)',
];

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-2',
    alias: 'QaOrg',
    username: 'qa@test.com',
    instanceUrl: 'https://qa.salesforce.com',
    orgId: 'OID2',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: 'low' as unknown as SalesforceOrg['safetyTier'],
    appearance: { color: 'blue', icon: 'default', position: 1 },
    metadata: { apiVersion: '58.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: '2026-03-20T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-1',
    alias: 'DevOrg',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgId: 'OID1',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: 'low' as unknown as SalesforceOrg['safetyTier'],
    appearance: { color: 'blue', icon: 'default', position: 0 },
    metadata: { apiVersion: '58.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: '2026-03-20T00:00:00Z',
    tags: [],
  },
];

function renderDropdown(value = '', onChange = vi.fn()): HTMLElement {
  render(
    <>
      <OrgDropdown
        value={value}
        onChange={onChange}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />
      <button data-testid="next-field">next</button>
    </>,
  );
  return screen.getByTestId('test-dd');
}

/** Let the frame the panel opens in run, as the browser would. */
async function nextFrame(): Promise<void> {
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
}

describe('OrgDropdown accessibility', () => {
  it('announces a disclosure, not a listbox it has none of the keys of', () => {
    const trigger = renderDropdown();
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')).toBe(
      screen.getByTestId('test-dd-panel'),
    );
  });

  it('marks the current org as current, not by its tint alone', () => {
    fireEvent.click(renderDropdown('org-1'));
    expect(screen.getByTestId('test-dd-option-org-1').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('test-dd-option-org-2').hasAttribute('aria-current')).toBe(false);
  });

  it('hands the focus back to the trigger after a pick, which unmounted the option', () => {
    const onChange = vi.fn();
    const trigger = renderDropdown('', onChange);
    fireEvent.click(trigger);
    const option = screen.getByTestId('test-dd-option-org-2');
    option.focus();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('org-2');
    expect(screen.queryByTestId('test-dd-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens on the arrow down with the current org focused, walks with the arrows, and Escape gives the trigger back', async () => {
    const trigger = renderDropdown('org-1');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await nextFrame();
    expect(document.activeElement).toBe(screen.getByTestId('test-dd-option-org-1'));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('test-dd-option-org-2'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('test-dd-option-empty'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('test-dd-option-org-2'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByTestId('test-dd-option-empty'));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByTestId('test-dd-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the focus leaves it, not only on a click elsewhere', () => {
    const trigger = renderDropdown();
    fireEvent.click(trigger);
    const option = screen.getByTestId('test-dd-option-org-2');
    fireEvent.blur(option, { relatedTarget: screen.getByTestId('next-field') });
    expect(screen.queryByTestId('test-dd-panel')).toBeNull();
  });

  it('keeps a visible focus ring for keyboard users', () => {
    const trigger = renderDropdown();

    for (const cls of RING_CLASSES) {
      expect(trigger.classList.contains(cls)).toBe(true);
    }
  });

  it('does not suppress the outline for every focus source', () => {
    expect(renderDropdown().classList.contains('focus:outline-hidden')).toBe(false);
  });
});
