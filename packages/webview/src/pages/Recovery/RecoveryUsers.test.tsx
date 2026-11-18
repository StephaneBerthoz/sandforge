import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { USERS_MAX, type RecoveryUser } from '@sandforge/shared';
import {
  appliedAna,
  fakeHost,
  planOfAna,
  usersList,
  type FakeHost,
} from './testing/recoveryFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { RecoveryUsers, USERS_PER_RUN } from './RecoveryUsers';

const ANA = 'ana.tester@example.com.uat';
const BO = 'bo.qa@example.com.uat';

/** Draw the step, its users listed. */
function open(
  props: Partial<React.ComponentProps<typeof RecoveryUsers>> = {},
  list = usersList(),
): ReturnType<typeof vi.fn> {
  const onChanged = vi.fn();
  render(<RecoveryUsers orgId="org-uat" alias="UAT" onChanged={onChanged} {...props} />);
  act(() => host.current?.answer('recovery:users:list', 'recovery:users:list:response', list));
  return onChanged;
}

/** Choose Ana and simulate: the plan answered asks for the email to her. */
function simulateAna(plan = planOfAna()): void {
  fireEvent.click(screen.getByTestId(`recovery-user-${ANA}`));
  fireEvent.click(screen.getByTestId('recovery-users-simulate'));
  act(() =>
    host.current?.answer('recovery:users:plan', 'recovery:users:plan:response', {
      orgId: 'org-uat',
      plan,
    }),
  );
}

beforeEach(() => {
  host.current = fakeHost();
});

