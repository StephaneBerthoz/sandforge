import { describe, it, expect } from 'vitest';
import { SmartObjectSuggester } from './SmartObjectSuggester.js';

describe('SmartObjectSuggester', () => {
  const suggester = new SmartObjectSuggester();

  it('returns 5 suggestions when all common objects are available', () => {
    const available = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead', 'Task'];
    const suggestions = suggester.suggest(available, []);

    expect(suggestions).toHaveLength(5);
    expect(suggestions.every((s) => s.isAvailable)).toBe(true);
    expect(suggestions.every((s) => !s.isAlreadySelected)).toBe(true);
  });

  it('marks unavailable objects correctly', () => {
    const available = ['Account', 'Contact'];
    const suggestions = suggester.suggest(available, []);

    const accountSugg = suggestions.find((s) => s.objectApiName === 'Account');
    const caseSugg = suggestions.find((s) => s.objectApiName === 'Case');

    expect(accountSugg?.isAvailable).toBe(true);
    expect(caseSugg?.isAvailable).toBe(false);
  });

  it('marks already-selected objects correctly', () => {
    const available = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'];
    const suggestions = suggester.suggest(available, ['Account', 'Lead']);

    const accountSugg = suggestions.find((s) => s.objectApiName === 'Account');
    const contactSugg = suggestions.find((s) => s.objectApiName === 'Contact');

    expect(accountSugg?.isAlreadySelected).toBe(true);
    expect(contactSugg?.isAlreadySelected).toBe(false);
  });

  it('returns all unavailable when no common objects exist in the org', () => {
    const available = ['CustomObj__c', 'AnotherObj__c'];
    const suggestions = suggester.suggest(available, []);

    expect(suggestions).toHaveLength(5);
    expect(suggestions.every((s) => !s.isAvailable)).toBe(true);
  });

  it('returns correct labels for all suggestions', () => {
    const suggestions = suggester.suggest([], []);
    const names = suggestions.map((s) => s.objectApiName);

    expect(names).toEqual(['Account', 'Contact', 'Opportunity', 'Case', 'Lead']);
  });
});
