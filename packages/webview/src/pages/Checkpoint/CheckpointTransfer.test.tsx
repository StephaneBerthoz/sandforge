import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import {
  developerOrg,
  exportAnswer,
  fakeHost,
  importReadAnswer,
  polyfillDialog,
  readyCheckpoint,
  SHOWN_KEY,
} from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { ExportCheckpoint, ImportCheckpoint } from './CheckpointTransfer';

/** Whether any value of `payload` looks like a place on a disk: a separator, a drive. */
function namesAPath(payload: Record<string, unknown> | undefined): boolean {
  return Object.values(payload ?? {}).some(
    (value) => typeof value === 'string' && /[\\/]|^[A-Za-z]:/.test(value),
  );
}

/** The import dialog over `read`, the dev sandbox and a second org registered, with spies. */
function renderImport(read = importReadAnswer(), currentOrgId = 'org-dev') {
  const onImported = vi.fn();
  const onClose = vi.fn();
  const orgs = [developerOrg(), developerOrg({ id: 'org-qa', alias: 'QA-SB' })];
  render(
    <ImportCheckpoint
      read={read}
      orgs={orgs}
      currentOrgId={currentOrgId}
      onImported={onImported}
      onClose={onClose}
    />,
  );
  return { onImported, onClose };
}

/** Type the key, then press Import. */
function importWith(key: string): void {
  fireEvent.change(screen.getByLabelText('Key the file was exported with'), {
    target: { value: key },
  });
  fireEvent.click(screen.getByTestId('checkpoint-import-confirm'));
}

describe('ExportCheckpoint', () => {
  beforeEach(() => {
    host.current = fakeHost();
    polyfillDialog();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the file was saved by its name, encrypted, with what it holds, and shows the key in its groups', () => {
    render(
      <ExportCheckpoint
        exported={exportAnswer()}
        name="Before UAT"
        orgName="DEV-SB"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: '“Before UAT” exported' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Saved as before-uat.sfcheckpoint, encrypted: 2,412 records of 3 objects, 1.2 MB.',
    );
    expect(screen.getByText('The key, shown this once and kept nowhere')).toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-export-key').textContent).toBe(SHOWN_KEY);
  });

  it('says who can read the file and how to send its key, and that the file does not expire', () => {
    render(
      <ExportCheckpoint
        exported={exportAnswer()}
        name="Before UAT"
        orgName="DEV-SB"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('checkpoint-export-warning').textContent).toBe(
      'Anyone who has this file and its key can read the 2,412 records it holds of DEV-SB, ' +
        'personal data among them. Send the key another way than the file, and only to people ' +
        'who already see all data in DEV-SB.',
    );
    expect(screen.getByTestId('checkpoint-export-no-expiry').textContent).toBe(
      'The file does not expire: delete it once it has served. It carries neither the journals ' +
        'of the rewinds made from this machine nor their Undo, which stay here.',
    );
  });

  it('says one record as one', () => {
    render(
      <ExportCheckpoint
        exported={exportAnswer({ records: 1, objects: 1 })}
        name="Before UAT"
        orgName="DEV-SB"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('checkpoint-export-warning').textContent).toContain(
      'can read the record it holds of DEV-SB',
    );
  });

  it('copies the key whole, and says so only once the clipboard took it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <ExportCheckpoint
        exported={exportAnswer()}
        name="Before UAT"
        orgName="DEV-SB"
        onClose={vi.fn()}
      />,
    );
    const copy = screen.getByRole('button', { name: 'Copy the key' });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith(SHOWN_KEY);
    expect(screen.getByRole('button', { name: 'Key copied' })).toBe(copy);
  });

  it('claims no copy the host refused', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <ExportCheckpoint
        exported={exportAnswer()}
        name="Before UAT"
        orgName="DEV-SB"
        onClose={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the key' }));
    });
    expect(screen.getByRole('button', { name: 'Copy the key' })).toBeInTheDocument();
  });

  it('closes on Done, sending nothing: the key goes with the dialog', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <ExportCheckpoint
        exported={exportAnswer()}
        name="Before UAT"
        orgName="DEV-SB"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('checkpoint-export-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.body.textContent).not.toContain(SHOWN_KEY);
    expect(host.current?.sent()).toEqual([]);
  });
});

