import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { soqlRootQueryIssue, type ForgeRootsPreview } from '@sandforge/shared';
import i18n from '../../i18n';
import { ForgeSoqlNotices } from './ForgeSoqlNotices';
import type { RootsPreviewState } from './useRootsPreview';

const sent = vi.hoisted(() => [] as Array<{ type: string; payload: unknown }>);
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload: unknown) => {
    sent.push({ type, payload });
  },
}));

const ENERGY = "SELECT Id FROM Account WHERE Industry = 'Energy'";

/** What the read of `query` answered, as the extension says it. */
function read(preview: Partial<ForgeRootsPreview>, readAgain = vi.fn()): RootsPreviewState {
  return {
    status: 'read',
    preview: {
      sourceOrgId: 'src',
      soqlQuery: ENERGY,
      objectApiName: 'Account',
      cap: 200,
      chosen: 37,
      more: false,
      requests: 1,
      ...preview,
    },
    readAgain,
  };
}

describe('ForgeSoqlNotices', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('says the query chooses the records to clone, with what they reach, and that other records of their object come as parents', () => {
    render(<ForgeSoqlNotices query={ENERGY} issue={undefined} />);

    expect(screen.getByTestId('forge-roots-info').textContent).toBe(
      i18n.t('forge.roots.info', { object: 'Account' }),
    );
    expect(screen.queryByTestId('forge-roots-issue')).toBeNull();
  });

  it('says how many records the query chooses, read before Discover', () => {
    render(<ForgeSoqlNotices query={ENERGY} issue={undefined} roots={read({ chosen: 37 })} />);

    const said = screen.getByTestId('forge-roots-said');
    expect(said.getAttribute('role')).toBe('status');
    expect(said.textContent).toBe(
      i18n.t('forge.roots.chosen', { count: 37, formatted: '37', object: 'Account', cap: '200' }),
    );
    expect(screen.queryByTestId('forge-roots-newest')).toBeNull();
  });

  it('offers the newest of them, the setting and a new read when the query chooses more than a run takes', () => {
    const readAgain = vi.fn();
    const onTakeNewest = vi.fn();
    render(
      <ForgeSoqlNotices
        query={ENERGY}
        issue={undefined}
        roots={read({ chosen: 200, more: true }, readAgain)}
        onTakeNewest={onTakeNewest}
      />,
    );

    expect(screen.getByTestId('forge-roots-said').textContent).toBe(
      i18n.t('forge.roots.more', { object: 'Account', cap: '200' }),
    );
    fireEvent.click(screen.getByTestId('forge-roots-newest'));
    expect(onTakeNewest).toHaveBeenCalledWith(200);
    fireEvent.click(screen.getByTestId('forge-roots-setting'));
    expect(sent).toEqual([
      { type: 'workbench:open-setting', payload: { setting: 'sandforge.forge.maxRoots' } },
    ]);
    fireEvent.click(screen.getByTestId('forge-roots-read-again'));
    expect(readAgain).toHaveBeenCalledTimes(1);
  });

  it('offers no newest of a query whose own LIMIT is past the most, and says to lower it', () => {
    const query = `${ENERGY} LIMIT 500`;
    render(
      <ForgeSoqlNotices
        query={query}
        issue={undefined}
        roots={read({ soqlQuery: query, chosen: 200, more: true, limit: 500 })}
        onTakeNewest={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('forge-roots-newest')).toBeNull();
    expect(screen.getByTestId('forge-roots-said').textContent).toBe(
      i18n.t('forge.roots.moreThanLimit', { object: 'Account', cap: '200', limit: '500' }),
    );
  });

  it('says a query that chooses none, that its run would be refused', () => {
    render(<ForgeSoqlNotices query={ENERGY} issue={undefined} roots={read({ chosen: 0 })} />);

    expect(screen.getByTestId('forge-roots-said').textContent).toBe(
      i18n.t('forge.roots.none', { object: 'Account' }),
    );
  });

  it('says a read that failed, with the extension’s words, and offers to read again', () => {
    render(
      <ForgeSoqlNotices
        query={ENERGY}
        issue={undefined}
        roots={{ status: 'failed', error: "No such column 'Nope__c'", readAgain: vi.fn() }}
      />,
    );

    expect(screen.getByTestId('forge-roots-said').textContent).toBe(
      i18n.t('forge.roots.failed', { message: "No such column 'Nope__c'" }),
    );
    expect(screen.getByTestId('forge-roots-read-again')).toBeTruthy();
  });

  it('refuses a query whose clause changes the rows it returns, and says nothing else of it', () => {
    const query = 'SELECT Industry FROM Account GROUP BY Industry';
    render(<ForgeSoqlNotices query={query} issue={soqlRootQueryIssue(query)} />);

    const issue = screen.getByTestId('forge-roots-issue');
    expect(issue.getAttribute('role')).toBe('alert');
    expect(issue.textContent).toBe(i18n.t('forge.roots.issue.refused', { clause: 'GROUP BY' }));
    expect(screen.queryByTestId('forge-roots-info')).toBeNull();
    expect(screen.queryByTestId('forge-roots-line')).toBeNull();
  });

  it('names the object when its name is refused, and the comment marker of a WHERE', () => {
    const { rerender } = render(
      <ForgeSoqlNotices
        query="SELECT Id FROM 1Account WHERE Name = 'a'"
        issue={soqlRootQueryIssue("SELECT Id FROM 1Account WHERE Name = 'a'")}
      />,
    );
    expect(screen.getByTestId('forge-roots-issue').textContent).toBe(
      i18n.t('forge.roots.issue.object', { object: '1Account' }),
    );

    const marked = "SELECT Id FROM Account WHERE Name = 'a' -- and the rest";
    rerender(<ForgeSoqlNotices query={marked} issue={soqlRootQueryIssue(marked)} />);
    expect(screen.getByTestId('forge-roots-issue').textContent).toBe(
      i18n.t('forge.roots.issue.where'),
    );
  });

  it('says a query saved before 1.81.0 now clones the records it chooses, to be simulated first', () => {
    render(<ForgeSoqlNotices query={ENERGY} issue={undefined} before181 />);

    expect(screen.getByTestId('forge-roots-before-181').textContent).toBe(
      i18n.t('forge.roots.before181'),
    );
  });

  it('says nothing of an empty query', () => {
    const { container } = render(<ForgeSoqlNotices query="  " issue={{ kind: 'noObject' }} />);

    expect(container.textContent).toBe('');
  });
});
