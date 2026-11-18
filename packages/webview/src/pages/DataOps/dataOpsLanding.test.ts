import { describe, expect, it } from 'vitest';
import type { ListedAnonymizationTemplate } from '@sandforge/shared';
import { DATAOPS_TAB_IDS, landingOf, maskedObjects, templateFor } from './dataOpsLanding';

/** A template as the host lists it, masking `Object.Field` patterns. */
function template(id: string, patterns: string[]): ListedAnonymizationTemplate {
  return {
    id,
    name: id,
    description: '',
    complianceFramework: 'GDPR',
    rules: patterns.map((fieldPattern) => ({ fieldPattern, ruleType: 'fake', description: '' })),
  };
}

describe('the tabs of DataOps', () => {
  it('runs from masking to emptying, in the order of the work', () => {
    expect(DATAOPS_TAB_IDS).toEqual(['anonymize', 'backup', 'gdpr', 'cleanup', 'emptying']);
  });
});

describe('where DataOps lands', () => {
  it('opens on Masking when nothing asks for another tab', () => {
    expect(landingOf(null, 'org-1')).toEqual({ tab: 'anonymize' });
    expect(landingOf({ route: 'checkpoint', dataopsTab: 'cleanup' }, 'org-1')).toEqual({
      tab: 'anonymize',
    });
  });

  it('opens on the tab an intent names, by the id the page names it with', () => {
    expect(landingOf({ route: 'dataops', dataopsTab: 'gdpr' }, 'org-1')).toEqual({ tab: 'gdpr' });
    expect(landingOf({ route: 'dataops', dataopsTab: 'emptying' }, 'org-1')).toEqual({
      tab: 'emptying',
    });
  });

  it('opens Restore on Backups and Quality on Cleanup, the tabs that took them in', () => {
    expect(landingOf({ route: 'dataops', dataopsTab: 'restore' }, 'org-1')).toEqual({
      tab: 'backup',
    });
    expect(landingOf({ route: 'dataops', dataopsTab: 'quality' }, 'org-1')).toEqual({
      tab: 'cleanup',
    });
  });

  it('opens Emptying with the objects to empty first, for the org selected only', () => {
    expect(
      landingOf(
        { route: 'dataops', targetOrgId: 'org-1', emptyObjects: ['Contact', 'Case'] },
        'org-1',
      ),
    ).toEqual({ tab: 'emptying', empty: { orgId: 'org-1', objects: ['Contact', 'Case'] } });
    // Another org's objects are not picked on the one on screen.
    expect(
      landingOf({ route: 'dataops', targetOrgId: 'org-9', emptyObjects: ['Contact'] }, 'org-1'),
    ).toEqual({ tab: 'anonymize' });
  });

  it('opens Masking with the objects to mask, for the org selected or the one it names', () => {
    expect(
      landingOf(
        { route: 'dataops', dataopsTab: 'anonymize', targetOrgId: 'org-1', maskObjects: ['Lead'] },
        'org-1',
      ),
    ).toEqual({ tab: 'anonymize', mask: { orgId: 'org-1', objects: ['Lead'] } });
    expect(
      landingOf({ route: 'dataops', dataopsTab: 'anonymize', maskObjects: ['Lead'] }, 'org-1'),
    ).toEqual({ tab: 'anonymize', mask: { orgId: 'org-1', objects: ['Lead'] } });
    // Objects to mask on another org are not offered on the one on screen.
    expect(
      landingOf(
        { route: 'dataops', dataopsTab: 'anonymize', targetOrgId: 'org-9', maskObjects: ['Lead'] },
        'org-1',
      ),
    ).toEqual({ tab: 'anonymize' });
    // Nor with no org selected.
    expect(landingOf({ route: 'dataops', maskObjects: ['Lead'] }, undefined)).toEqual({
      tab: 'anonymize',
    });
  });
});

describe('the objects a template masks', () => {
  it('names each object once, in the order its rules first name it, past the wildcards', () => {
    expect(
      maskedObjects([
        template('a', ['Contact.Email', 'Lead.Phone', 'Contact.Phone', '*.Email']),
        template('b', ['Account.Name', 'Lead.Email']),
      ]),
    ).toEqual(['Contact', 'Lead', 'Account']);
  });
});

describe('the template the objects to mask open Masking on', () => {
  const contacts = template('contacts', ['Contact.Email']);
  const people = template('people', ['Contact.Email', 'Lead.Email']);
  const everyone = template('everyone', ['Contact.Email', 'Lead.Email', 'Account.Phone']);
  const accounts = template('accounts', ['Account.Phone']);

  it('picks the template that masks every object asked, with the fewest besides', () => {
    expect(templateFor([everyone, people, contacts], ['Lead', 'Contact'])).toBe('people');
  });

  it('picks the first such template listed when two mask the same objects', () => {
    const twin = template('twin', ['Lead.Phone', 'Contact.Phone']);
    expect(templateFor([people, twin], ['Contact', 'Lead'])).toBe('people');
  });

  it('picks the template that masks the most of them when none masks them all', () => {
    expect(templateFor([accounts, contacts, people], ['Lead', 'Contact', 'Case'])).toBe('people');
  });

  it('picks none when no template masks any of them', () => {
    expect(templateFor([accounts], ['Lead'])).toBeUndefined();
    expect(templateFor([], ['Lead'])).toBeUndefined();
  });
});
