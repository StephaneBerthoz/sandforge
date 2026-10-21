import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SeedRecordTypeOption } from '@sandforge/shared';
import '../../i18n';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedRecordTypePicker } from './SeedRecordTypePicker';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

const PERSON: SeedRecordTypeOption = {
  recordTypeId: '012000000000001AAA',
  developerName: 'PersonAccount',
  label: 'Person Account',
  person: true,
  isDefault: false,
};
const CUSTOMER: SeedRecordTypeOption = {
  recordTypeId: '012000000000002AAA',
  developerName: 'Customer',
  label: 'Customer',
  person: false,
  isDefault: true,
};

const CONFIGS: ObjectFieldConfig[] = [
  { objectApiName: 'Account', objectLabel: 'Account', fields: [], recordTypes: [PERSON, CUSTOMER] },
  // One type only, the user's default: there is nothing to choose.
  { objectApiName: 'Contact', objectLabel: 'Contact', fields: [], recordTypes: [CUSTOMER] },
];

describe('SeedRecordTypePicker', () => {
  beforeEach(() => {
    useSeedWizardStore.getState().resetSeedWizard();
    useSeedWizardStore.getState().handleToggleObject('Account');
    useSeedWizardStore.getState().handleToggleObject('Contact');
  });

  it('offers the target’s record types of an object, the person account’s and the default marked', () => {
    render(<SeedRecordTypePicker fieldConfigs={CONFIGS} />);

    const account = screen.getByTestId('seed-record-types-Account');
    expect(account.textContent).toContain('Person Account');
    expect(account.textContent).toContain('person account');
    expect(account.textContent).toContain('your default');
    expect(screen.queryByTestId('seed-record-types-Contact')).toBeNull();
  });

  it('chooses a person account type, and says the accounts are written as person accounts', () => {
    render(<SeedRecordTypePicker fieldConfigs={CONFIGS} />);

    fireEvent.click(screen.getByTestId('seed-record-type-Account-PersonAccount'));

    expect(useSeedWizardStore.getState().recordTypeChoices).toEqual({
      Account: [PERSON.recordTypeId],
    });
    expect(screen.getByTestId('seed-record-types-person-Account').textContent).toContain('no Name');
  });

  it('names the accounts written as person accounts by the object’s label', () => {
    // "{{object}} records are written as person accounts": the object names a
    // kind of record, as the org's describe labels it.
    render(
      <SeedRecordTypePicker fieldConfigs={[{ ...CONFIGS[0], objectLabel: 'Kunde' }, CONFIGS[1]]} />,
    );

    fireEvent.click(screen.getByTestId('seed-record-type-Account-PersonAccount'));

    expect(screen.getByTestId('seed-record-types-person-Account').textContent).toMatch(
      /^Kunde records are written as person accounts/,
    );
  });

  it('says a person type and a business type chosen together take different fields', () => {
    render(<SeedRecordTypePicker fieldConfigs={CONFIGS} />);

    fireEvent.click(screen.getByTestId('seed-record-type-Account-PersonAccount'));
    fireEvent.click(screen.getByTestId('seed-record-type-Account-Customer'));

    expect(screen.getByRole('alert').textContent).toContain('take different fields');
  });

  it('forgets an object’s choice once the object is taken out of the seed', () => {
    useSeedWizardStore.getState().setRecordTypeChoice('Account', [PERSON.recordTypeId]);

    useSeedWizardStore.getState().handleToggleObject('Account');

    expect(useSeedWizardStore.getState().recordTypeChoices).toEqual({});
  });
});
