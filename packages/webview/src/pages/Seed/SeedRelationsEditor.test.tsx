import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedRelationsEditor } from './SeedRelationsEditor';
import type { FieldConfig, ObjectFieldConfig } from './Step3_ConfigureFields';

/** A described field; a lookup when it names what it points at. */
function field(fieldApiName: string, label: string, referenceTo: string[] = []): FieldConfig {
  return {
    fieldApiName,
    label,
    type: referenceTo.length > 0 ? 'reference' : 'string',
    required: false,
    ruleType: referenceTo.length > 0 ? 'reference' : 'faker',
    config: referenceTo.length > 0 ? { referenceObject: referenceTo[0] } : {},
    ...(referenceTo.length > 0 ? { referenceTo } : {}),
  };
}

const FIELD_CONFIGS: ObjectFieldConfig[] = [
  { objectApiName: 'Account', objectLabel: 'Account', fields: [field('Name', 'Account Name')] },
  {
    objectApiName: 'Contact',
    objectLabel: 'Contact',
    fields: [field('LastName', 'Last Name'), field('AccountId', 'Account ID', ['Account'])],
  },
  {
    objectApiName: 'Task',
    objectLabel: 'Task',
    fields: [field('WhoId', 'Name ID', ['Contact', 'Lead'])],
  },
];

/** Render the editor with these objects selected, five accounts asked for. */
function renderEditor(selectedObjects: string[], fieldConfigs = FIELD_CONFIGS) {
  useSeedWizardStore.setState({ selectedObjects });
  return render(
    <SeedRelationsEditor
      fieldConfigs={fieldConfigs}
      volumes={{ Account: { count: 5, batchSize: 200 } }}
    />,
  );
}

/** The value a select or input of the first row holds. */
function valueOf(part: string): string {
  return (screen.getByTestId(`relation-0-${part}`) as HTMLInputElement | HTMLSelectElement).value;
}

describe('SeedRelationsEditor', () => {
  beforeEach(() => {
    useSeedWizardStore.getState().resetSeedWizard();
  });

  it('adds a relation on the lookup to the accounts the run creates, three contacts to each', () => {
    renderEditor(['Account', 'Contact']);

    fireEvent.click(screen.getByTestId('add-relation-btn'));

    expect(valueOf('child')).toBe('Contact');
    expect(valueOf('lookup')).toBe('AccountId');
    expect(valueOf('source')).toBe('generated');
    expect(valueOf('mode')).toBe('perParent');
    expect(valueOf('count')).toBe('3');
    expect(screen.getByTestId('relation-0-planned').textContent).toBe(
      'Contact: up to 15 records — parents: 5 × Account, created by this run.',
    );
  });

  it('reads the parents from the org with a filter and a bound once told to', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));

    fireEvent.change(screen.getByTestId('relation-0-source'), { target: { value: 'existing' } });
    fireEvent.change(screen.getByTestId('relation-0-where'), {
      target: { value: "Industry = 'Energy'" },
    });

    expect(valueOf('limit')).toBe('10');
    expect(screen.getByTestId('relation-0-planned').textContent).toBe(
      'Contact: up to 30 records — parents: at most 10 × Account, already in the org.',
    );
    expect(useSeedWizardStore.getState().relations[0]).toMatchObject({
      source: 'existing',
      where: "Industry = 'Energy'",
      limit: 10,
    });
  });

  it('offers no parents from this run when the run does not create them', () => {
    renderEditor(['Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));

    expect(valueOf('source')).toBe('existing');
    const fromRun = screen
      .getByTestId('relation-0-source')
      .querySelector('option[value="generated"]') as HTMLOptionElement;
    expect(fromRun.disabled).toBe(true);
  });

  it('asks for the fewest and the most children of a range, and the average of a ratio', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));

    fireEvent.change(screen.getByTestId('relation-0-mode'), { target: { value: 'range' } });
    expect(screen.queryByTestId('relation-0-count')).toBeNull();
    fireEvent.change(screen.getByTestId('relation-0-max'), { target: { value: '4' } });
    expect(screen.getByTestId('relation-0-planned').textContent).toContain('up to 20 records');

    fireEvent.change(screen.getByTestId('relation-0-mode'), { target: { value: 'ratio' } });
    expect(valueOf('ratio')).toBe('0.5');
    expect(screen.getByText('0.5 gives a child to every other parent.')).toBeDefined();
    expect(screen.getByTestId('relation-0-planned').textContent).toContain('up to 2 records');
  });

  it('says what is wrong while a number is missing, and settles it when the field is left', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    const count = screen.getByTestId('relation-0-count');

    fireEvent.change(count, { target: { value: '' } });
    expect(screen.getByTestId('relation-0-problem').textContent).toBe(
      'Enter a number within the bounds of each field.',
    );

    fireEvent.blur(count);
    expect(valueOf('count')).toBe('1');
    expect(screen.queryByTestId('relation-0-problem')).toBeNull();
  });

  it('keeps a range in order when its fewest is raised above its most', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    fireEvent.change(screen.getByTestId('relation-0-mode'), { target: { value: 'range' } });

    const min = screen.getByTestId('relation-0-min');
    fireEvent.change(min, { target: { value: '6' } });
    expect(screen.getByTestId('relation-0-problem')).toBeDefined();
    fireEvent.blur(min);

    expect(useSeedWizardStore.getState().relations[0]).toMatchObject({ min: 6, max: 6 });
  });

  it('says a relation making no child makes none', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    fireEvent.change(screen.getByTestId('relation-0-mode'), { target: { value: 'ratio' } });

    fireEvent.change(screen.getByTestId('relation-0-ratio'), { target: { value: '0.1' } });

    expect(screen.getByTestId('relation-0-problem').textContent).toBe(
      'This relation creates no Contact record: raise the number of children or of parents.',
    );
  });

  it('says so when a second row fills the same child', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    fireEvent.click(screen.getByTestId('add-relation-btn'));

    expect(screen.getByTestId('relation-1-problem').textContent).toBe(
      'Contact already takes its records from another relation: remove one of the two.',
    );
  });

  it('asks which object a lookup that may point at several draws from', () => {
    renderEditor(['Contact', 'Task']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    fireEvent.change(screen.getByTestId('relation-0-child'), { target: { value: 'Task' } });

    fireEvent.change(screen.getByTestId('relation-0-parent'), { target: { value: 'Lead' } });

    expect(useSeedWizardStore.getState().relations[0]).toMatchObject({
      childObject: 'Task',
      lookupField: 'WhoId',
      parentObject: 'Lead',
      source: 'existing',
    });
  });

  it('removes a row', () => {
    renderEditor(['Account', 'Contact']);
    fireEvent.click(screen.getByTestId('add-relation-btn'));

    fireEvent.click(screen.getByText('Remove relation 1'));

    expect(screen.queryByTestId('relation-0')).toBeNull();
    expect(useSeedWizardStore.getState().relations).toEqual([]);
  });

  it('says why no relation can be added once no selected object turns out to have a lookup', () => {
    renderEditor(['Account']);

    expect((screen.getByTestId('add-relation-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('seed-relations-no-lookup').textContent).toBe(
      'None of the selected objects has a lookup to fill.',
    );
  });

  it('claims no missing lookup while an object is still being described', () => {
    renderEditor(['Account', 'Opportunity']);

    expect(screen.queryByTestId('seed-relations-no-lookup')).toBeNull();
  });
});
