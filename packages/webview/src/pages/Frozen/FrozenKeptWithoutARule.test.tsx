import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { FrozenRulesClearResponse } from '@sandforge/shared';
import type { BridgeMutationState } from '../../hooks/useBridgeMutation';
import { FrozenKeptWithoutARule } from './FrozenKeptWithoutARule';

/** What the mutation answers, set by each test; `mutate` records what it is sent. */
const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  calls: [] as Array<{ requestType: string; options: unknown }>,
  state: {
    data: null,
    loading: false,
    error: null,
  } as Pick<BridgeMutationState<unknown>, 'data' | 'loading' | 'error'>,
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string, options: unknown) => {
    mutation.calls.push({ requestType, options });
    return {
      ...mutation.state,
      mutate: mutation.mutate,
      errorCode: null,
      reset: vi.fn(),
      requestId: null,
    };
  },
}));

/** The answer of a write that cleared `cleared` and found `alreadyRuled` ruled. */
function answered(payload: FrozenRulesClearResponse['payload']): void {
  mutation.state = { data: payload, loading: false, error: null };
}

describe('FrozenKeptWithoutARule', () => {
  beforeEach(() => {
    mutation.mutate.mockReset();
    mutation.calls = [];
    mutation.state = { data: null, loading: false, error: null };
  });

  it('lists what the extraction kept in clear text with no rule, which only the manifest said', () => {
    render(<FrozenKeptWithoutARule fields={['Case.Status', 'Contact.GenderIdentity']} />);

    expect(screen.getByTestId('frozen-kept-without-rule-list').textContent).toBe(
      "Kept in clear text with no rule, as values of the schema rather than anyone's words: " +
        'Case.Status, Contact.GenderIdentity. Review them: one that says something about a ' +
        'person is better cleared.',
    );
    const button = screen.getByTestId('frozen-kept-without-rule-clear');
    expect(button.textContent).toContain('Clear these');
    // The button says what it writes, and what a required field cleared costs.
    const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(
      'Writes a clear rule for each into the rules file. A required field cleared is a value ' +
        'the load will ask for.',
    );
  });

  it('writes a clear rule for each in one click, on the channel the extension handles', () => {
    render(<FrozenKeptWithoutARule fields={['Case.Status', 'Contact.GenderIdentity']} />);

    fireEvent.click(screen.getByTestId('frozen-kept-without-rule-clear'));

    expect(mutation.mutate).toHaveBeenCalledTimes(1);
    expect(mutation.mutate).toHaveBeenCalledWith({
      fields: ['Case.Status', 'Contact.GenderIdentity'],
    });
    expect(mutation.calls[0]).toEqual({
      requestType: 'frozen:rules:clear',
      options: { errorType: 'frozen:rules:clear:error' },
    });
  });

  it('says where the rules went, under which version, and that the next extraction clears them', () => {
    answered({
      rulesPath: '/home/me/.sandforge-sas/rules.json',
      rulesVersion: '1.1.0',
      cleared: ['Contact.GenderIdentity'],
      alreadyRuled: ['Case.Status'],
    });

    render(<FrozenKeptWithoutARule fields={['Case.Status', 'Contact.GenderIdentity']} />);

    expect(screen.getByTestId('frozen-kept-without-rule-written').textContent).toBe(
      'Written to /home/me/.sandforge-sas/rules.json (rules 1.1.0): Contact.GenderIdentity ' +
        'will be cleared. Run the extraction again for the dataset to clear them.',
    );
    expect(screen.getByTestId('frozen-kept-without-rule-already').textContent).toBe(
      'Already ruled in the file, left as declared: Case.Status.',
    );
    // Written once: a second click would only find them ruled.
    expect(
      (screen.getByTestId('frozen-kept-without-rule-clear') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says the rules file was not written, and why', () => {
    mutation.state = { data: null, loading: false, error: 'Pseudonymization rules file not found' };

    render(<FrozenKeptWithoutARule fields={['Case.Status']} />);

    expect(screen.getByTestId('frozen-kept-without-rule-error').textContent).toBe(
      'The rules file was not written: Pseudonymization rules file not found',
    );
  });

  it('renders nothing when the extraction kept nothing without a rule', () => {
    const { container } = render(<FrozenKeptWithoutARule fields={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('speaks the panel language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      render(<FrozenKeptWithoutARule fields={['Case.Status']} />);
      expect(screen.getByTestId('frozen-kept-without-rule-clear').textContent).toContain(
        'Effacer ceux-ci',
      );
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
