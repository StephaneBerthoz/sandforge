import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import de from '../../i18n/locales/de.json';
import { isNewStepName, newStepName, stepTypeLabel } from './stepTypeLabel';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('stepTypeLabel', () => {
  it('names a step type in the reader’s language, never by its id', async () => {
    expect(stepTypeLabel('approval', i18n.t)).toBe('Approval');
    expect(stepTypeLabel('precheck', i18n.t)).toBe('Pre-Check');
    i18n.addResourceBundle('de', 'translation', de, true, true);
    await i18n.changeLanguage('de');
    expect(stepTypeLabel('approval', i18n.t)).toBe('Genehmigung');
  });

  it('keeps a type it does not know as it was written', () => {
    expect(stepTypeLabel('teleport', i18n.t)).toBe('teleport');
  });
});

describe('newStepName', () => {
  it('names a new step after its type, then numbers the next ones of that type', () => {
    expect(newStepName('delay', [], i18n.t)).toBe('Delay');
    expect(newStepName('delay', ['Delay'], i18n.t)).toBe('Delay 2');
    expect(newStepName('delay', ['Delay', 'Delay 2'], i18n.t)).toBe('Delay 3');
    // A number freed by a removed step is taken again before a higher one.
    expect(newStepName('delay', ['Delay', 'Delay 3'], i18n.t)).toBe('Delay 2');
    // Another type's name, or a renamed step, takes nothing from it.
    expect(newStepName('delay', ['Backup', 'Wait an hour'], i18n.t)).toBe('Delay');
  });
});

describe('isNewStepName', () => {
  it('reads a name a new step was given, numbered or not, and nothing else', () => {
    expect(isNewStepName('Approval', 'approval', i18n.t)).toBe(true);
    expect(isNewStepName('Approval 12', 'approval', i18n.t)).toBe(true);
    expect(isNewStepName('Approval 0', 'approval', i18n.t)).toBe(false);
    expect(isNewStepName('Approval by QA', 'approval', i18n.t)).toBe(false);
    expect(isNewStepName('approval', 'approval', i18n.t)).toBe(false);
    expect(isNewStepName('Pre-Check 2', 'precheck', i18n.t)).toBe(true);
  });
});
