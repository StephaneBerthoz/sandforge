import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import type { SeedObjectResult } from '@sandforge/shared';
import { SeedObjectBadge, wasSkipped } from './SeedObjectBadge';

function result(over: Partial<SeedObjectResult>): SeedObjectResult {
  return {
    objectApiName: 'Knowledge__kav',
    recordsCreated: 0,
    recordsFailed: 0,
    createdIds: [],
    errors: [],
    ...over,
  };
}

const SKIP =
  'Skipped: this org has no Knowledge__kav object (Salesforce Knowledge is not turned on in it).';

/** A role object whose every role the run linked to the one the platform wrote with its opportunity. */
function linkedOnly(
  writtenByThePlatform: NonNullable<SeedObjectResult['writtenByThePlatform']>,
): SeedObjectResult {
  return result({ objectApiName: 'OpportunityContactRole', writtenByThePlatform });
}

describe('SeedObjectBadge', () => {
  it('counts what an object wrote of what it sent', () => {
    render(<SeedObjectBadge result={result({ recordsCreated: 48, recordsFailed: 2 })} />);
    expect(screen.getByText('48/50')).toBeTruthy();
  });

  it('says an object the run wrote nothing of was skipped, not 0/0', () => {
    render(<SeedObjectBadge result={result({ errors: [SKIP], optional: true })} />);
    expect(screen.getByText('Skipped')).toBeTruthy();
    expect(screen.queryByText('0/0')).toBeNull();
  });

  it('reads an object as skipped only when it wrote and failed nothing and says why', () => {
    expect(wasSkipped(result({ errors: [SKIP] }))).toBe(true);
    expect(wasSkipped(result({}))).toBe(false);
    expect(wasSkipped(result({ recordsFailed: 3, errors: ['REQUIRED_FIELD_MISSING'] }))).toBe(
      false,
    );
  });

  it('says the contact roles linked to the ones the platform wrote are linked, not 0/0', () => {
    // Every role of the run was linked to the one the platform wrote with its
    // opportunity: none created, none refused, and the badge read a green 0/0.
    render(<SeedObjectBadge result={linkedOnly({ records: 3, given: 3 })} />);
    expect(screen.getByText('3 linked')).toBeTruthy();
    expect(screen.queryByText('0/0')).toBeNull();
  });

  it('says one role linked in the singular, in each language of the panel', async () => {
    const said: Record<string, string> = {};
    const catalogues = { fr, de, es, 'pt-BR': ptBR, ja };
    for (const [lng, catalogue] of Object.entries(catalogues)) {
      i18n.addResourceBundle(lng, 'translation', catalogue);
    }
    try {
      for (const lng of ['en', ...Object.keys(catalogues)]) {
        await i18n.changeLanguage(lng);
        const { container, unmount } = render(
          <SeedObjectBadge result={linkedOnly({ records: 1, given: 1 })} />,
        );
        said[lng] = container.textContent ?? '';
        unmount();
      }
    } finally {
      await i18n.changeLanguage('en');
    }
    expect(said).toEqual({
      en: '1 linked',
      fr: '1 rattaché',
      de: '1 verknüpft',
      es: '1 vinculado',
      'pt-BR': '1 vinculado',
      ja: 'リンク済み 1 件',
    });
  });

  it('says linked rather than skipped when a note comes with the linked roles', () => {
    // A note of the roles an opportunity's insert could not pair, beside
    // roles that were all linked, read as a skip: nothing created, nothing
    // failed, and an error to say why.
    const linked: SeedObjectResult = {
      ...linkedOnly({ records: 2, given: 2 }),
      errors: [
        "The contact roles the platform wrote with the run's opportunities were not looked up, " +
          'so written as generated: an opportunity may hold the role of its contact twice. ' +
          "The opportunities' insert did not say which record each id it answered is.",
      ],
    };
    expect(wasSkipped(linked)).toBe(false);
    render(<SeedObjectBadge result={linked} />);
    expect(screen.getByText('2 linked')).toBeTruthy();
    expect(screen.queryByText('Skipped')).toBeNull();
  });

  it('warns, as for a refused record, when the target refused a linked role its fields', () => {
    render(
      <>
        <SeedObjectBadge
          result={linkedOnly({
            records: 2,
            given: 1,
            refusal: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: A role is set by the account team.',
          })}
        />
        <SeedObjectBadge result={result({ recordsCreated: 1, recordsFailed: 1 })} />
        <SeedObjectBadge result={linkedOnly({ records: 4, given: 4 })} />
        <SeedObjectBadge result={result({ recordsCreated: 4 })} />
      </>,
    );
    expect(screen.getByText('2 linked').className).toBe(screen.getByText('1/2').className);
    expect(screen.getByText('4 linked').className).toBe(screen.getByText('4/4').className);
  });
});
