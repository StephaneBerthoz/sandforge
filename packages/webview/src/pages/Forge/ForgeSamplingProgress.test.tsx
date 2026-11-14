import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../../i18n';
import { ForgeSamplingProgress } from './ForgeSamplingProgress';
import { useForgeStore } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { developerOrg } from '../Checkpoint/testing/checkpointFixtures';

/*
 * Drawing the plan of a sample reads the source for minutes before the
 * run's gate, and writes no object meanwhile: the execution screen says
 * where it stands rather than a bar standing still at nothing.
 */
describe('ForgeSamplingProgress', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useOrgStore.setState({ orgs: [developerOrg({ id: 'org-src', alias: 'prod' })] });
    useForgeStore.getState().setConfig({
      inputMode: 'org',
      depth: 'all',
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
      sample: {},
    });
  });

  it('says nothing while no sample is drawn', () => {
    render(<ForgeSamplingProgress />);

    expect(screen.queryByTestId('forge-sampling')).toBeNull();
  });

  it('says the step, the object it is on, what it has read and the requests it sent', () => {
    useForgeStore.setState({
      sampling: {
        step: 'counting',
        objectApiName: 'Contact',
        done: 2,
        total: 4,
        rows: 0,
        requests: 3,
        pricedAt: 120,
      },
    });
    render(<ForgeSamplingProgress />);

    const status = screen.getByTestId('forge-sampling');
    expect(status.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('forge-sampling-step').textContent).toBe(
      'Drawing the sample, before anything is written: counting the records each object may draw from — Contact, 2 of 4 objects.',
    );
    expect(screen.getByTestId('forge-sampling-counts').textContent).toBe(
      '0 records read, 3 API requests of prod of about 120 priced.',
    );
  });

  it('follows the step as it moves, and says no figure it was not given', () => {
    useForgeStore.setState({
      sampling: { step: 'counting', rows: 0, requests: 1 },
    });
    render(<ForgeSamplingProgress />);

    act(() => {
      useForgeStore.setState({ sampling: { step: 'fitting', rows: 1_812, requests: 61 } });
    });

    expect(screen.getByTestId('forge-sampling-step').textContent).toBe(
      'Drawing the sample, before anything is written: cutting it to what the target has room for.',
    );
    expect(screen.getByTestId('forge-sampling-counts').textContent).toBe(
      '1,812 records read, 61 API requests of prod.',
    );
  });
});
