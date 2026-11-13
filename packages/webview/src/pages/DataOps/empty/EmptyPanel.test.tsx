import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import { useOrgStore } from '../../../stores/useOrgStore';
import { EmptyPanel } from './EmptyPanel';
import { RUN_ID, previewAnswer, runResultOf, scopeAnswer } from './testing/emptyAnswers';

interface HookState {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
  refetch: ReturnType<typeof vi.fn>;
}

const idle = (): HookState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  errorCode: null,
  reset: vi.fn(),
  requestId: null,
  refetch: vi.fn(),
});

let hooks: Record<string, HookState>;
const queried: Array<{ type: string; payload: unknown; skip: boolean }> = [];

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => hooks[type],
}));
vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown, options?: { skip?: boolean }) => {
    queried.push({ type, payload, skip: options?.skip === true });
    return hooks[type];
  },
}));

const SANDBOX = {
  id: 'org-1',
  alias: 'dev',
  username: 'admin@dev.invalid',
  status: 'connected',
  orgType: 'Sandbox',
};

function setOrg(org: Record<string, unknown>): void {
  useOrgStore.setState({ orgs: [org] as never, selectedOrgId: String(org.id) });
}

beforeEach(() => {
  hooks = {
    'dataops:empty:scope': { ...idle(), data: scopeAnswer() },
    'dataops:empty:preview': idle(),
    'dataops:empty:run': idle(),
    'dataops:empty:undo': idle(),
    'dataops:empty:cancel': idle(),
    'reports:audit': { ...idle(), data: { entries: [] } },
  };
  queried.length = 0;
  setOrg(SANDBOX);
});

