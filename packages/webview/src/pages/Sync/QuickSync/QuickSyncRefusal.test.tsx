import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { QuickSyncRefusal } from './QuickSyncRefusal';
import { useAppStore } from '../../../stores/useAppStore';
import { useOrgStore } from '../../../stores/useOrgStore';

const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload: unknown) => {
    sent.push({ type, payload });
  },
}));

describe('QuickSyncRefusal', () => {
  const pick = { sourceOrgId: 'org-1', targetOrgId: 'org-2', objects: ['Account', 'Contact'] };

  beforeEach(() => {
    sent.length = 0;
    useAppStore.setState({ currentRoute: 'sync', navigationIntent: null });
    useOrgStore.setState({ selectedOrgId: 'org-1' });
  });

  it('says of a refusal for storage what Quick Sync can do, not the filters it has not', () => {
    render(
      <QuickSyncRefusal
        message="The sync was refused before it wrote anything."
        code="SYNC_STORAGE_EXCEEDED"
        pick={pick}
        onOpenInWizard={vi.fn()}
      />,
    );

    const said = screen.getByTestId('quick-sync-storage-refusal');
    expect(said.getAttribute('role')).toBe('alert');
    expect(said.textContent).toContain('Quick Sync has no filter');
    expect(said.textContent).toContain(
      'Forge with Depth ALL and Records per object set to A sample that fits the target',
    );
    expect(said.textContent).not.toContain('Simulate');
    expect(said.textContent).not.toContain('narrow their filters');
  });

  it('opens the pair and the objects picked in the wizard, where each object takes a filter', () => {
    const onOpenInWizard = vi.fn();
    render(
      <QuickSyncRefusal
        message="refused"
        code="SYNC_STORAGE_EXCEEDED"
        pick={pick}
        onOpenInWizard={onOpenInWizard}
      />,
    );

    fireEvent.click(screen.getByTestId('quick-sync-open-in-wizard'));

    expect(onOpenInWizard).toHaveBeenCalledWith(pick);
  });

  it('opens Forge for a sample that fits', () => {
    render(
      <QuickSyncRefusal
        message="refused"
        code="SYNC_STORAGE_EXCEEDED"
        pick={pick}
        onOpenInWizard={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('quick-sync-open-forge'));

    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('opens Empty objects on the target, these objects picked, the target selected', () => {
    render(
      <QuickSyncRefusal
        message="refused"
        code="SYNC_STORAGE_EXCEEDED"
        pick={pick}
        onOpenInWizard={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('quick-sync-empty-first'));

    expect(useAppStore.getState().currentRoute).toBe('dataops');
    expect(useAppStore.getState().navigationIntent).toMatchObject({
      route: 'dataops',
      targetOrgId: 'org-2',
      emptyObjects: ['Account', 'Contact'],
    });
    expect(useOrgStore.getState().selectedOrgId).toBe('org-2');
    expect(sent).toContainEqual({ type: 'org:select', payload: { orgId: 'org-2' } });
  });

  it('shows any other error with what the catalogue says of its code', () => {
    render(
      <QuickSyncRefusal
        message="REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded."
        code={null}
        pick={pick}
        onOpenInWizard={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('quick-sync-storage-refusal')).toBeNull();
    const banner = screen.getByTestId('quick-sync-error');
    expect(banner.textContent).toContain('REQUEST_LIMIT_EXCEEDED');
    // The banner draws the catalogue's hint under the message.
    expect(banner.querySelector('[data-testid="error-hint"]')).not.toBeNull();
  });
});
