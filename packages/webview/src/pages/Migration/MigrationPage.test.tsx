import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { MigrationPage } from './MigrationPage';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */

/** A mutation as the page reads it, its state set by each test. */
interface MockMutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  reset: ReturnType<typeof vi.fn>;
}

function mutationState(data: Record<string, unknown> | null = null): MockMutationState {
  return { mutate: vi.fn(), data, loading: false, error: null, errorCode: null, reset: vi.fn() };
}

/** migration:import-sfdmu, migration:save-sync-config and migration:pick-file. */
let importState = mutationState();
let saveState = mutationState();
let pickState = mutationState();

/** Every channel the page set up a mutation on. */
const asked = new Set<string>();

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    asked.add(type);
    if (type === 'migration:import-sfdmu') return importState;
    if (type === 'migration:save-sync-config') return saveState;
    if (type === 'migration:pick-file') return pickState;
    return mutationState();
  },
}));

/** Converted SyncConfig as returned by the SFDMU importer. */
const sfdmuConfig: Record<string, unknown> = {
  id: 'cfg-1',
  name: 'SFDMU Import',
  description: 'Imported from SFDMU export.json',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  direction: 'source_to_target',
  mode: 'full',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      externalIdField: 'External_Id__c',
      fieldMappings: [{ sourceField: 'a', targetField: 'b', type: 'rename' }],
      transformRules: [],
      excludedFields: ['CreatedDate'],
      addOnFields: [],
      batchSize: 200,
      insertOrder: 1,
    },
    {
      objectApiName: 'Contact',
      operation: 'insert',
      fieldMappings: [],
      transformRules: [
        { type: 'prefix', config: { prefix: 'QA-' } },
        { type: 'suffix', config: { suffix: '-x' } },
      ],
      excludedFields: [],
      addOnFields: [],
      batchSize: 200,
      insertOrder: 2,
    },
  ],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const [account, contact] = sfdmuConfig.objects as Array<Record<string, unknown>>;

beforeEach(() => {
  importState = mutationState();
  saveState = mutationState();
  pickState = mutationState();
  asked.clear();
  useAppStore.setState({ currentRoute: 'migration', navigationIntent: null });
  useOrgStore.setState({
    orgs: [
      { id: 'org-a', alias: 'devA', username: 'a@e.com', orgType: 'Sandbox', tags: [] },
      { id: 'org-b', alias: 'devB', username: 'b@e.com', orgType: 'Sandbox', tags: [] },
    ] as never,
  });
});

function typePath(value: string): void {
  fireEvent.change(screen.getByTestId('migration-path-input'), { target: { value } });
}

