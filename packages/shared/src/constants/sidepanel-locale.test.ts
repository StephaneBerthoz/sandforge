import { describe, expect, it } from 'vitest';
import { SIDEPANEL_LOCALE_NAMESPACES, sidepanelLocaleSubset } from './sidepanel-locale.js';

describe('sidepanelLocaleSubset', () => {
  it('keeps the namespaces the sidebar renders and drops every other', () => {
    const catalogue = {
      sidePanel: { noOrg: 'Aucune org connectée' },
      nav: { seed: 'Seed' },
      common: { cancel: 'Annuler' },
      forge: { title: 'Forge' },
      onboarding: { welcome: 'Bienvenue' },
    };

    expect(sidepanelLocaleSubset(catalogue)).toEqual({
      sidePanel: { noOrg: 'Aucune org connectée' },
      nav: { seed: 'Seed' },
      common: { cancel: 'Annuler' },
    });
  });

  it('hands the values over as they are, without copying them', () => {
    const sidePanel = { noOrg: 'Kein Org verbunden' };
    expect(sidepanelLocaleSubset({ sidePanel }).sidePanel).toBe(sidePanel);
  });

  it('names each namespace once', () => {
    expect(new Set(SIDEPANEL_LOCALE_NAMESPACES).size).toBe(SIDEPANEL_LOCALE_NAMESPACES.length);
  });
});
