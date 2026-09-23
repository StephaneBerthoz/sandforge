import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedExecuteStep } from './SeedExecuteStep';
import type { SeedExecuteStepProps } from './SeedExecuteStep';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

/** Contact with its account lookup, as the describe gives it before any edit. */
const CONTACT: ObjectFieldConfig = {
  objectApiName: 'Contact',
  objectLabel: 'Contact',
  fields: [
    {
      fieldApiName: 'LastName',
      label: 'Last Name',
      type: 'string',
      required: true,
      ruleType: 'faker',
      config: { fakerMethod: 'lastName', maxLength: 80 },
    },
    {
      fieldApiName: 'AccountId',
      label: 'Account ID',
      type: 'reference',
      required: false,
      ruleType: 'reference',
      config: { referenceObject: 'Account', referenceField: 'Id' },
      referenceTo: ['Account'],
    },
  ],
};

const ACCOUNT: ObjectFieldConfig = {
  objectApiName: 'Account',
  objectLabel: 'Account',
  fields: [
    {
      fieldApiName: 'Name',
      label: 'Account Name',
      type: 'string',
      required: true,
      ruleType: 'faker',
      config: { fakerMethod: 'name', maxLength: 255 },
    },
  ],
};

/** The step as a run of Account and Contact that skipped Configure shows it. */
function renderStep(overrides: Partial<SeedExecuteStepProps> = {}): SeedExecuteStepProps {
  const props: SeedExecuteStepProps = {
    isRunning: false,
    objectProgress: [],
    overallPercent: 0,
    elapsedMs: 0,
    configSkipped: true,
    onCustomize: vi.fn(),
    fieldsReady: true,
    fieldsError: null,
    onRetryFields: vi.fn(),
    fieldConfigs: [ACCOUNT, CONTACT],
    volumes: {},
    ...overrides,
  };
  render(<SeedExecuteStep {...props} />);
  return props;
}

describe('SeedExecuteStep', () => {
  beforeEach(() => {
    useSeedWizardStore.getState().resetSeedWizard();
    useSeedWizardStore.setState({ selectedObjects: ['Account', 'Contact'] });
  });

  it('says the run uses the default rules, and names no persona when none was picked', () => {
    // It read "Using default field rules from persona." with no persona, above
    // a run that carried no rule at all.
    renderStep();

    expect(screen.getByTestId('seed-fields-status').textContent).toBe('Using default field rules.');
    expect(screen.getByTestId('adaptive-customize-link')).toBeDefined();
  });

  it('names the persona whose patterns shape the rules', () => {
    useSeedWizardStore.setState({
      selectedPersona: {
        id: 'assureur-fr',
        name: 'Assureur français',
        description: '',
        industry: 'Insurance',
        locale: 'fr-FR',
        dataPatterns: {},
      },
    });
    renderStep();

    expect(screen.getByTestId('seed-fields-status').textContent).toBe(
      'Using default field rules, with the patterns of the Assureur français persona.',
    );
  });

  it('says the run waits for the fields while an object is not described', () => {
    renderStep({ fieldsReady: false });

    expect(screen.getByTestId('seed-fields-status').textContent).toBe(
      'Reading the fields of the selected objects...',
    );
    expect(screen.queryByTestId('seed-fields-retry')).toBeNull();
  });

  it('says why the fields could not be read, and asks again on Retry', () => {
    const props = renderStep({ fieldsReady: false, fieldsError: 'INVALID_SESSION_ID' });

    expect(screen.getByTestId('seed-fields-status').textContent).toBe(
      'The fields of the selected objects could not be read: INVALID_SESSION_ID',
    );
    fireEvent.click(screen.getByTestId('seed-fields-retry'));
    expect(props.onRetryFields).toHaveBeenCalledOnce();
  });

  it('says the run waits for the fields after the configure step too, without offering to customize', () => {
    renderStep({ configSkipped: false, fieldsReady: false });

    expect(screen.getByTestId('seed-fields-status').textContent).toBe(
      'Reading the fields of the selected objects...',
    );
    expect(screen.queryByTestId('adaptive-customize-link')).toBeNull();
  });

  it('puts the relations on the step when the configure step was skipped', () => {
    // They were only reachable through Customize.
    renderStep();

    expect(screen.getByTestId('seed-execute-relations')).toBeDefined();
    fireEvent.click(screen.getByTestId('add-relation-btn'));
    expect(screen.getByTestId('relation-0-planned').textContent).toBe(
      'Contact: up to 300 records — parents: 100 × Account, created by this run.',
    );
  });

  it('leaves the banner and the relations to the configure step when it was not skipped', () => {
    renderStep({ configSkipped: false });

    expect(screen.queryByTestId('adaptive-defaults-banner')).toBeNull();
    expect(screen.queryByTestId('seed-execute-relations')).toBeNull();
  });

  it('offers no relation to edit while the run is in flight', () => {
    renderStep({ isRunning: true });

    expect(screen.queryByTestId('seed-execute-relations')).toBeNull();
  });
});