describe('MigrationPage — the file to import', () => {
  it('opens on the SFDMU export.json importer, with no card for a CSV or JSON data file', () => {
    // "CSV or JSON file" promised its columns mapped to Salesforce fields: it
    // read the column names, dropped the rows and named the object after the
    // file, so a run copied the source org's own records.
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-page')).toBeDefined();
    expect(screen.getByTestId('migration-source-card').textContent).toContain('SFDMU export.json');
    expect(screen.queryByTestId('migration-type-universal')).toBeNull();
    expect(screen.getByTestId('migration-page').textContent).not.toMatch(/CSV or JSON/);
    expect(asked.has('migration:import')).toBe(false);
  });

  it('sends a CSV file of records to Seed’s CSV Upload, which loads its rows', () => {
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-csv-data').textContent).toContain(
      "Seed's CSV Upload loads a CSV file's rows into an org.",
    );

    fireEvent.click(screen.getByTestId('migration-csv-data-btn'));

    expect(useAppStore.getState().currentRoute).toBe('seed');
    expect(useAppStore.getState().navigationIntent).toEqual({ route: 'seed', seedMode: 'csv' });
  });

  it('offers neutral example paths, not Windows ones', () => {
    // "C:/projects/sfdmu/export.json" was the example on Linux and macOS too.
    render(<MigrationPage />);
    const input = screen.getByTestId('migration-path-input') as HTMLInputElement;
    expect(input.placeholder).toBe('/path/to/export.json');
    typePath('relative/export.json');
    expect(screen.getByText(/The path must be absolute/).textContent).not.toMatch(/C:/);
  });

  it('fills File path with the file Browse… picked in the window’s dialog', () => {
    const { rerender } = render(<MigrationPage />);

    fireEvent.click(screen.getByTestId('migration-browse-btn'));
    expect(pickState.mutate).toHaveBeenCalledTimes(1);

    pickState = mutationState({ filePath: '/home/user/sfdmu/export.json' });
    rerender(<MigrationPage />);

    expect((screen.getByTestId('migration-path-input') as HTMLInputElement).value).toBe(
      '/home/user/sfdmu/export.json',
    );
    fireEvent.click(screen.getByTestId('migration-import-btn'));
    expect(importState.mutate).toHaveBeenCalledWith({ filePath: '/home/user/sfdmu/export.json' });
  });

  it('leaves File path as typed when the dialog was closed', () => {
    const { rerender } = render(<MigrationPage />);
    typePath('/home/user/typed/export.json');
    fireEvent.click(screen.getByTestId('migration-browse-btn'));

    pickState = mutationState({});
    rerender(<MigrationPage />);

    expect((screen.getByTestId('migration-path-input') as HTMLInputElement).value).toBe(
      '/home/user/typed/export.json',
    );
  });

  it('says why Browse… was refused', () => {
    pickState = { ...mutationState(), error: 'pick a file there' };
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-browse-error').textContent).toContain('pick a file there');
  });

  it('should keep the import button disabled while the path is empty', () => {
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-import-btn').hasAttribute('disabled')).toBe(true);
  });

  it('should reject a relative path with a validation error', () => {
    render(<MigrationPage />);
    typePath('relative/path/export.json');
    expect(screen.getByText(/The path must be absolute/)).toBeDefined();
    expect(screen.getByTestId('migration-import-btn').hasAttribute('disabled')).toBe(true);
    expect(importState.mutate).not.toHaveBeenCalled();
  });

  it('refuses a .csv path: the importer takes an export.json', () => {
    render(<MigrationPage />);
    typePath('/home/user/data.csv');
    expect(screen.getByText('Unsupported file extension. Expected: .json.')).toBeDefined();
    expect(screen.getByTestId('migration-import-btn').hasAttribute('disabled')).toBe(true);
  });

  it('should send migration:import-sfdmu with the trimmed absolute path', () => {
    render(<MigrationPage />);
    typePath('  /home/user/sfdmu/export.json  ');
    fireEvent.click(screen.getByTestId('migration-import-btn'));
    expect(importState.mutate).toHaveBeenCalledWith({ filePath: '/home/user/sfdmu/export.json' });
  });

  it('should accept a Windows drive path', () => {
    render(<MigrationPage />);
    typePath('C:\\projects\\sfdmu\\export.json');
    fireEvent.click(screen.getByTestId('migration-import-btn'));
    expect(importState.mutate).toHaveBeenCalledWith({
      filePath: 'C:\\projects\\sfdmu\\export.json',
    });
  });

  it('should display the error carried by a failed response payload', () => {
    importState = mutationState({ success: false, error: 'Invalid import path: not absolute.' });
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-error').textContent).toContain(
      'Invalid import path: not absolute.',
    );
  });

  it('should display a bridge-level error', () => {
    importState = { ...mutationState(), error: 'Request timed out' };
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-error').textContent).toContain('Request timed out');
  });

  it('should show the loading state while importing', () => {
    importState = { ...mutationState(), loading: true };
    render(<MigrationPage />);
    const button = screen.getByTestId('migration-import-btn');
    expect(button.textContent).toBe('Importing…');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should reset the form and the mutations when starting a new import', () => {
    importState = mutationState({ success: true, config: sfdmuConfig });
    render(<MigrationPage />);
    typePath('/home/user/sfdmu/export.json');
    fireEvent.click(screen.getByTestId('migration-reset-btn'));
    expect(importState.reset).toHaveBeenCalled();
    expect(saveState.reset).toHaveBeenCalled();
    expect((screen.getByTestId('migration-path-input') as HTMLInputElement).value).toBe('');
  });
});

describe('MigrationPage — the imported config', () => {
  beforeEach(() => {
    importState = mutationState({ success: true, config: sfdmuConfig });
  });

  it('lists each object once, in the editor, with what it carries under its row in the plural it takes', () => {
    // The objects were listed twice, read-only above the editor, and the
    // counts read "1 field mappings".
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-result')).toBeDefined();
    expect(screen.queryByTestId('migration-objects')).toBeNull();
    expect(screen.getAllByText('Account')).toHaveLength(1);
    expect(screen.getByTestId('object-detail-Account').textContent).toBe(
      '1 field mapping · 0 transform rules · 1 excluded field',
    );
    expect(screen.getByTestId('object-detail-Contact').textContent).toBe(
      '0 field mappings · 2 transform rules · 0 excluded fields',
    );
    expect(screen.getByTestId('migration-raw-config')).toBeDefined();
  });
});

