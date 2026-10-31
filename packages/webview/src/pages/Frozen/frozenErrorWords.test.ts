import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { frozenErrorWords } from './frozenErrorWords';

const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);
const aliasOf = (orgId: string): string => (orgId === 'org-uat' ? 'UAT' : orgId);

describe('frozenErrorWords', () => {
  it('says a run with no configuration saved is to be saved first, without the message type the host names', () => {
    const words = frozenErrorWords(
      {
        code: 'CONFIG_MISSING',
        message:
          'No frozen dataset configuration saved — save the project configuration first ' +
          '(frozen:config:save: coverage axes, root object, budget, load rules).',
      },
      t,
      aliasOf,
    );

    expect(words).toBe(
      'No project configuration is saved, and the runs read the saved one. ' +
        'Click Save configuration on the Extract tab first.',
    );
    expect(words).not.toContain('frozen:config:save');
  });

  it('names the rules file an extraction looked for, and the button that writes one', () => {
    expect(
      frozenErrorWords(
        { code: 'RULES_MISSING', rulesPath: '/home/qa/.sandforge-sas/rules.json' },
        t,
        aliasOf,
      ),
    ).toBe(
      'No pseudonymization rules file at /home/qa/.sandforge-sas/rules.json: the extraction ' +
        'needs one. Click Create rules file on the Extract tab: an empty file clears every ' +
        'field without a rule.',
    );
  });

  it('names the source a load was refused into by the name the panel gives it', () => {
    expect(
      frozenErrorWords(
        {
          code: 'GUARD_REFUSED',
          guard: 'source-is-target',
          orgId: 'org-uat',
          message: 'this org is the dataset SOURCE (manifest source.orgId)',
        },
        t,
        aliasOf,
      ),
    ).toBe(
      'UAT is the org this dataset was extracted from: a load never goes back into its ' +
        'source, and nothing was written. Pick another sandbox as the target.',
    );
  });

  it("leaves every other refusal in the host's words, and one that names too little", () => {
    for (const payload of [
      { code: 'GUARD_REFUSED', guard: 'non-sandbox', orgId: 'org-uat' },
      { code: 'GUARD_REFUSED', guard: 'source-is-target' },
      { code: 'RULES_MISSING' },
      { code: 'LOAD_ERROR', message: 'No frozen dataset found' },
      undefined,
    ]) {
      expect(frozenErrorWords(payload, t, aliasOf)).toBeUndefined();
    }
  });

  it('says them in the interface language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      expect(frozenErrorWords({ code: 'CONFIG_MISSING' }, t, aliasOf)).toBe(
        `${fr.frozen.refusal.configMissing.explanation} ${fr.frozen.refusal.configMissing.action}`,
      );
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
