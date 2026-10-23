import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import {
  developerOrg,
  fakeHost,
  productionOrg,
} from '../../pages/Checkpoint/testing/checkpointFixtures';
import type { FakeHost } from '../../pages/Checkpoint/testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { TakeCheckpointNow } from './TakeCheckpointNow';

describe('TakeCheckpointNow', () => {
  beforeEach(() => {
    host.current = fakeHost();
    useOrgStore.setState({
      orgs: [developerOrg({ id: 'org-other', alias: 'OTHER-SB' }), developerOrg(), productionOrg()],
      selectedOrgId: 'org-other',
    });
    useAppStore.setState({ currentRoute: 'seed', navigationIntent: null });
  });
  afterEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('says why, naming the org the run wrote to, and the button reads its why', () => {
    render(<TakeCheckpointNow orgId="org-dev" wrote testId="now" />);
    const why = screen.getByText(
      'Before your testers start, keep DEV-SB as it is now: it becomes the point to come back to, and a rewind returns it there, whoever changes it next.',
    );
    const action = screen.getByRole('button', { name: 'Take a checkpoint now' });
    expect(action).toHaveAttribute('aria-describedby', why.id);
    expect(action).toHaveAccessibleDescription(why.textContent ?? '');
  });

  it('opens Checkpoints on a take of the org the run wrote to, selected everywhere first', () => {
    render(<TakeCheckpointNow orgId="org-dev" wrote testId="now" />);
    fireEvent.click(screen.getByTestId('now-action'));
    expect(useAppStore.getState().currentRoute).toBe('checkpoint');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      takeCheckpoint: true,
      targetOrgId: 'org-dev',
    });
    // The org that was selected was another: the page opens on the run's.
    expect(useOrgStore.getState().selectedOrgId).toBe('org-dev');
    expect(host.current?.lastPayload('org:select')).toEqual({ orgId: 'org-dev' });
  });

  it('is not offered when the run wrote nothing there', () => {
    const { container } = render(<TakeCheckpointNow orgId="org-dev" wrote={false} testId="now" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is not offered for a production org, of which a checkpoint is refused', () => {
    const { container } = render(<TakeCheckpointNow orgId="org-prod" wrote testId="now" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is not offered for an org whose session is gone, nor one the registry no longer holds', () => {
    useOrgStore.setState({ orgs: [developerOrg({ status: 'expired' })], selectedOrgId: 'org-dev' });
    const { container, rerender } = render(
      <TakeCheckpointNow orgId="org-dev" wrote testId="now" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<TakeCheckpointNow orgId="org-removed" wrote testId="now" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TakeCheckpointNow orgId={undefined} wrote testId="now" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is offered for a sandbox and a scratch org as for a Developer Edition', () => {
    useOrgStore.setState({
      orgs: [
        developerOrg({
          id: 'org-sb',
          alias: 'UAT-SB',
          orgType: 'Sandbox',
          metadata: { apiVersion: '66.0', edition: 'Enterprise Edition', features: [] },
        }),
        developerOrg({ id: 'org-scratch', alias: 'SCRATCH', orgType: 'Scratch' }),
      ],
      selectedOrgId: null,
    });
    const { rerender } = render(<TakeCheckpointNow orgId="org-sb" wrote testId="now" />);
    expect(screen.getByTestId('now')).toHaveTextContent('keep UAT-SB as it is now');
    rerender(<TakeCheckpointNow orgId="org-scratch" wrote testId="now" />);
    expect(screen.getByTestId('now')).toHaveTextContent('keep SCRATCH as it is now');
  });
});