describe('RecoveryUsers', () => {
  it('runs at most as many users as sandforge users takes', () => {
    expect(USERS_PER_RUN).toBe(USERS_MAX);
  });

  it('reads the users to bring back, a box each with what the sandbox says of them, none chosen', () => {
    render(<RecoveryUsers orgId="org-uat" alias="UAT" onChanged={vi.fn()} />);
    expect(screen.getByTestId('recovery-users-loading')).toHaveTextContent(
      'Reading the users of UAT…',
    );
    expect(host.current?.lastPayload('recovery:users:list')).toEqual({ orgId: 'org-uat' });
    act(() =>
      host.current?.answer('recovery:users:list', 'recovery:users:list:response', usersList()),
    );

    const ana = screen.getByRole('checkbox', { name: ANA });
    expect(ana).not.toBeChecked();
    const list = screen.getByTestId('recovery-users-list');
    expect(list).toHaveTextContent('address under .invalid');
    expect(list).toHaveTextContent('inactive');
    expect(list).toHaveTextContent('frozen');
    expect(screen.getByTestId('recovery-users-chosen')).toHaveTextContent('0 users chosen.');
    expect(screen.getByTestId('recovery-users-simulate')).toBeDisabled();
    expect(screen.getByTestId('recovery-users-apply')).toBeDisabled();
  });

  it('starts from the list kept for the sandbox, its users chosen', () => {
    open(
      {},
      usersList({
        saved: { config: { users: [{ username: BO }] }, savedAt: '2026-11-10T09:00:00.000Z' },
      }),
    );
    expect(screen.getByTestId(`recovery-user-${BO}`)).toBeChecked();
    expect(screen.getByTestId(`recovery-user-${ANA}`)).not.toBeChecked();
    expect(screen.getByTestId('recovery-users-list')).toHaveTextContent('as the saved list says');
  });

  it('simulates the users chosen with no acceptance, replacing the run before', () => {
    open({ lastRun: { run: 2, at: '2026-11-18T08:30:00.000Z', status: 'success' } });
    expect(screen.getByTestId('recovery-users-chosen')).toHaveTextContent(
      'The run replaces run 2: it converges from what that one set up.',
    );
    fireEvent.click(screen.getByTestId(`recovery-user-${ANA}`));
    fireEvent.click(screen.getByTestId('recovery-users-simulate'));
    expect(host.current?.lastPayload('recovery:users:plan')).toEqual({
      orgId: 'org-uat',
      config: { users: [{ username: ANA, email: 'restore' }] },
      acceptUserEmails: false,
      acceptEmails: false,
      acceptAutomation: false,
      replaces: 2,
    });
  });

  it('keeps Apply closed until the person accepts, for this run, the emails the plan counts', () => {
    open();
    expect(screen.queryByTestId('recovery-users-plan')).toBeNull();
    simulateAna();

    expect(screen.getByTestId('recovery-users-plan')).toHaveTextContent(
      `${ANA}: address asked back, awaiting its owner's confirmation`,
    );
    const apply = screen.getByTestId('recovery-users-apply');
    expect(apply).toBeDisabled();
    const accept = screen.getByRole('checkbox', {
      name: 'Let Salesforce email 1 person the link that confirms the address asked back, for this run only.',
    });
    fireEvent.click(accept);
    expect(apply).toBeEnabled();
  });

  it('closes Apply again when the choice changes after the simulation', () => {
    open();
    simulateAna();
    fireEvent.click(screen.getByTestId('recovery-users-acceptUserEmails').querySelector('input')!);
    expect(screen.getByTestId('recovery-users-apply')).toBeEnabled();

    fireEvent.click(screen.getByTestId(`recovery-user-${BO}`));
    expect(screen.getByTestId('recovery-users-apply')).toBeDisabled();
    expect(screen.getByTestId('recovery-users-simulate-first')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-users-plan')).toBeNull();
  });

  it('applies with the acceptance said, follows its progress, and stops it on request', () => {
    open();
    simulateAna();
    fireEvent.click(screen.getByTestId('recovery-users-acceptUserEmails').querySelector('input')!);
    fireEvent.click(screen.getByTestId('recovery-users-apply'));
    expect(host.current?.lastPayload('recovery:users:apply')).toEqual({
      orgId: 'org-uat',
      config: { users: [{ username: ANA, email: 'restore' }] },
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: false,
    });

    const applyId = host.current?.sent('recovery:users:apply')[0]?.id;
    act(() =>
      host.current?.push(
        'recovery:users:progress',
        { orgId: 'org-uat', done: 0, total: 1 },
        'another',
      ),
    );
    expect(screen.getByTestId('recovery-users-progress')).toHaveTextContent(
      'Setting the users of UAT up…',
    );
    act(() =>
      host.current?.push(
        'recovery:users:progress',
        { orgId: 'org-uat', done: 1, total: 1 },
        applyId,
      ),
    );
    expect(screen.getByTestId('recovery-users-progress')).toHaveTextContent('1 of 1 users');

    fireEvent.click(screen.getByTestId('recovery-users-stop'));
    expect(host.current?.lastPayload('recovery:users:cancel')).toEqual({ orgId: 'org-uat' });
  });

  it('says an address asked back awaits its owner, never that it is restored, and reads the status again', () => {
    const onChanged = open();
    simulateAna();
    fireEvent.click(screen.getByTestId('recovery-users-acceptUserEmails').querySelector('input')!);
    fireEvent.click(screen.getByTestId('recovery-users-apply'));
    act(() =>
      host.current?.answer('recovery:users:apply', 'recovery:users:apply:response', {
        orgId: 'org-uat',
        applied: appliedAna(),
      }),
    );

    const result = screen.getByTestId('recovery-users-result');
    expect(result).toHaveTextContent('Run 1: the users are set up as asked.');
    expect(result).toHaveTextContent(
      'Salesforce emailed 1 person the link that confirms the address.',
    );
    expect(result).toHaveTextContent('awaiting confirmation');
    expect(result.textContent).not.toMatch(/restored/i);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The simulation was spent by the run: another run waits for another one.
    expect(screen.getByTestId('recovery-users-apply')).toBeDisabled();
  });

  it('words a refusal no acceptance lifts by its code, and keeps Apply closed', () => {
    open();
    simulateAna(
      planOfAna({
        refusals: [{ code: 'USERS_SELF', message: 'would lock itself out', username: ANA }],
        emailsToPeople: 0,
      }),
    );
    expect(screen.getByTestId('recovery-users-refusals')).toHaveTextContent(
      `${ANA} is the user SandForge is connected as, and the run would lock it out: leave it out, or connect as another.`,
    );
    expect(screen.getByTestId('recovery-users-refusals')).not.toHaveTextContent(
      'would lock itself out',
    );
    expect(screen.getByTestId('recovery-users-apply')).toBeDisabled();
  });

  it('lists under its acceptance what the automation would set off, by kind, and what could not be read', () => {
    open();
    simulateAna(
      planOfAna({
        emailsToPeople: 0,
        refusals: [
          {
            code: 'AUTOMATION_NOT_ACCEPTED',
            message: 'UAT runs automation as users are written: User: Apex trigger UserTrigger',
            automation: {
              fired: [
                { kind: 'trigger', name: 'UserTrigger', objectApiName: 'User', when: 'after' },
                {
                  kind: 'workflowRule',
                  name: 'Notify the manager',
                  objectApiName: 'User',
                  when: 'beforeAndAfter',
                },
              ],
              unread: ['flows'],
            },
          },
        ],
      }),
    );
    const listed = screen.getByTestId('recovery-users-automation');
    expect(listed).toHaveTextContent('Apex trigger UserTrigger on User, after save');
    expect(listed).toHaveTextContent(
      'Workflow rule Notify the manager on User, before and after save',
    );
    expect(listed).toHaveTextContent(
      'The flows of UAT could not be read: whether one starts as a user is written is not known.',
    );
    // The English of the extension is for its log.
    expect(listed).not.toHaveTextContent('runs automation as users are written');
    expect(screen.getByTestId('recovery-users-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('recovery-users-acceptAutomation').querySelector('input')!);
    expect(screen.getByTestId('recovery-users-apply')).toBeEnabled();
  });

  it('says when nothing of what the org runs could be read, so nothing of it is known', () => {
    open();
    simulateAna(
      planOfAna({
        emailsToPeople: 0,
        refusals: [
          {
            code: 'AUTOMATION_NOT_ACCEPTED',
            message: 'What UAT runs as users are written could not be read (INVALID_SESSION_ID)',
            automation: { fired: [], notDeduced: true },
          },
        ],
      }),
    );
    expect(screen.getByTestId('recovery-users-automation')).toHaveTextContent(
      'What UAT runs as a user is written could not be read: what would fire is not known.',
    );
    expect(screen.getByTestId('recovery-users-automation')).not.toHaveTextContent(
      'INVALID_SESSION_ID',
    );
  });

  it('asks again, by its words, an org that changed since the simulation', () => {
    open();
    simulateAna();
    fireEvent.click(screen.getByTestId('recovery-users-acceptUserEmails').querySelector('input')!);
    fireEvent.click(screen.getByTestId('recovery-users-apply'));
    act(() =>
      host.current?.fail('recovery:users:apply', {
        code: 'ORG_CHANGED',
        message: 'the org changed since the plan',
      }),
    );
    expect(screen.getByTestId('recovery-users-apply-error')).toHaveTextContent(
      'UAT changed since the simulation: simulate again, then apply.',
    );
  });

  it('asks for a new simulation when the extension refuses the run after the one it had', () => {
    open();
    simulateAna();
    fireEvent.click(screen.getByTestId('recovery-users-acceptUserEmails').querySelector('input')!);
    fireEvent.click(screen.getByTestId('recovery-users-apply'));
    act(() =>
      host.current?.fail('recovery:users:apply', {
        code: 'FAILED',
        message: 'USERS_EMAILS_NOT_ACCEPTED: Salesforce would email 1 person',
      }),
    );
    const error = screen.getByTestId('recovery-users-apply-error');
    expect(error).toHaveTextContent(
      'The run did not go through: simulate again to read where the users stand, then apply.',
    );
    expect(error).not.toHaveTextContent('USERS_EMAILS_NOT_ACCEPTED');
    expect(screen.getByTestId('recovery-users-apply')).toBeDisabled();
  });

  it('names a user by its username, and by the name the sandbox gives when it gives one', () => {
    open(
      {},
      usersList({
        users: [
          { username: ANA, address: 'invalid', active: true, frozen: false, name: 'Ana Tester' },
          { username: BO, address: 'invalid', active: false, frozen: true },
        ],
      }),
    );
    expect(screen.getByRole('checkbox', { name: `Ana Tester ${ANA}` })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: BO })).toBeInTheDocument();
  });

  it('says how many users the sandbox has to bring back when it lists fewer', () => {
    open({}, usersList({ total: 7_000 }));
    expect(screen.getByTestId('recovery-users-capped')).toHaveTextContent(
      'Only 2 of the 7,000 users to bring back are listed: a users.json you import names the others.',
    );
  });

  it('says nothing of a cap when every user is listed', () => {
    open({}, usersList({ total: 2 }));
    expect(screen.queryByTestId('recovery-users-capped')).toBeNull();
  });

  it('reads a users.json, its users chosen and set up as it says', () => {
    open();
    fireEvent.click(screen.getByTestId('recovery-users-import'));
    expect(host.current?.lastPayload('recovery:users:config:import')).toEqual({ orgId: 'org-uat' });
    act(() =>
      host.current?.answer(
        'recovery:users:config:import',
        'recovery:users:config:import:response',
        {
          status: 'read',
          orgId: 'org-uat',
          fileName: 'users.json',
          config: { users: [{ username: ANA, profile: 'QA Profile' }] },
        },
      ),
    );
    expect(screen.getByTestId(`recovery-user-${ANA}`)).toBeChecked();
    expect(screen.getByTestId('recovery-users-imported')).toHaveTextContent(
      'users.json read: 1 user, set up as it says.',
    );
    fireEvent.click(screen.getByTestId('recovery-users-simulate'));
    expect(host.current?.lastPayload('recovery:users:plan')).toMatchObject({
      config: { users: [{ username: ANA, profile: 'QA Profile' }] },
    });
  });

  it('exports the list chosen as users.json, and keeps it for the next refresh', () => {
    const onChanged = open();
    fireEvent.click(screen.getByTestId(`recovery-user-${BO}`));
    fireEvent.click(screen.getByTestId('recovery-users-export'));
    expect(host.current?.lastPayload('recovery:users:config:export')).toEqual({
      orgId: 'org-uat',
      config: { users: [{ username: BO, email: 'restore', active: true, frozen: false }] },
    });
    act(() =>
      host.current?.answer(
        'recovery:users:config:export',
        'recovery:users:config:export:response',
        {
          status: 'saved',
          orgId: 'org-uat',
          fileName: 'users.json',
        },
      ),
    );
    expect(screen.getByTestId('recovery-users-exported')).toHaveTextContent(
      'Written to users.json.',
    );

    fireEvent.click(screen.getByTestId('recovery-users-save'));
    act(() =>
      host.current?.answer('recovery:users:config:save', 'recovery:users:config:save:response', {
        orgId: 'org-uat',
        savedAt: '2026-11-18T10:00:00.000Z',
      }),
    );
    expect(screen.getByTestId('recovery-users-saved')).toHaveTextContent(
      /^List saved for the next refresh, /,
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('says no user is to bring back when the sandbox lists none', () => {
    open({}, usersList({ users: [] }));
    expect(screen.getByTestId('recovery-users-none')).toHaveTextContent(
      'No user of UAT has an address under .invalid, nor is frozen or inactive.',
    );
  });

  it('refuses to simulate more users than a run takes', () => {
    const many: RecoveryUser[] = Array.from({ length: USERS_PER_RUN + 1 }, (_, index) => ({
      username: `tester${index}@example.com.uat`,
      name: `Tester ${index}`,
      address: 'invalid',
      active: true,
      frozen: false,
    }));
    open(
      {},
      usersList({
        users: many,
        saved: {
          config: {
            users: many.slice(0, USERS_PER_RUN).map((user) => ({ username: user.username })),
          },
          savedAt: '2026-11-10T09:00:00.000Z',
        },
      }),
    );
    // The list draws 200 rows: the last one is found by the filter.
    expect(screen.getByText(/^200 of 201 users shown/)).toBeInTheDocument();
    expect(screen.queryByTestId(`recovery-user-tester${USERS_PER_RUN}@example.com.uat`)).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by name or username' }), {
      target: { value: `tester${USERS_PER_RUN}@` },
    });
    fireEvent.click(screen.getByTestId(`recovery-user-tester${USERS_PER_RUN}@example.com.uat`));
    expect(screen.getByTestId('recovery-users-simulate')).toBeDisabled();
    expect(screen.getByText(/A run sets up 200 users at most/)).toBeInTheDocument();
  });

  it('words a refused reading of the users by its code, and reads again on Try again', () => {
    render(<RecoveryUsers orgId="org-uat" alias="UAT" onChanged={vi.fn()} />);
    act(() =>
      host.current?.fail('recovery:users:list', {
        code: 'NOT_A_DEVELOPMENT_ORG',
        message: 'a production org',
      }),
    );
    expect(screen.getByTestId('recovery-users-error')).toHaveTextContent(
      'UAT is not a sandbox, a scratch org or a Developer Edition org',
    );
    fireEvent.click(screen.getByTestId('recovery-users-error-retry'));
    expect(host.current?.sent('recovery:users:list')).toHaveLength(2);
  });
});
