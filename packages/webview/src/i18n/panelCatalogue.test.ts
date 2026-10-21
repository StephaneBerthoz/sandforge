import { describe, expect, it } from 'vitest';

import en from './locales/en.json';
import panelCatalogue from './panelCatalogue';

describe('the English a panel starts with', () => {
  it('carries each namespace it names whole, as the catalogue has it', () => {
    for (const [namespace, strings] of Object.entries(panelCatalogue)) {
      expect(strings).toEqual(en[namespace as keyof typeof en]);
    }
  });

  it('leaves out what only pages render, the big namespaces among them', () => {
    // Which namespaces the shell renders is read from its source by
    // src/PanelRouter.english.test.ts; these four are 150 kB of the catalogue.
    for (const namespace of ['forge', 'onboarding', 'errors', 'sync']) {
      expect(Object.keys(panelCatalogue)).not.toContain(namespace);
    }
    expect(Object.keys(panelCatalogue)).toContain('common');
  });
});
