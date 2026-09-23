import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { OrgInfo } from '@sandforge/shared';

import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import { MonitorOrgInfoBar } from './MonitorOrgInfoBar';

let instance: I18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.use(initReactI18next).init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
});

/** An org as a refresh describes it, with the namespace and creation date it now sends. */
const ORG_INFO: OrgInfo = {
  name: 'Acme Corp',
  orgId: '00D000000000001AAA',
  type: 'Sandbox',
  edition: 'Enterprise Edition',
  instanceName: 'EU42S',
  apiVersion: '68.0',
  userCount: 19,
  customObjectCount: 5,
  apexClassCount: 22,
  flowCount: 109,
  namespacePrefix: 'acme',
  createdDate: '2026-04-24T10:20:51.000Z',
};

function renderIn(lng: string, orgInfo: OrgInfo = ORG_INFO): HTMLElement {
  void instance.changeLanguage(lng);
  render(
    <I18nextProvider i18n={instance}>
      <MonitorOrgInfoBar orgInfo={orgInfo} />
    </I18nextProvider>,
  );
  return screen.getByTestId('org-info-panel');
}

describe('MonitorOrgInfoBar', () => {
  it("labels the org's namespace in the page's language", () => {
    // The label was English in every language; nothing reached it until the
    // refresh started sending the namespace it had been querying all along.
    expect(renderIn('fr').textContent).toContain('Espace de noms: acme');
  });

  it('shows the API version the org serves as its release when the org names none', () => {
    expect(renderIn('en').textContent).toContain('API v68.0');
  });

  it("leaves out on a sandbox the creation date it answers with, which is not the sandbox's", () => {
    const panel = renderIn('en');

    expect(panel.textContent).not.toContain('Created');
    expect(panel.textContent).toContain('Namespace: acme');
  });

  it('shows the creation date of an org that is not a sandbox', () => {
    const panel = renderIn('en', { ...ORG_INFO, type: 'Production' });

    expect(panel.textContent).toContain('Created: ');
  });

  it('draws no footer on a sandbox whose creation date was all it had to show', () => {
    renderIn('en', { ...ORG_INFO, namespacePrefix: undefined });

    expect(screen.getByTestId('org-info-panel').textContent).not.toContain('Created');
    expect(screen.getByTestId('org-info-panel').querySelector('.border-t')).toBeNull();
  });
});
