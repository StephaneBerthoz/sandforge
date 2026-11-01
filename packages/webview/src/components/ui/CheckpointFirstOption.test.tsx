import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RunCheckpointEstimate } from '@sandforge/shared';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { developerOrg, productionOrg } from '../../pages/Checkpoint/testing/checkpointFixtures';
import { CheckpointFirstEstimate, CheckpointFirstOption } from './CheckpointFirstOption';

const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 7_588,
    apiRequests: 43,
    apiRequestsLeft: 14_000,
    seconds: 22,
    bytes: 2_306_867,
  },
  objects: ['Account', 'Contact', 'Task', 'ContentDocument', 'Attachment'],
  added: [
    {
      objectApiName: 'Task',
      reason: "The target's flow 'Welcome task' creates Task records as Contact records go in.",
    },
  ],
  notHeld: [{ objectApiName: 'FeedItem', reason: 'Chatter posts: a rewind leaves its records.' }],
  keepDays: 7,
};

describe('CheckpointFirstOption', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [developerOrg(), productionOrg()], selectedOrgId: 'org-dev' });
  });
  afterEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('is off unless ticked, and says it holds, leaves out and keeps on this machine', () => {
    const onChange = vi.fn();
    render(
      <CheckpointFirstOption
        checked={false}
        onChange={onChange}
        orgId="org-dev"
        costSaid="question"
        testId="option"
      />,
    );
    const toggle = screen.getByRole('checkbox', { name: 'Checkpoint first' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('option-holds')).toHaveTextContent(
      "takes a checkpoint of DEV-SB: each object it writes, held whole, and those the target's flows that still run create",
    );
    // The line the scope cannot name: no object note holds what Apex creates.
    expect(screen.getByTestId('option-leaves-out')).toHaveTextContent(
      'An Apex trigger, or a flow SandForge could not read, may create records outside it',
    );
    expect(screen.getByTestId('option-on-machine')).toHaveTextContent(
      'on this machine, unencrypted and readable by you alone',
    );
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('says where the cost is said, by how the module says it, before anything is read', () => {
    const { rerender } = render(
      <CheckpointFirstOption
        checked={false}
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="question"
        testId="option"
      />,
    );
    expect(screen.getByTestId('option-cost-said')).toHaveTextContent(
      'is said in the question before the first write, where you can still cancel',
    );
    rerender(
      <CheckpointFirstOption
        checked={false}
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="simulation"
        testId="option"
      />,
    );
    expect(screen.getByTestId('option-cost-said')).toHaveTextContent('Simulate says what it would');
    rerender(
      <CheckpointFirstOption
        checked={false}
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="preview"
        testId="option"
      />,
    );
    expect(screen.getByTestId('option-cost-said')).toHaveTextContent(
      'The load takes it with no question of its own',
    );
  });

  it('says the cost from the estimate once read, with what it adds and leaves out', () => {
    render(
      <CheckpointFirstOption
        checked
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="simulation"
        estimate={{ of: ESTIMATE, lead: 'At the last simulation:' }}
        testId="option"
      />,
    );
    expect(screen.queryByTestId('option-cost-said')).toBeNull();
    expect(screen.getByTestId('option-estimate-cost')).toHaveTextContent(
      'At the last simulation: about 7,588 records of Account, Contact, Task, ContentDocument and Attachment, 43 API requests, 22s, 2.2 MB on this machine, kept 7 days.',
    );
    expect(screen.getByTestId('option-estimate-added-Task')).toHaveTextContent(
      "Task · The target's flow 'Welcome task' creates Task records",
    );
    expect(screen.getByTestId('option-estimate-not-held-FeedItem')).toHaveTextContent(
      'FeedItem · Chatter posts',
    );
  });

  it('recommends itself where the run has no other way back, until it is ticked', () => {
    const { rerender } = render(
      <CheckpointFirstOption
        checked={false}
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="question"
        recommendation="tick it"
        testId="option"
      />,
    );
    expect(screen.getByTestId('option-recommended')).toHaveTextContent('tick it');
    rerender(
      <CheckpointFirstOption
        checked
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="question"
        recommendation="tick it"
        testId="option"
      />,
    );
    expect(screen.queryByTestId('option-recommended')).toBeNull();
  });

  it('offers nothing on a target it would be refused on, says why, and unticks itself', () => {
    const onChange = vi.fn();
    render(
      <CheckpointFirstOption
        checked
        onChange={onChange}
        orgId="org-prod"
        costSaid="question"
        testId="option"
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Checkpoint first' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Checkpoint first' })).not.toBeChecked();
    expect(screen.getByTestId('option-not-offered')).toHaveTextContent(
      'SandForge takes no checkpoint of PROD',
    );
    expect(screen.queryByTestId('option-holds')).toBeNull();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('shows nothing before a target is picked', () => {
    const { container } = render(
      <CheckpointFirstOption
        checked={false}
        onChange={vi.fn()}
        orgId=""
        costSaid="preview"
        testId="option"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('reads its details as the description of its box', () => {
    render(
      <CheckpointFirstOption
        checked={false}
        onChange={vi.fn()}
        orgId="org-dev"
        costSaid="question"
        testId="option"
      />,
    );
    const toggle = screen.getByTestId('option-toggle');
    expect(toggle).toHaveAccessibleDescription(
      expect.stringContaining('Never in it: Chatter posts'),
    );
  });
});

describe('CheckpointFirstEstimate', () => {
  it('says the refusal a real run would meet, by the take’s own code', () => {
    render(
      <CheckpointFirstEstimate
        estimate={{
          ...ESTIMATE,
          refusal: { code: 'DISK', message: 'The disk has 1.0 MB free.' },
        }}
        lead="A real run would take a checkpoint first:"
        testId="estimate"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      "A real run would be refused for its checkpoint. This machine's disk has too little room for it.",
    );
  });

  it('says a checkpoint kept until deleted, and a day alone', () => {
    const { rerender } = render(
      <CheckpointFirstEstimate estimate={{ ...ESTIMATE, keepDays: 0 }} lead="" testId="estimate" />,
    );
    expect(screen.getByTestId('estimate-cost')).toHaveTextContent('kept until deleted.');
    rerender(
      <CheckpointFirstEstimate estimate={{ ...ESTIMATE, keepDays: 1 }} lead="" testId="estimate" />,
    );
    expect(screen.getByTestId('estimate-cost')).toHaveTextContent('kept 1 day.');
  });
});
