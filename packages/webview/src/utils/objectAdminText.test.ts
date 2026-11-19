import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import en from '../i18n/locales/en.json';
import fr from '../i18n/locales/fr.json';
import { objectAdminText } from './objectAdminText';

let instance: I18n;
let t: TFunction;
beforeAll(async () => {
  instance = createInstance();
  await instance.init({
    lng: 'en',
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
  });
  t = instance.getFixedT('en');
});

describe('objectAdminText', () => {
  it('lists, under the org it names, the deploy of an object the target lacks and the Create on one its user may not create', () => {
    expect(
      objectAdminText(t, 'qa-sandbox', [
        { object: 'Invoice__c', need: 'notInTarget' },
        { object: 'Warranty__c', need: 'notCreateable' },
      ]),
    ).toBe(
      [
        'Changes to make in the Setup of qa-sandbox for SandForge to write the records of these objects there:',
        '',
        '- Deploy Invoice__c to qa-sandbox if it is not there (in SandForge: Compare, then Deploy from Diff), then give the user SandForge writes as Read and Create on Invoice__c (Setup > their profile or a permission set > Object Settings > Invoice__c).',
        '- Give the user SandForge writes as Create on Warranty__c (Setup > their profile or a permission set > Object Settings > Warranty__c).',
      ].join('\n'),
    );
  });

  it('is empty when no object needs anything of the admin', () => {
    expect(objectAdminText(t, 'qa-sandbox', [])).toBe('');
  });

  it('says each object once, however often it is given', () => {
    const text = objectAdminText(t, 'qa-sandbox', [
      { object: 'Invoice__c', need: 'notInTarget' },
      { object: 'Invoice__c', need: 'notInTarget' },
    ]);

    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
  });

  it('is written in the language of the page', () => {
    const french = objectAdminText(instance.getFixedT('fr'), 'qa-sandbox', [
      { object: 'Warranty__c', need: 'notCreateable' },
    ]);

    expect(french).toContain('Modifications à faire dans la Configuration de qa-sandbox');
    expect(french).toContain('droit de création sur Warranty__c');
  });
});
