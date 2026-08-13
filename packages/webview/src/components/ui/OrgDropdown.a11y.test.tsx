import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { OrgDropdown } from './OrgDropdown';
import type { SalesforceOrg } from '@sandforge/shared';

/**
 * The trigger is a custom control: keyboard users get no native listbox
 * semantics and no native focus ring, so both have to be declared here.
 * Ring tokens are the ones Button.tsx applies, kept literal so a silent
 * drift back to a bare `focus:outline-none` fails loudly.
 */
const RING_CLASSES = [
  'focus-visible:outline-none',
  'focus-visible:ring-1',
  'focus-visible:ring-[var(--vscode-focusBorder,#007fd4)]',
];

const mockOrgs: SalesforceOrg[] = [
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

function renderDropdown(): HTMLElement {
  render(
    <OrgDropdown
      value=""
      onChange={vi.fn()}
      orgs={mockOrgs}
      ariaLabel="Source Org"
      testId="test-dd"
    />,
  );
  return screen.getByTestId('test-dd');
}

describe('OrgDropdown accessibility', () => {
  it('announces the trigger as opening a listbox', () => {
    expect(renderDropdown().getAttribute('aria-haspopup')).toBe('listbox');
  });

  it('keeps a visible focus ring for keyboard users', () => {
    const trigger = renderDropdown();

    for (const cls of RING_CLASSES) {
      expect(trigger.classList.contains(cls)).toBe(true);
    }
  });

  it('does not suppress the outline for every focus source', () => {
    expect(renderDropdown().classList.contains('focus:outline-none')).toBe(false);
  });
});
