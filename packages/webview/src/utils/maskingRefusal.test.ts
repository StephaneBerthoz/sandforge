import { describe, it, expect } from 'vitest';
import en from '../i18n/locales/en.json';
import { maskingGapWords, maskingRefusalWords } from './maskingRefusal';

/** Reads a key of the English catalogue, its values filled in: what i18next does with it. */
function t(key: string, options: Record<string, unknown> = {}): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
  return Object.entries(options).reduce(
    (text, [name, filled]) => text.replace(`{{${name}}}`, String(filled)),
    String(value),
  );
}

const BIRTHDATE = { objectApiName: 'Contact', fieldApiName: 'Birthdate' };
const EMAIL = { objectApiName: 'Lead', fieldApiName: 'Email' };

describe('maskingGapWords', () => {
  it('names each field, what hides it and what to do', () => {
    const said = maskingGapWords({ fieldsNotFound: [BIRTHDATE], objectsNotCovered: [] }, t);
    expect(said).toContain('This template masks Contact.Birthdate,');
    expect(said).toContain('field-level security hides it');
    expect(said).toContain('give that user read and edit access to the field');
    expect(said).toContain('take the field out of the template');
  });

  it('lists several fields as the interface language lists them', () => {
    expect(
      maskingGapWords({ fieldsNotFound: [BIRTHDATE, EMAIL], objectsNotCovered: [] }, t),
    ).toContain('Contact.Birthdate and Lead.Email');
  });

  it('adds an object none of whose fields can be masked', () => {
    expect(
      maskingGapWords({ fieldsNotFound: [EMAIL], objectsNotCovered: ['Lead'] }, t).endsWith(
        ' No field of Lead can be masked.',
      ),
    ).toBe(true);
  });

  it('says an object with no field to name whole', () => {
    expect(maskingGapWords({ fieldsNotFound: [], objectsNotCovered: ['Account'] }, t)).toBe(
      en.common.refusal.maskingMasksNothing.replace('{{objects}}', 'Account'),
    );
  });

  it('says what the user may not edit, alone or after the fields the org hides', () => {
    expect(
      maskingGapWords(
        { fieldsNotFound: [], objectsNotCovered: [], notWritable: ['Contact.Birthdate'] },
        t,
      ),
    ).toBe(en.common.refusal.maskingNotWritable.replace('{{fields}}', 'Contact.Birthdate'));
    const both = maskingGapWords(
      { fieldsNotFound: [EMAIL], objectsNotCovered: [], notWritable: ['Contact'] },
      t,
    );
    expect(both).toContain('Lead.Email');
    expect(
      both.endsWith(` ${en.common.refusal.maskingNotWritable.replace('{{fields}}', 'Contact')}`),
    ).toBe(true);
  });

  it('points an object with no field to name to another object or template, not to an access no field needs', () => {
    // Every hidden field is named apart: here the template names no field of
    // the object, and the access the words asked for changed nothing.
    const said = maskingGapWords({ fieldsNotFound: [], objectsNotCovered: ['Account'] }, t);
    expect(said).toContain('Choose an object its rules name, or another template.');
    expect(said).not.toContain('access');
  });
});

describe('maskingRefusalWords', () => {
  it('words a refused field, and says nothing was masked', () => {
    const said = maskingRefusalWords(
      'MASKING_FIELDS_UNSEEN',
      { fieldsNotFound: [BIRTHDATE], objectsNotCovered: [] },
      t,
    );
    expect(said).toContain('Contact.Birthdate');
    expect(said?.endsWith(` ${en.common.refusal.maskingNothingMasked}`)).toBe(true);
  });

  it('words a refused object', () => {
    expect(
      maskingRefusalWords(
        'MASKING_MASKS_NOTHING',
        { fieldsNotFound: [], objectsNotCovered: ['Account'] },
        t,
      ),
    ).toContain('masks no field of Account in this org');
  });

  it('leaves any other refusal to the words it came with', () => {
    expect(
      maskingRefusalWords(
        'SNAPSHOT_NOT_TAKEN',
        { fieldsNotFound: [BIRTHDATE], objectsNotCovered: [] },
        t,
      ),
    ).toBeUndefined();
    expect(maskingRefusalWords(null, {}, t)).toBeUndefined();
  });

  it('keeps the host’s words for a refusal that names nothing, or names it in another shape', () => {
    expect(maskingRefusalWords('MASKING_FIELDS_UNSEEN', {}, t)).toBeUndefined();
    expect(
      maskingRefusalWords(
        'MASKING_FIELDS_UNSEEN',
        { fieldsNotFound: [], objectsNotCovered: [] },
        t,
      ),
    ).toBeUndefined();
    expect(
      maskingRefusalWords(
        'MASKING_FIELDS_UNSEEN',
        { fieldsNotFound: ['Contact.Birthdate'], objectsNotCovered: [] },
        t,
      ),
    ).toBeUndefined();
    expect(
      maskingRefusalWords(
        'MASKING_MASKS_NOTHING',
        { fieldsNotFound: [], objectsNotCovered: [1] },
        t,
      ),
    ).toBeUndefined();
  });
});
