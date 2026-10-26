import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { FrozenReloadRefused } from './FrozenReloadRefused';

/** The extension's refusal, as it words it: the records left, per object, and why. */
const WHY =
  'A removal of the loads this reload replaces would leave 2 of their records in the org — ' +
  "Contact (2: 1 changed since the load, 1 out of the user's sight): loaded again, the " +
  'dataset would stand beside them. Nothing was written.';

function refused(over: Partial<Parameters<typeof FrozenReloadRefused>[0]> = {}) {
  const onTakeBack = vi.fn();
  const onCancel = vi.fn();
  render(
    <FrozenReloadRefused
      message={WHY}
      org="DEV-SANDBOX"
      canTakeBack
      onTakeBack={onTakeBack}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onTakeBack, onCancel };
}

describe('FrozenReloadRefused', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says the reload wrote nothing, then why in the extension’s own words, announced as it appears', () => {
    refused();

    const alert = screen.getByRole('alert');
    expect(alert.querySelector('h3')?.textContent).toBe(
      'Reload refused: nothing was written to DEV-SANDBOX',
    );
    expect(screen.getByTestId('frozen-reload-refused-why').textContent).toBe(WHY);
    // The section is named by its heading.
    expect(screen.getByRole('region', { name: /Reload refused/ })).toBeTruthy();
  });

  it('offers to take the load back first, the records changed since included, or to cancel', () => {
    const { onTakeBack, onCancel } = refused();

    expect(screen.getByTestId('frozen-reload-refused-way-out').textContent).toBe(
      "Take the load back first: its records go to the recycle bin of DEV-SANDBOX, the ones changed since included — on a shared sandbox, someone else's work — once you have typed the org's name. Then load the dataset again. Or cancel, and nothing changes.",
    );
    fireEvent.click(screen.getByTestId('frozen-reload-take-back'));
    expect(onTakeBack).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('frozen-reload-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers only to cancel a reload whose load cannot be taken back from here', () => {
    refused({ canTakeBack: false });

    expect(screen.queryByTestId('frozen-reload-take-back')).toBeNull();
    expect(screen.getByTestId('frozen-reload-refused-way-out').textContent).toContain(
      'cannot be taken back from here',
    );
    expect(screen.getByTestId('frozen-reload-cancel').textContent).toBe('Cancel');
  });

  it('says it in the language the panel is set to, the extension’s words as they came', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    refused();

    expect(screen.getByRole('heading').textContent).toBe(
      "Rechargement refusé : rien n'a été écrit dans DEV-SANDBOX",
    );
    expect(screen.getByTestId('frozen-reload-take-back').textContent).toBe(
      "Retirer d'abord le chargement…",
    );
    expect(screen.getByTestId('frozen-reload-refused-why').textContent).toBe(WHY);
  });
});