const lastPayload = (type: string): Record<string, unknown> =>
  hooks[type].mutate.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('EmptyPanel', () => {
  it('refuses a production org and asks it nothing', () => {
    setOrg({ ...SANDBOX, orgType: 'Production' });
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    expect(screen.getByTestId('empty-production-refusal')).toHaveTextContent(
      'dev is a production org, or cannot be told from one.',
    );
    expect(queried.find((q) => q.type === 'dataops:empty:scope')?.skip).toBe(true);
    expect(screen.queryByTestId('empty-objects-preview')).toBeNull();
  });

  it('refuses an org the extension finds is a production org', () => {
    hooks['dataops:empty:scope'] = { ...idle(), error: 'production', errorCode: 'PRODUCTION' };
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    expect(screen.getByTestId('empty-production-refusal')).toBeInTheDocument();
  });

  it('greys the delete for good out without the permission, and says whose, never by a username', () => {
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    expect(screen.getByTestId('empty-objects-hard')).toBeDisabled();
    const why = screen.getByTestId('empty-objects-hard-why');
    expect(why).toHaveTextContent(
      "the user SandForge connects as doesn't have Bulk API Hard Delete",
    );
    expect(why).not.toHaveTextContent('admin@dev.invalid');
  });

  it('asks a delete for good of the objects picked only once it is permitted and ticked', () => {
    hooks['dataops:empty:scope'] = { ...idle(), data: scopeAnswer({ permitted: true }) };
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-pick-option-Contact'));
    fireEvent.click(screen.getByTestId('empty-objects-hard'));
    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    expect(lastPayload('dataops:empty:preview')).toEqual({
      orgId: 'org-1',
      request: { mode: 'objects', objects: ['Contact'] },
      deleteMode: 'hard',
      fromPage: true,
    });
  });

  it('opens with the objects a clone of the whole org asked to empty first picked', () => {
    render(<EmptyPanel orgId="org-1" orgName="dev" initialObjects={['Contact', 'Account']} />);
    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    expect(lastPayload('dataops:empty:preview')).toMatchObject({
      orgId: 'org-1',
      request: { mode: 'objects', objects: ['Contact', 'Account'] },
    });
  });

  it('says left out, with why, the objects asked to be emptied first that cannot be picked, and never asks them', () => {
    render(
      <EmptyPanel
        orgId="org-1"
        orgName="dev"
        initialObjects={['Contact', 'AccountFeed', 'Nowhere__c']}
      />,
    );
    const note = screen.getByTestId('empty-objects-preselected-left-out');
    expect(note).toHaveTextContent('2 objects asked to be emptied first are left out');
    expect(screen.getByTestId('empty-objects-preselected-left-out-chatter')).toHaveTextContent(
      'AccountFeed',
    );
    expect(screen.getByTestId('empty-objects-preselected-left-out-notFound')).toHaveTextContent(
      'Nowhere__c',
    );
    expect(screen.getByTestId('empty-pick-ticked')).toHaveTextContent('1 object picked: Contact');

    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    expect(lastPayload('dataops:empty:preview')).toMatchObject({
      request: { mode: 'objects', objects: ['Contact'] },
    });
  });

  it('says nothing left out when every object asked first may be picked', () => {
    render(<EmptyPanel orgId="org-1" orgName="dev" initialObjects={['contact', 'Account']} />);
    expect(screen.queryByTestId('empty-objects-preselected-left-out')).toBeNull();
  });

  it('runs on the work of the people the preview named once their box is ticked, and says whose in the confirmation', () => {
    const { rerender } = render(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-pick-option-Account'));
    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    hooks['dataops:empty:preview'] = {
      ...idle(),
      data: previewAnswer({
        peopleActive: {
          people: 1,
          who: [
            {
              userId: '005000000000077',
              name: 'Ada Example',
              records: 4,
              lastChangedAt: '2026-11-12T13:40:00.000Z',
            },
          ],
        },
        refusals: [{ code: 'PEOPLE_ACTIVE', message: '1 person other than the user…' }],
      }),
    };
    rerender(<EmptyPanel orgId="org-1" orgName="dev" />);
    expect(screen.getByTestId('empty-preview-empty')).toBeDisabled();

    fireEvent.click(screen.getByTestId('empty-preview-accept-people-active'));
    fireEvent.click(screen.getByTestId('empty-preview-empty'));
    expect(screen.getByTestId('empty-confirm-people-active')).toHaveTextContent(
      'What Ada Example changed in the last hour goes too.',
    );
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(lastPayload('dataops:empty:run')).toMatchObject({ acceptPeopleActive: true });
  });

  it('takes up the last emptying with the work of the people at work accepted only when ticked', () => {
    const { rerender } = render(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-pick-option-Account'));
    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    hooks['dataops:empty:preview'] = {
      ...idle(),
      data: previewAnswer({ openRun: { runId: RUN_ID, startedAt: '2026-11-12T14:05:12.000Z' } }),
    };
    rerender(<EmptyPanel orgId="org-1" orgName="dev" />);

    fireEvent.click(screen.getByTestId('empty-preview-resume'));
    expect(screen.getByTestId('empty-act-accept-people-active')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('empty-act-accept-people-active'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(lastPayload('dataops:empty:run')).toEqual({
      orgId: 'org-1',
      resumeRunId: RUN_ID,
      fromPage: true,
      acceptPeopleActive: true,
    });
  });

  it('asks the whole org with what is opted into and left out', () => {
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-org-files'));
    fireEvent.click(screen.getByTestId('empty-exclude-option-Task'));
    expect(screen.getByTestId('empty-org-objects')).toHaveTextContent('5 objects are emptied.');
    fireEvent.click(screen.getByTestId('empty-org-preview'));
    expect(lastPayload('dataops:empty:preview')).toEqual({
      orgId: 'org-1',
      request: { mode: 'org', excluded: ['Task'], files: true },
      deleteMode: 'recycle',
      fromPage: true,
    });
    // The scope is read again with what is opted into: files are emptied now.
    expect(queried.filter((q) => q.type === 'dataops:empty:scope').at(-1)?.payload).toEqual({
      orgId: 'org-1',
      mode: 'org',
      files: true,
    });
  });

  it('asks the whole org with the objects Salesforce does not bring back when ticked, and only then', () => {
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    expect(screen.getByTestId('empty-org-unrestorable')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('empty-org-unrestorable'));
    fireEvent.click(screen.getByTestId('empty-org-preview'));
    expect(lastPayload('dataops:empty:preview')).toEqual({
      orgId: 'org-1',
      request: { mode: 'org', unrestorable: true },
      deleteMode: 'recycle',
      fromPage: true,
    });
  });

  it('refuses the whole of a sandbox marked Staging, and offers its objects', () => {
    setOrg({ ...SANDBOX, staging: true });
    render(<EmptyPanel orgId="org-1" orgName="dev" />);
    expect(screen.getByTestId('empty-org-staging')).toHaveTextContent('marked Staging');
    expect(screen.queryByTestId('empty-org-preview')).toBeNull();
    expect(screen.getByTestId('empty-objects-staging')).toBeInTheDocument();
    // Its whole is refused: what may be picked is asked as the scope of none picked.
    expect(queried.filter((q) => q.type === 'dataops:empty:scope').at(-1)?.payload).toEqual({
      orgId: 'org-1',
      mode: 'objects',
      objects: [],
    });
  });

  it('empties as the preview said once the org name is typed, what fires accepted and the boxes as ticked', () => {
    const { rerender } = render(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-pick-option-Account'));
    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    hooks['dataops:empty:preview'] = { ...idle(), data: previewAnswer() };
    rerender(<EmptyPanel orgId="org-1" orgName="dev" />);

    fireEvent.click(screen.getByTestId('empty-preview-empty'));
    expect(screen.getByTestId('danger-confirm-btn')).toHaveTextContent(
      'Delete 670 records from 3 objects',
    );
    expect(screen.getByTestId('empty-confirm-blockers')).toHaveTextContent('2 records');
    expect(screen.getByTestId('danger-confirm-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(lastPayload('dataops:empty:run')).toEqual({
      orgId: 'org-1',
      previewId: 'ep-20261112-140500-c3d4',
      acceptAutomation: true,
      fromPage: true,
    });
  });

  it('asks the undo with the org name typed, what fires accepted only when ticked', () => {
    hooks['dataops:empty:run'] = { ...idle(), data: { operationId: 'r', result: runResultOf() } };
    const { rerender } = render(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-pick-option-Account'));
    fireEvent.click(screen.getByTestId('empty-objects-preview'));
    hooks['dataops:empty:preview'] = { ...idle(), data: previewAnswer() };
    rerender(<EmptyPanel orgId="org-1" orgName="dev" />);
    fireEvent.click(screen.getByTestId('empty-preview-empty'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    fireEvent.click(screen.getByTestId('empty-result-undo'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(lastPayload('dataops:empty:undo')).toEqual({
      orgId: 'org-1',
      runId: RUN_ID,
      fromPage: true,
    });
  });
});
