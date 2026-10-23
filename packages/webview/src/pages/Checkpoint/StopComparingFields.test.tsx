import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { OrgCheckpoint } from '@sandforge/shared';
import { fakeHost, polyfillDialog, readyCheckpoint } from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { StopComparingFields } from './StopComparingFields';

/** The default checkpoint, its Account holding a field automation sets, one already left out. */
function checkpointWith(ignoredFields: string[] = ['contact.lastname']): OrgCheckpoint {
  const base = readyCheckpoint();
  return readyCheckpoint({
    ignoredFields,
    objects: base.objects.map((object) =>
      object.objectApiName === 'Account'
        ? { ...object, fields: ['Id', 'SystemModstamp', 'Name', 'Score__c'] }
        : object,
    ),
  });
}

/** The dialog over `checkpoint`, with spies for what it tells its caller. */
function renderDialog(checkpoint = checkpointWith(), objects?: string[]) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <StopComparingFields
      checkpoint={checkpoint}
      {...(objects ? { objects } : {})}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onClose, onSaved };
}

/** The fields the dialog lists, in its order. */
function listed(): string[] {
  return within(screen.getByTestId('checkpoint-stop-comparing-fields'))
    .getAllByRole('checkbox')
    .map((box) => box.parentElement?.textContent ?? '');
}

describe('StopComparingFields', () => {
  beforeEach(() => {
    host.current = fakeHost();
    polyfillDialog();
  });

  it('offers every field the checkpoint compares, those it already leaves out first and ticked, never its stamps', () => {
    renderDialog();
    expect(
      screen.getByRole('heading', { name: 'Stop comparing fields of “Before UAT”' }),
    ).toBeInTheDocument();
    expect(listed()).toEqual([
      'Contact.LastName',
      'Account.Name',
      'Account.Score__c',
      'Contact.AccountId',
      'Campaign.Name',
    ]);
    expect(screen.getByTestId('checkpoint-stop-comparing-Contact.LastName')).toBeChecked();
    expect(screen.getByTestId('checkpoint-stop-comparing-Account.Score__c')).not.toBeChecked();
    expect(screen.getByTestId('checkpoint-stop-comparing-count').textContent).toBe(
      '1 field not compared',
    );
  });

  it('offers only the fields of the objects named', () => {
    renderDialog(checkpointWith(), ['Account']);
    expect(listed()).toEqual(['Account.Name', 'Account.Score__c']);
  });

  it('saves the whole list the checkpoint stops comparing, those of the objects not offered kept', () => {
    const { onSaved } = renderDialog(checkpointWith(), ['Account']);
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-Account.Score__c'));
    expect(screen.getByTestId('checkpoint-stop-comparing-count').textContent).toBe(
      '1 field not compared',
    );
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-save'));
    expect(host.current?.lastPayload('checkpoint:ignore-fields')).toEqual({
      checkpointId: 'ck-20261020-140512-a1b2',
      fields: ['contact.lastname', 'Account.Score__c'],
    });
    expect(onSaved).not.toHaveBeenCalled();
    const saved = checkpointWith(['contact.lastname', 'Account.Score__c']);
    act(() =>
      host.current?.answer('checkpoint:ignore-fields', 'checkpoint:ignore-fields:response', {
        checkpoint: saved,
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(saved, ['Account.Score__c']);
  });

  it('compares again a field unticked', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-Contact.LastName'));
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-save'));
    expect(host.current?.lastPayload('checkpoint:ignore-fields')).toEqual({
      checkpointId: 'ck-20261020-140512-a1b2',
      fields: [],
    });
  });

  it('filters the fields by name, and says when none matches', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('checkpoint-stop-comparing-filter'), {
      target: { value: 'score' },
    });
    expect(listed()).toEqual(['Account.Score__c']);
    fireEvent.change(screen.getByTestId('checkpoint-stop-comparing-filter'), {
      target: { value: 'nothing like it' },
    });
    expect(screen.getByText('No field matches.')).toBeInTheDocument();
  });

  it('lists fifty fields at once, and says the filter reaches the others', () => {
    const base = readyCheckpoint();
    const wide = readyCheckpoint({
      objects: [
        {
          ...base.objects[0]!,
          fields: ['Id', ...Array.from({ length: 60 }, (_, i) => `Field_${i}__c`)],
        },
      ],
    });
    renderDialog(wide);
    expect(listed()).toHaveLength(50);
    expect(screen.getByTestId('checkpoint-stop-comparing-more').textContent).toBe(
      '50 of 60 shown: filter to find the others.',
    );
  });

  it('says a change the extension refused, and keeps the choice', () => {
    const { onSaved } = renderDialog();
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-save'));
    act(() =>
      host.current?.fail('checkpoint:ignore-fields', {
        message: 'The checkpoint was not changed: a rewind is writing.',
        code: 'RUN_WRITING',
      }),
    );
    expect(screen.getByTestId('checkpoint-stop-comparing-error')).toHaveTextContent(
      'The checkpoint was not changed: a rewind is writing.',
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('checkpoint-stop-comparing-Contact.LastName')).toBeChecked();
  });

  it('changes nothing on Cancel', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByTestId('checkpoint-stop-comparing-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.current?.sent('checkpoint:ignore-fields')).toEqual([]);
  });
});