describe('MigrationPage — saving the import and opening it in Sync', () => {
  beforeEach(() => {
    importState = mutationState({ success: true, config: sfdmuConfig });
  });

  type SentConfig = Record<string, unknown> & { objects: Array<Record<string, unknown>> };

  function pickOrgs(): void {
    fireEvent.change(screen.getByTestId('migration-run-source'), { target: { value: 'org-a' } });
    fireEvent.change(screen.getByTestId('migration-run-target'), { target: { value: 'org-b' } });
  }

  /** Pick the two orgs, name the configuration, save, and return what was sent. */
  function saveAndRead(name = 'Nightly accounts'): { name: string; config: SentConfig } {
    pickOrgs();
    fireEvent.change(screen.getByTestId('migration-save-sync-name'), { target: { value: name } });
    fireEvent.click(screen.getByTestId('migration-save-sync-btn'));
    expect(saveState.mutate).toHaveBeenCalledTimes(1);
    return saveState.mutate.mock.calls[0][0] as { name: string; config: SentConfig };
  }

  /** The host's answer to the save, as the page reads it on its next render. */
  function hostSaved(rerender: (ui: React.ReactElement) => void, id = 'cfg-9'): void {
    saveState = { ...saveState, data: { success: true, id, name: 'Nightly accounts' } };
    rerender(<MigrationPage />);
  }

  it('runs nothing itself: no Run sync, and no sync:execute or sync:simulate set up', () => {
    // Its Run sync waited 120 s, said "Try again" while the host went on
    // writing, and a second click wrote every record twice.
    render(<MigrationPage />);
    expect(screen.queryByTestId('migration-run-btn')).toBeNull();
    expect(screen.queryByText('Run sync')).toBeNull();
    expect(asked.has('sync:execute')).toBe(false);
    expect(asked.has('sync:simulate')).toBe(false);
  });

  it('opens the configuration saved on Sync’s execute step, between the orgs picked', () => {
    const { rerender } = render(<MigrationPage />);
    saveAndRead();
    expect(screen.queryByTestId('migration-open-in-sync-btn')).toBeNull();

    hostSaved(rerender);
    expect(screen.getByTestId('migration-save-sync-saved').textContent).toBe(
      'Saved as the Sync configuration “Nightly accounts”: the Sync page lists it with its saved configurations, and a schedule can run it.',
    );
    fireEvent.click(screen.getByTestId('migration-open-in-sync-btn'));

    expect(useAppStore.getState().currentRoute).toBe('sync');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'sync',
      sourceOrgId: 'org-a',
      targetOrgId: 'org-b',
      syncConfig: { id: 'cfg-9', name: 'Nightly accounts' },
    });
  });

  it('keeps Save off once the configuration on screen is saved: a second save would be refused its name', () => {
    const { rerender } = render(<MigrationPage />);
    saveAndRead();
    hostSaved(rerender);
    expect((screen.getByTestId('migration-save-sync-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('offers no Open in Sync for a configuration changed since it was saved', () => {
    // Sync would have opened what was saved, not what the page shows.
    const { rerender } = render(<MigrationPage />);
    saveAndRead();
    hostSaved(rerender);

    fireEvent.click(screen.getByTestId('remove-obj-Contact'));

    expect(screen.queryByTestId('migration-open-in-sync-btn')).toBeNull();
    expect(screen.getByTestId('migration-save-sync-changed').textContent).toBe(
      'Changed since it was saved as “Nightly accounts”: save it under another name to open it in Sync.',
    );
    expect((screen.getByTestId('migration-save-sync-btn') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('saves the config as edited here, between the orgs picked here, under the name given', () => {
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('remove-obj-Contact'));

    const sent = saveAndRead('  Nightly accounts  ');

    expect(sent.name).toBe('Nightly accounts');
    expect(sent.config).toMatchObject({ sourceOrgId: 'org-a', targetOrgId: 'org-b' });
    // Excluded fields, mappings and add-on fields go as the import gave them.
    expect(sent.config.objects).toEqual([account]);
    expect(sent.config.name).toBe('SFDMU Import');
  });

  it('saves an object with the operation, External ID, batch size and filter edited here', () => {
    render(<MigrationPage />);
    fireEvent.change(screen.getByLabelText('Operation — Contact'), { target: { value: 'upsert' } });
    fireEvent.change(screen.getByLabelText('External ID — Contact'), {
      target: { value: 'Ext_Key__c' },
    });
    fireEvent.change(screen.getByLabelText('Batch Size — Contact'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('WHERE clause — Contact'), {
      target: { value: 'LastName != null' },
    });

    expect(saveAndRead().config.objects).toEqual([
      account,
      {
        ...contact,
        operation: 'upsert',
        externalIdField: 'Ext_Key__c',
        batchSize: 50,
        where: 'LastName != null',
      },
    ]);
  });

  it('puts a removed object back as imported, where it stood', () => {
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('remove-obj-Account'));

    const addRow = screen.getByTestId('add-object-row');
    fireEvent.change(within(addRow).getByRole('combobox'), { target: { value: 'Account' } });
    fireEvent.click(screen.getByTestId('add-object-btn'));

    expect(saveAndRead().config.objects).toEqual([account, contact]);
  });

  it('names each org with its type, and picks none until the user does', () => {
    useOrgStore.setState({
      orgs: [
        { id: 'org-a', alias: 'devA', username: 'a@e.com', orgType: 'Sandbox', tags: [] },
        { id: 'org-p', alias: '', username: 'p@e.com', orgType: 'Production', tags: [] },
      ] as never,
    });
    render(<MigrationPage />);

    for (const testId of ['migration-run-source', 'migration-run-target']) {
      const select = screen.getByTestId(testId) as HTMLSelectElement;
      const options = Array.from(select.querySelectorAll('option'));
      expect(options.map((option) => option.textContent)).toEqual([
        'Select an org',
        'devA [SANDBOX]',
        'p@e.com [PROD]',
      ]);
      expect(select.value).toBe('');
      expect(options[0].disabled).toBe(true);
    }
  });

  it('asks for two different orgs, a name and a config Sync accepts before it offers to save', () => {
    render(<MigrationPage />);
    const save = (): HTMLButtonElement =>
      screen.getByTestId('migration-save-sync-btn') as HTMLButtonElement;

    fireEvent.change(screen.getByTestId('migration-save-sync-name'), {
      target: { value: 'Nightly accounts' },
    });
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('migration-run-source'), { target: { value: 'org-a' } });
    fireEvent.change(screen.getByTestId('migration-run-target'), { target: { value: 'org-a' } });
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId('migration-run-hint').textContent).toBe(
      'Pick two different orgs to save this import for Sync.',
    );
    pickOrgs();
    expect(save().disabled).toBe(false);
    fireEvent.change(screen.getByTestId('migration-save-sync-name'), { target: { value: '   ' } });
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('migration-save-sync-name'), {
      target: { value: 'Nightly accounts' },
    });
    fireEvent.change(screen.getByLabelText('Operation — Contact'), { target: { value: 'upsert' } });
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId('migration-edit-problem').textContent).toBe(
      'An upsert of Contact needs an External ID field both orgs share: matching on Id cannot work. Name one, or set the operation to insert.',
    );
    fireEvent.click(save());
    expect(saveState.mutate).not.toHaveBeenCalled();
  });

  it('keeps Save off once every object is removed, saying why', () => {
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('remove-obj-Account'));
    fireEvent.click(screen.getByTestId('remove-obj-Contact'));
    pickOrgs();
    fireEvent.change(screen.getByTestId('migration-save-sync-name'), {
      target: { value: 'Nightly accounts' },
    });

    expect((screen.getByTestId('migration-save-sync-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId('migration-edit-problem').textContent).toBe(
      'Keep at least one object: a run with none would move nothing.',
    );
  });

  it('says the import changes nothing, and that Sync writes the records', () => {
    render(<MigrationPage />);
    const page = screen.getByTestId('migration-page').textContent ?? '';
    expect(page).toMatch(/Importing reads the file and changes nothing in any org/);
    expect(page).toMatch(/writes records to the target org/);
  });

  it('says why nothing was saved, in the page’s words, for each refusal of the host', () => {
    const refusal = (payload: Record<string, unknown>): string => {
      saveState = mutationState();
      const { unmount, rerender } = render(<MigrationPage />);
      saveAndRead();
      saveState = { ...saveState, data: { success: false, ...payload } };
      rerender(<MigrationPage />);
      const text = screen.getByTestId('migration-save-sync-error').textContent ?? '';
      expect(screen.queryByTestId('migration-open-in-sync-btn')).toBeNull();
      unmount();
      return text;
    };

    expect(refusal({ code: 'DUPLICATE_NAME' })).toContain(
      'A saved Sync configuration is already named “Nightly accounts”.',
    );
    // Sync copies a record's files when asked: "files" alone said it never did.
    const cannotCopy = refusal({ code: 'SYNC_CANNOT_COPY', objects: ['User', 'ContentVersion'] });
    expect(cannotCopy).toContain('Sync does not copy User, ContentVersion:');
    expect(cannotCopy).toContain(
      "file objects (a record's files go with it when Copy the files of these records is ticked in Sync)",
    );
    expect(
      refusal({ code: 'INVALID_CONFIG', reason: 'mode: Sync runs a full sync only' }),
    ).toContain(
      'Sync cannot run this configuration, so it was not saved — mode: Sync runs a full sync only',
    );
    expect(refusal({ code: 'NAME_REQUIRED' })).toContain(
      'Give the configuration a name, then save it.',
    );
  });

  it('forgets the save with the import when a new import starts', () => {
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('migration-reset-btn'));
    expect(saveState.reset).toHaveBeenCalled();
  });
});
