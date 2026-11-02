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

  it('says a load refused for its checkpoint first wrote nothing, and how to run it without', () => {
    expect(
      frozenErrorWords(
        { code: 'CHECKPOINT_REFUSED', message: 'The checkpoint before the load was refused.' },
        t,
        aliasOf,
      ),
    ).toBe(
      'The load was refused before it wrote anything: the checkpoint it was to take first of ' +
        'the objects it writes was refused, or could not be taken, which the SandForge output ' +
        'says. Nothing was written. Untick Checkpoint first to load without it, or fix what ' +
        'refuses it.',
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

  it('says each entry guard that refused a load, its org by the name the panel gives it', () => {
    const refused = (guard: string): string | undefined =>
      frozenErrorWords({ code: 'GUARD_REFUSED', guard, orgId: 'org-uat' }, t, aliasOf);

    expect(refused('non-sandbox')).toBe(
      'UAT is no sandbox, scratch org or Developer Edition org: a load goes into those alone, ' +
        'and nothing was written. Pick one of those as the target.',
    );
    expect(refused('protected-environment')).toBe(
      'UAT is among the protected orgs of the configuration, and nothing was written. Pick ' +
        'another sandbox, or review that list if this org was retired.',
    );
    expect(refused('unmocked-callouts')).toBe(
      'The records of a load into UAT would trigger real external calls: its callouts are not ' +
        'mocked, and nothing was written. Deploy the mock configuration to that org, then load ' +
        'again.',
    );
    expect(frozenErrorWords({ code: 'GUARD_REFUSED', guard: 'empty-dataset' }, t, aliasOf)).toBe(
      'The dataset holds no record, and nothing was written. Run the selection and the ' +
        'extraction again with a coverage matrix that matches the source.',
    );
  });

  it('says every refusal of its own by its code, what to do among it', () => {
    const said = (code: string): string | undefined => frozenErrorWords({ code }, t, aliasOf);

    expect(said('SELECTION_MISSING')).toBe(
      'No selection is saved, and the extraction takes its records from one. Click Run ' +
        'selection on the Extract tab first.',
    );
    expect(said('SELECTION_EMPTY')).toContain('click Run selection again');
    expect(said('CONTROL_FAILED')).toContain('and nothing was written');
    expect(said('SALT_MISSING')).toContain('SANDFORGE_FROZEN_SALT');
    expect(said('SAS_PATH_REFUSED')).toContain('outside any repository');
    expect(said('NO_LOAD')).toContain('No load into this org');
    expect(said('NOT_RECORDED')).toContain('cannot be told from the ones it linked');
    expect(said('LOAD_CHANGED')).toContain('nothing was removed');
    expect(said('TARGET_REFRESHED')).toContain('went with the refresh');
    expect(said('LOAD_STOPPED')).toContain('no counting contract');
    expect(said('TIMEOUT')).toBe('This step ran out of time and stopped. Try it again.');
  });

  it('says a selection past its budget with the figures the host measured, the heaviest named', () => {
    expect(
      frozenErrorWords(
        {
          code: 'BUDGET_EXCEEDED',
          total: 3200,
          budgetMax: 2500,
          heaviest: ['FeedItem 900', 'Event 400'],
        },
        t,
        aliasOf,
      ),
    ).toBe(
      'The selection measured 3200 records for a budget of 2500. The heaviest: FeedItem 900, ' +
        'Event 400. Leave out the objects the dataset does not need, narrow the coverage axes ' +
        'or edge cases, or raise the budget.',
    );
  });

  it('says what a removal left of the load a verification was asked of', () => {
    expect(frozenErrorWords({ code: 'LOAD_REMOVED', left: 3 }, t, aliasOf)).toContain(
      'left 3 of them in the org',
    );
    expect(frozenErrorWords({ code: 'LOAD_REMOVED', left: 0 }, t, aliasOf)).toContain(
      'there is nothing to verify',
    );
  });

  it('says what a load asks the configuration for, each as the host names it', () => {
    expect(
      frozenErrorWords(
        {
          code: 'LOAD_CONFIG',
          gaps: ['requiredFieldDefaults["OpportunityLineItem.UnitPrice"]: a value'],
        },
        t,
        aliasOf,
      ),
    ).toBe(
      'The dataset leaves required fields empty that the configuration does not cover, and ' +
        'nothing was written. Declare them all in the configuration, then load again: ' +
        'requiredFieldDefaults["OpportunityLineItem.UnitPrice"]: a value',
    );
  });

  it("leaves what the org or the disk said in the host's words, and a refusal that names too little", () => {
    for (const payload of [
      { code: 'GUARD_REFUSED', guard: 'non-sandbox' },
      { code: 'GUARD_REFUSED', guard: 'source-is-target' },
      { code: 'GUARD_REFUSED', guard: 'guard-refused', orgId: 'org-uat' },
      { code: 'RULES_MISSING' },
      { code: 'BUDGET_EXCEEDED' },
      { code: 'LOAD_CONFIG', message: 'Pilot mode requires config.rootObjectApiName' },
      { code: 'LOAD_ERROR', message: 'No frozen dataset found' },
      { code: 'EXTRACT_ERROR', message: 'INVALID_SESSION_ID' },
      undefined,
    ]) {
      expect(frozenErrorWords(payload, t, aliasOf)).toBeUndefined();
    }
  });

  it('has each refusal in every language, none of them left in English', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      expect(frozenErrorWords({ code: 'TARGET_REFRESHED' }, t, aliasOf)).toBe(
        `${fr.frozen.refusal.targetRefreshed.explanation} ${fr.frozen.refusal.targetRefreshed.action}`,
      );
    } finally {
      await i18n.changeLanguage('en');
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