describe('ImportCheckpoint', () => {
  beforeEach(() => {
    host.current = fakeHost();
    polyfillDialog();
  });

  it('says what the file holds as its header says it: the org, the records, when it was taken, which SandForge made it, its format and size', () => {
    renderImport();
    expect(screen.getByRole('heading', { name: 'Import a checkpoint' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'before-uat.sfcheckpoint, as its header says it: nothing is decrypted before you import it.',
    );
    const fact = (id: string) => screen.getByTestId(`checkpoint-import-fact-${id}`).textContent;
    expect(fact('org')).toBe('DEV-SB');
    expect(fact('records')).toBe('2,412 records of 3 objects');
    expect(fact('taken')).toBe('Oct 20, 2026');
    expect(fact('made-by')).toBe('SandForge 1.71.0');
    expect(fact('format')).toBe('file format 1, checkpoint format 1');
    expect(fact('size')).toBe('2.3 MB');
  });

  it('asks for the key typed hidden, and holds Import until one is typed', () => {
    renderImport();
    const key = screen.getByLabelText('Key the file was exported with');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveAttribute('autocomplete', 'off');
    expect(key).toHaveAccessibleDescription(
      '52 letters and digits, with their dashes or without. Not shown as you type it.',
    );
    expect(screen.getByTestId('checkpoint-import-confirm')).toBeDisabled();
    fireEvent.change(key, { target: { value: '   ' } });
    expect(screen.getByTestId('checkpoint-import-confirm')).toBeDisabled();
  });

  it('says what a rewind from this machine does not compare, that two machines rewinding fight each other, and where the Undo of the others stayed', () => {
    renderImport();
    const warnings = screen.getByTestId('checkpoint-import-warnings');
    expect([...warnings.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'A field your user cannot see in DEV-SB is not compared by a rewind from this machine, ' +
        'nor written back: its preview names it not compared.',
      'Rewinds of DEV-SB from two machines at once fight each other: the lock is per machine. ' +
        'Agree on who rewinds.',
      'The rewinds made from the machine it came from, and their Undo, stayed there.',
    ]);
  });

  it('imports for the org the page shows, naming the file by its token and never by a path, the key as typed and 30 days', () => {
    renderImport();
    importWith(`  ${SHOWN_KEY.toLowerCase()} `);
    const sent = host.current?.sent('checkpoint:import') ?? [];
    expect(sent).toHaveLength(1);
    const payload = host.current?.lastPayload('checkpoint:import');
    expect(payload).toEqual({
      token: '7d0c4c9e-2f6b-4a8e-9a43-0b6f8f6a1c2d',
      orgId: 'org-dev',
      key: SHOWN_KEY.toLowerCase(),
      keepDays: 30,
    });
    expect(namesAPath(payload)).toBe(false);
  });

  it('keeps the checkpoint until it is deleted once Keep until I delete it is ticked', () => {
    renderImport();
    expect(screen.getByText(/^Kept on this machine until/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('checkpoint-import-keep'));
    expect(screen.queryByText(/^Kept on this machine until/)).toBeNull();
    importWith(SHOWN_KEY);
    expect(host.current?.lastPayload('checkpoint:import')).toMatchObject({ keepDays: 0 });
  });

  it('offers the orgs the file can be imported for, the one the page shows first, and names the one picked', () => {
    renderImport(importReadAnswer({ orgIds: ['org-qa', 'org-dev'] }));
    const select = screen.getByLabelText('Import for');
    expect(select).toHaveValue('org-dev');
    fireEvent.change(select, { target: { value: 'org-qa' } });
    expect(screen.getByTestId('checkpoint-import-fact-org').textContent).toBe('QA-SB');
    expect(screen.getByTestId('checkpoint-import-warnings').textContent).toContain(
      'Rewinds of QA-SB from two machines at once',
    );
    importWith(SHOWN_KEY);
    expect(host.current?.lastPayload('checkpoint:import')).toMatchObject({ orgId: 'org-qa' });
  });

  it('offers no org nor key for a file of an org not connected here, and says which org it is of', () => {
    renderImport(importReadAnswer({ orgIds: [] }));
    expect(screen.getByTestId('checkpoint-import-not-connected').textContent).toBe(
      'No org connected in SandForge is the org this file holds a checkpoint of, Organization ' +
        'Id 00Dxx0000001234AAA: connect it, then import the file.',
    );
    expect(screen.queryByLabelText('Key the file was exported with')).toBeNull();
    expect(screen.queryByTestId('checkpoint-import-confirm')).toBeNull();
    expect(screen.getByTestId('checkpoint-import-cancel')).toHaveTextContent('Close');
  });

  it('says a checkpoint of the file’s id is kept here already', () => {
    renderImport(importReadAnswer({ keptHere: true }));
    expect(screen.getByTestId('checkpoint-import-kept-here').textContent).toBe(
      'A checkpoint of this id is kept on this machine already: the import leaves it as it is ' +
        'when it is the same, and is refused when it is not.',
    );
  });

  it.each([
    ['IMPORT_KEY', 'This key is not the one the file was exported with. Nothing was imported.'],
    [
      'IMPORT_DAMAGED',
      'This checkpoint file holds a block that does not decrypt: it was changed or damaged after it was exported. Nothing was imported.',
    ],
    [
      'PERMISSIONS',
      'An import needs a user with View All Data and Modify All Data in DEV-SB. Nothing was imported.',
    ],
    [
      'IMPORT_KEPT_OTHER',
      'A checkpoint ck-20261020-140512-a1b2 is kept on this machine already, another one: delete it first to import this file. Nothing was imported.',
    ],
  ])(
    'says the refusal %s in the extension’s words, and lets the key be typed again',
    (code, message) => {
      const { onImported } = renderImport();
      importWith(SHOWN_KEY);
      act(() => host.current?.fail('checkpoint:import', { code, message }));
      expect(screen.getByTestId('checkpoint-import-error')).toHaveTextContent(message);
      expect(screen.getByLabelText('Key the file was exported with')).toBeInTheDocument();
      expect(onImported).not.toHaveBeenCalled();
    },
  );

  it('says the checkpoint imported, until when it is kept, and has the list read again', () => {
    const { onImported, onClose } = renderImport();
    importWith(SHOWN_KEY);
    act(() =>
      host.current?.answer('checkpoint:import', 'checkpoint:import:response', {
        checkpoint: readyCheckpoint(),
        outcome: 'imported',
      }),
    );
    expect(screen.getByTestId('checkpoint-import-outcome').textContent).toBe(
      'Imported “Before UAT”: listed now among the checkpoints of DEV-SB, and kept until Nov 19, 2026.',
    );
    expect(screen.queryByLabelText('Key the file was exported with')).toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('checkpoint-import-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says a checkpoint kept until it is deleted, and one kept here already the same', () => {
    renderImport();
    importWith(SHOWN_KEY);
    act(() =>
      host.current?.answer('checkpoint:import', 'checkpoint:import:response', {
        checkpoint: readyCheckpoint({ expiresAt: null }),
        outcome: 'imported',
      }),
    );
    expect(screen.getByTestId('checkpoint-import-outcome').textContent).toBe(
      'Imported “Before UAT”: listed now among the checkpoints of DEV-SB, and kept until you delete it.',
    );
  });

  it('says the same checkpoint was kept here already, and left as it is', () => {
    renderImport();
    importWith(SHOWN_KEY);
    act(() =>
      host.current?.answer('checkpoint:import', 'checkpoint:import:response', {
        checkpoint: readyCheckpoint(),
        outcome: 'alreadyKept',
      }),
    );
    expect(screen.getByTestId('checkpoint-import-outcome').textContent).toBe(
      '“Before UAT” is kept on this machine already, the same: it was left as it is.',
    );
  });
});
