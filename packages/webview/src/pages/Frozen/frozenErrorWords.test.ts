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
      // A stop the host did not count, a sas it did not name, a refusal of
      // record types that names none of them.
      { code: 'LOAD_CANCELLED', message: 'The load was cancelled before it had written…' },
      { code: 'SAS_CHANGED', message: 'The sas changed since the last load…' },
      { code: 'LOAD_CONFIG', recordTypesUntold: { reason: 'label', objectApiName: 'Account' } },
      undefined,
    ]) {
      expect(frozenErrorWords(payload, t, aliasOf)).toBeUndefined();
    }
  });

  describe('what showed the host’s English in every locale', () => {
    it('says a load stopped before its first write wrote nothing', () => {
      expect(
        frozenErrorWords(
          {
            code: 'LOAD_CANCELLED',
            written: 0,
            message:
              'The load was cancelled before it created or purged a record: the mapping is left as it was.',
          },
          t,
          aliasOf,
        ),
      ).toBe(
        'You stopped the load before it wrote anything, and nothing was written. Run the load ' +
          'again when you are ready.',
      );
    });

    it('says what a load stopped part way had written, and what takes it back', () => {
      expect(frozenErrorWords({ code: 'LOAD_CANCELLED', written: 204 }, t, aliasOf)).toBe(
        'You stopped the load part way. Records it had written by then, created or purged: 204. ' +
          'What it created is kept in the sas mapping: a removal takes it back, and a reload ' +
          'purges it or finds it again.',
      );
    });

    it('names the sas a verification read and the one the load wrote to, each way it changed', () => {
      const sas = (sasMoved: boolean, contractThere: boolean): string | undefined =>
        frozenErrorWords(
          {
            code: 'SAS_CHANGED',
            sasDir: '/home/qa/sas-b',
            loadSas: '/home/qa/sas-a',
            sasMoved,
            contractThere,
          },
          t,
          aliasOf,
        );

      expect(sas(false, false)).toBe(
        'The sas changed since the last load: /home/qa/sas-b no longer holds the counting ' +
          'contract the load wrote there. Load the dataset again, then verify.',
      );
      expect(sas(true, true)).toBe(
        'The sas folder changed since the last load: its counting contract is in ' +
          '/home/qa/sas-a, and the mapping read is the one in /home/qa/sas-b. Set the sas folder ' +
          'back to the one the load wrote to in the configuration, or load the dataset again; ' +
          'then verify.',
      );
      expect(sas(true, false)).toBe(
        'The sas folder changed since the last load: the load wrote to /home/qa/sas-a, which no ' +
          'longer holds its counting contract, and the mapping read is the one in /home/qa/sas-b. ' +
          'Move the sas back to /home/qa/sas-a and set the sas folder to it in the ' +
          'configuration, or load the dataset again; then verify.',
      );
    });

    it('says a removal a card offered after another took the load found nothing to delete', () => {
      expect(frozenErrorWords({ code: 'ALREADY_REMOVED' }, t, aliasOf)).toBe(
        'The records this load created were removed already, and nothing was deleted. The card ' +
          'now shows the load as the sas holds it.',
      );
      expect(frozenErrorWords({ code: 'NOTHING_TO_REMOVE' }, t, aliasOf)).toBe(
        'This load created no record a removal takes, and nothing was deleted. The card now ' +
          'shows the load as the sas holds it.',
      );
    });

    it('says Production Guard’s answer to a load as every page says it', () => {
      expect(
        frozenErrorWords(
          {
            code: 'GUARD_REFUSED',
            guard: 'guard-refused',
            decision: 'declined',
            message: 'Production guard refused insert on Account: confirmation declined',
          },
          t,
          aliasOf,
        ),
      ).toBe("Cancelled at Production Guard's confirmation: nothing was changed in the org.");
      expect(
        frozenErrorWords(
          {
            code: 'GUARD_REFUSED',
            guard: 'guard-refused',
            decision: 'refused',
            reason: 'insert is not allowed on UAT',
          },
          t,
          aliasOf,
        ),
      ).toBe(
        'Production Guard refused this operation, and nothing was changed in the org. Its ' +
          'reason: insert is not allowed on UAT',
      );
    });

    it('names the record types a load could not tell apart, and what to do', () => {
      expect(
        frozenErrorWords(
          {
            code: 'LOAD_CONFIG',
            recordTypesUntold: {
              reason: 'label',
              objectApiName: 'Account',
              name: 'Retail',
              recordTypes: ['acme__Retail', 'Retail'],
            },
          },
          t,
          aliasOf,
        ),
      ).toBe(
        // A dataset extracted now keeps each record's record type by its name,
        // and loads where two share the label: the refusal is an old dataset's.
        "The dataset's Account records name their record type “Retail” by its label alone " +
          "(they were extracted before SandForge kept each record's record type by its name), " +
          'and acme__Retail, Retail share that label in the source org: which one each record ' +
          'had cannot be told, and nothing was written. Click Run extraction again: a dataset ' +
          "extracted now keeps each record's record type by its name.",
      );
      expect(
        frozenErrorWords(
          {
            code: 'LOAD_CONFIG',
            recordTypesUntold: {
              reason: 'namespace',
              objectApiName: 'Account',
              name: 'Retail',
              recordTypes: ['acme__Retail', 'Retail'],
            },
          },
          t,
          aliasOf,
        ),
      ).toContain('Click Run extraction again');
    });

    it('says a load refused for the emails the org delivers, and the box that lets it through', () => {
      // The host's sentence names --accept-emails, which no page has.
      expect(
        frozenErrorWords(
          {
            code: 'EMAILS_NOT_ACCEPTED',
            orgId: 'org-uat',
            message: '… Nothing was written. Add --accept-emails to load all the same, …',
          },
          t,
          aliasOf,
        ),
      ).toBe(
        'UAT delivers every email what still runs sends as the load writes, or would not say ' +
          'whether it does, and nothing was written. Tick “Load even though UAT delivers the ' +
          "emails” to load all the same, tick Mute automation to keep quiet what tests the org's " +
          "bypass, or set the org's deliverability to System email only.",
      );
    });

    it('says a load refused for what the org runs as it writes, naming it, and the box that lets it through', () => {
      // The host's sentence names --accept-automation, which no page has.
      const words = frozenErrorWords(
        {
          code: 'AUTOMATION_NOT_ACCEPTED',
          orgId: 'org-uat',
          message: '… Nothing was written. Add --accept-automation to load all the same, …',
          automation: {
            firing: [
              {
                objectApiName: 'OpportunityLineItem',
                kind: 'flow',
                name: 'GC Gate OLI Delete',
                writes: ['insert'],
              },
            ],
            accepted: false,
          },
        },
        t,
        aliasOf,
      );

      expect(words).toBe(
        'UAT runs automation as the load writes its records (OpportunityLineItem — Flow: GC Gate ' +
          'OLI Delete), and nothing was written. Tick “Load although UAT runs automation as the ' +
          'records go in” to load all the same, tick Mute automation to keep quiet what tests the ' +
          "org's bypass, or turn that automation off in UAT.",
      );
      expect(words).not.toContain('--');
      // What could not be read, nothing named.
      expect(
        frozenErrorWords(
          {
            code: 'AUTOMATION_NOT_ACCEPTED',
            orgId: 'org-uat',
            automation: { firing: [], unread: [{ part: 'automation', reason: 'x' }] },
          },
          t,
          aliasOf,
        ),
      ).toMatch(/^What UAT runs as the load writes could not be read, and nothing was written\. /);
      // A removal's refusal of the same code names no load's question: the host's words stay.
      expect(
        frozenErrorWords({ code: 'AUTOMATION_NOT_ACCEPTED', orgId: 'org-uat' }, t, aliasOf),
      ).toBeUndefined();
    });

    it('says a load refused past the emails the org has left today, with its figures', () => {
      expect(
        frozenErrorWords(
          {
            code: 'FROZEN_EMAILS_EXCEEDED',
            orgId: 'org-uat',
            emails: {
              counted: [
                { limit: 'DailyWorkflowEmails', emails: 72, verdict: 'fits', remaining: 8040 },
                { limit: 'SingleEmail', emails: 72, verdict: 'exceeds', remaining: 15, max: 15 },
              ],
            },
          },
          t,
          aliasOf,
        ),
      ).toBe(
        'The load would make UAT send more emails than it has left today (Single emails: about ' +
          '72, 15 of 15 left), and nothing was written. Tick Mute automation to keep quiet what ' +
          'sends them, or load into an org with more emails left today.',
      );
      expect(
        frozenErrorWords({ code: 'FROZEN_EMAILS_EXCEEDED', orgId: 'org-uat' }, t, aliasOf),
      ).toBeUndefined();
    });

    it('says each in the interface language', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      try {
        const refusal = fr.frozen.refusal;
        expect(frozenErrorWords({ code: 'LOAD_CANCELLED', written: 0 }, t, aliasOf)).toBe(
          `${refusal.loadCancelled.explanation} ${refusal.loadCancelled.action}`,
        );
        expect(frozenErrorWords({ code: 'ALREADY_REMOVED' }, t, aliasOf)).toBe(
          `${refusal.alreadyRemoved.explanation} ${refusal.alreadyRemoved.action}`,
        );
        expect(
          frozenErrorWords(
            { code: 'GUARD_REFUSED', guard: 'guard-refused', decision: 'declined' },
            t,
            aliasOf,
          ),
        ).toBe(fr.common.refusal.guardDeclined);
        expect(
          frozenErrorWords(
            {
              code: 'SAS_CHANGED',
              sasDir: '/s',
              loadSas: '/s',
              sasMoved: false,
              contractThere: false,
            },
            t,
            aliasOf,
          ),
        ).toContain(refusal.sasChanged.emptiedAction);
      } finally {
        await i18n.changeLanguage('en');
      }
    });
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
