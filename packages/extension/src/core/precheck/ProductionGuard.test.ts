import { describe, it, expect, vi, beforeEach } from 'vitest';
import { guardTierOf, isDevelopmentOrg } from '@sandforge/shared';
import {
  ENGLISH_QUESTION_WORDS,
  ProductionGuard,
  confirmationQuestionOf,
  largeVolumeThreshold,
} from './ProductionGuard';
import type { OperationRequest, RunConfirmation } from './ProductionGuard';

function createRequest(overrides?: Partial<OperationRequest>): OperationRequest {
  return {
    orgId: 'org-001',
    orgTier: 'development',
    operation: 'insert',
    objectName: 'Account',
    recordCount: 100,
    module: 'sync',
    ...overrides,
  };
}

describe('ProductionGuard', () => {
  let guard: ProductionGuard;

  beforeEach(() => {
    guard = new ProductionGuard();
  });

  describe('production tier rules', () => {
    it('should block DELETE on production', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe(
        'Deleting records is not allowed in the production org org-001.',
      );
    });

    it('should block hardDelete on production', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'hardDelete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe(
        'Permanently deleting records is not allowed in the production org org-001.',
      );
    });

    /*
     * The refusal read "hardDelete is not allowed on production org 00D…":
     * the operation's code and the org's id, inside the sentence each module
     * puts it in. It names the operation in words and the org as a question
     * names it.
     */
    it('names the delete in words and the org by the alias the user knows it by', () => {
      const named = new ProductionGuard({ orgNameOf: () => 'Acme Prod' });

      const reason = named.check(
        createRequest({ orgTier: 'production', operation: 'hardDelete' }),
      ).blockedReason;

      expect(reason).toBe(
        'Permanently deleting records is not allowed in the production org "Acme Prod".',
      );
      expect(reason).not.toMatch(/hardDelete|org-001/);
    });

    it('puts the refusal of a delete in the words it is given', () => {
      const words = {
        ...ENGLISH_QUESTION_WORDS,
        org: () => 'ORG',
        deleteRefused: (operation: 'delete' | 'hardDelete', org: string) => `${operation}|${org}`,
      };
      const translated = new ProductionGuard({ questionWords: words });

      expect(
        translated.check(createRequest({ orgTier: 'production', operation: 'delete' }))
          .blockedReason,
      ).toBe('delete|ORG');
      expect(
        translated.check(createRequest({ orgTier: 'production', operation: 'hardDelete' }))
          .blockedReason,
      ).toBe('hardDelete|ORG');
    });

    it('should allow INSERT on production with confirmation', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should allow UPDATE on production with confirmation', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'update',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should allow UPSERT on production with confirmation', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'upsert',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    // A second person's approval above 1 000 records was computed and read
    // nowhere: no write path asked for it, and the check no longer claims it.
    it('asks for the same confirmation of a production write whatever its volume', () => {
      const small = guard.check(
        createRequest({ orgTier: 'production', operation: 'insert', recordCount: 1 }),
      );
      const large = guard.check(
        createRequest({ orgTier: 'production', operation: 'insert', recordCount: 200_000 }),
      );

      expect(large.allowed).toBe(true);
      expect(large.requiresConfirmation).toBe(small.requiresConfirmation);
      expect(large).not.toHaveProperty('requiresApproval');
    });

    it('should always add a production warning', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'update',
      });

      const result = guard.check(request);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Production');
    });

    it('should allow DELETE on production when override is set', () => {
      guard.setProductionOverride('org-001', true);

      const request = createRequest({
        orgTier: 'production',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.warnings.some((w) => w.includes('override'))).toBe(true);
    });

    it('should block DELETE after override is removed', () => {
      guard.setProductionOverride('org-001', true);
      guard.setProductionOverride('org-001', false);

      const request = createRequest({
        orgTier: 'production',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(false);
    });
  });

  describe('staging tier rules', () => {
    it('should allow INSERT on staging without confirmation for small counts', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'insert',
        recordCount: 100,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should require confirmation for DELETE on staging', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should require confirmation for > 10000 records on staging', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'update',
        recordCount: 10_001,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.warnings.some((w) => w.includes('Large volume'))).toBe(true);
    });

    it('should not require confirmation for <= 10000 non-destructive records on staging', () => {
      const request = createRequest({
        orgTier: 'staging',
        operation: 'insert',
        recordCount: 10_000,
      });

      const result = guard.check(request);

      expect(result.requiresConfirmation).toBe(false);
    });
  });

  describe('development and scratch tier rules', () => {
    it('should allow all operations on development without confirmation', () => {
      const request = createRequest({
        orgTier: 'development',
        operation: 'hardDelete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should allow all operations on scratch without confirmation', () => {
      const request = createRequest({
        orgTier: 'scratch',
        operation: 'delete',
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should warn for > 50000 records on development', () => {
      const request = createRequest({
        orgTier: 'development',
        operation: 'insert',
        recordCount: 50_001,
      });

      const result = guard.check(request);

      expect(result.allowed).toBe(true);
      expect(result.warnings.some((w) => w.includes('Large volume'))).toBe(true);
    });

    it('should not warn for <= 50000 records on development', () => {
      const request = createRequest({
        orgTier: 'development',
        operation: 'insert',
        recordCount: 50_000,
      });

      const result = guard.check(request);

      expect(result.warnings).toHaveLength(0);
    });

    it('should warn for > 50000 records on scratch', () => {
      const request = createRequest({
        orgTier: 'scratch',
        operation: 'upsert',
        recordCount: 100_000,
      });

      const result = guard.check(request);

      expect(result.warnings.some((w) => w.includes('100000'))).toBe(true);
    });
  });

  describe('metadata deployments', () => {
    const deploy = (overrides?: Partial<OperationRequest>): OperationRequest =>
      createRequest({
        operation: 'deploy',
        objectName: 'ApexClass, Layout',
        recordCount: 3,
        module: 'compare',
        ...overrides,
      });

    it('refuses a deployment to a production org', () => {
      const result = guard.check(deploy({ orgTier: 'production' }));

      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe(
        'SandForge deploys metadata only to a sandbox, a scratch org or a Developer Edition org, ' +
          'not to the production org org-001.',
      );
    });

    it('names the org it refuses by the alias the user knows it by', () => {
      const named = new ProductionGuard({ orgNameOf: () => 'Acme Prod' });

      expect(named.check(deploy({ orgTier: 'production' })).blockedReason).toContain(
        'not to the production org "Acme Prod".',
      );
    });

    /*
     * The refusal said SandForge deployed "to sandboxes only" after a scratch
     * org and a Developer Edition had become development orgs, which Compare
     * deploys to. It names each kind of org the shared rule accepts, and the
     * guard lets a deployment through to each.
     */
    it('names, as the orgs it deploys to, every kind the shared rule calls a development org', () => {
      const kinds: Array<[orgType: string, edition: string, said: string]> = [
        ['Sandbox', 'Enterprise Edition', 'a sandbox'],
        ['Scratch', 'Developer Edition', 'a scratch org'],
        ['Developer', 'Developer Edition', 'a Developer Edition org'],
      ];
      const refusal = guard.check(deploy({ orgTier: 'production' })).blockedReason ?? '';
      for (const [orgType, edition, said] of kinds) {
        const org = { orgType, metadata: { edition } };
        expect({ orgType, development: isDevelopmentOrg(org) }).toEqual({
          orgType,
          development: true,
        });
        expect(guard.check(deploy({ orgTier: guardTierOf(org) })).allowed).toBe(true);
        expect(refusal).toContain(said);
      }
      expect(
        isDevelopmentOrg({ orgType: 'Production', metadata: { edition: 'Enterprise Edition' } }),
      ).toBe(false);
      expect(refusal).not.toMatch(/sandboxes only/);
    });

    it('refuses it even with a production override, which lifts only the delete block', () => {
      guard.setProductionOverride('org-001', true);

      expect(guard.check(deploy({ orgTier: 'production' })).allowed).toBe(false);
    });

    it('asks for a confirmation on a staging org, whatever the count', () => {
      const result = guard.check(deploy({ orgTier: 'staging', recordCount: 1 }));

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.warnings).toContain(
        'Metadata deployment on staging org — confirmation required',
      );
    });

    it('lets a sandbox or a scratch org take one without a confirmation', () => {
      for (const orgTier of ['development', 'scratch'] as const) {
        const result = guard.check(deploy({ orgTier }));
        expect(result.allowed).toBe(true);
        expect(result.requiresConfirmation).toBe(false);
      }
    });

    it('counts components, not records, in what it says', () => {
      const result = guard.check(deploy({ orgTier: 'production' }));

      expect(result.impactSummary).toBe(
        'DEPLOY 3 component(s) (ApexClass, Layout) to production org org-001 [module: compare]',
      );
      expect(result.warnings[0]).toBe(
        'Production operation: deploy on ApexClass, Layout (3 components)',
      );
    });
  });

  describe('impactSummary', () => {
    it('should include operation, count, object, tier, orgId, and module', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'update',
        objectName: 'Contact',
        recordCount: 500,
        orgId: 'org-prod-42',
        module: 'seed',
      });

      const result = guard.check(request);

      expect(result.impactSummary).toContain('UPDATE');
      expect(result.impactSummary).toContain('500');
      expect(result.impactSummary).toContain('Contact');
      expect(result.impactSummary).toContain('production');
      expect(result.impactSummary).toContain('org-prod-42');
      expect(result.impactSummary).toContain('seed');
    });

    it('reads an uncounted request as unknown, in the summary and in the warning', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account, Contact',
        recordCount: 'unknown',
      });

      const result = guard.check(request);

      expect(result.impactSummary).toContain('unknown number of Account, Contact record(s)');
      expect(result.impactSummary).not.toContain('INSERT 0');
      expect(result.warnings[0]).toContain('an unknown number of records');
      expect(result.warnings[0]).not.toContain('(0 records)');
    });

    it('spells out a measured count of zero as zero', () => {
      const request = createRequest({
        orgTier: 'production',
        operation: 'insert',
        objectName: 'Account',
        recordCount: 0,
      });

      const result = guard.check(request);

      expect(result.impactSummary).toContain('INSERT 0 Account record(s)');
      expect(result.impactSummary).not.toContain('unknown');
      expect(result.warnings[0]).toContain('(0 records)');
    });

    it('does not warn about volume on staging or development when the count is unknown', () => {
      const staging = guard.check(createRequest({ orgTier: 'staging', recordCount: 'unknown' }));
      const dev = guard.check(createRequest({ orgTier: 'development', recordCount: 'unknown' }));

      expect(staging.requiresConfirmation).toBe(false);
      expect(staging.warnings).toEqual([]);
      expect(dev.warnings).toEqual([]);
    });

    it('says a count known only at most is at most, in the summary and in the warning', () => {
      // A clone of one record is counted by the tables of its objects: the
      // number is the most it can write, not what it writes.
      const result = guard.check(
        createRequest({
          orgTier: 'production',
          operation: 'insert',
          objectName: 'Account, Case',
          recordCount: { atMost: 60 },
        }),
      );

      expect(result.impactSummary).toBe(
        'INSERT at most 60 Account, Case record(s) on production org org-001 [module: sync]',
      );
      expect(result.warnings[0]).toBe(
        'Production operation: insert on Account, Case (at most 60 records)',
      );
    });

    it('says what an operation writes besides the records it counts, in the summary and in the warning', () => {
      // A clone of one record also writes the catalog and the parents its
      // records name: without this, "at most 60" read as a bound on the run.
      const result = guard.check(
        createRequest({
          orgTier: 'production',
          operation: 'insert',
          objectName: 'Account, Case',
          recordCount: { atMost: 60 },
          alsoWrites: 'the related records the run adds',
        }),
      );

      expect(result.impactSummary).toBe(
        'INSERT at most 60 Account, Case record(s), plus the related records the run adds, on production org org-001 [module: sync]',
      );
      expect(result.warnings[0]).toBe(
        'Production operation: insert on Account, Case (at most 60 records, plus the related records the run adds)',
      );
    });

    it('measures the volume thresholds against the most a run can write, and says it is a most', () => {
      const staging = guard.check(
        createRequest({ orgTier: 'staging', recordCount: { atMost: 12_000 } }),
      );
      const dev = guard.check(
        createRequest({ orgTier: 'development', recordCount: { atMost: 60_000 } }),
      );
      const production = guard.check(
        createRequest({ orgTier: 'production', recordCount: { atMost: 1_500 } }),
      );

      expect(staging.requiresConfirmation).toBe(true);
      expect(staging.warnings).toEqual([
        'Large volume operation: at most 12000 records on staging',
      ]);
      expect(dev.warnings).toEqual([
        'Large volume operation: at most 60000 records on development org',
      ]);
      expect(production.warnings[0]).toContain('at most 1500 records');
    });

    it('asks nothing of a staging run whose most stays under the threshold', () => {
      const staging = guard.check(
        createRequest({ orgTier: 'staging', recordCount: { atMost: 500 } }),
      );

      expect(staging.requiresConfirmation).toBe(false);
      expect(staging.warnings).toEqual([]);
    });
  });

  describe('setProductionOverride / isProductionOverridden', () => {
    it('should return false for orgs without override', () => {
      expect(guard.isProductionOverridden('unknown-org')).toBe(false);
    });

    it('should return true after override is set', () => {
      guard.setProductionOverride('org-001', true);

      expect(guard.isProductionOverridden('org-001')).toBe(true);
    });

    it('should return false after override is revoked', () => {
      guard.setProductionOverride('org-001', true);
      guard.setProductionOverride('org-001', false);

      expect(guard.isProductionOverridden('org-001')).toBe(false);
    });

    it('should track overrides independently per org', () => {
      guard.setProductionOverride('org-A', true);
      guard.setProductionOverride('org-B', false);

      expect(guard.isProductionOverridden('org-A')).toBe(true);
      expect(guard.isProductionOverridden('org-B')).toBe(false);
    });
  });

  describe('safety settings wiring', () => {
    it('requiresConfirmation follows isProdConfirmationRequired=false', () => {
      const noConfirmGuard = new ProductionGuard({ isProdConfirmationRequired: () => false });
      const result = noConfirmGuard.check(
        createRequest({ orgTier: 'production', operation: 'insert' }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('requiresConfirmation stays true by default (no options)', () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      expect(result.requiresConfirmation).toBe(true);
    });

    it('confirmIfNeeded returns true when confirmation not required', async () => {
      const result = guard.check(createRequest({ orgTier: 'development' }));
      await expect(guard.confirmIfNeeded(result, 'development')).resolves.toBe(true);
    });

    it('confirmIfNeeded returns false when check disallows the operation', async () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'delete' }));
      await expect(guard.confirmIfNeeded(result, 'production')).resolves.toBe(false);
    });

    it('confirmIfNeeded proceeds when no confirmation UI is wired', async () => {
      const result = guard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(guard.confirmIfNeeded(result, 'production')).resolves.toBe(true);
    });

    it('confirmIfNeeded delegates to requestConfirmation and honors refusal', async () => {
      const confirm = vi.fn().mockResolvedValue(false);
      const uiGuard = new ProductionGuard({ requestConfirmation: confirm });
      const result = uiGuard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(uiGuard.confirmIfNeeded(result, 'production')).resolves.toBe(false);
      expect(confirm).toHaveBeenCalledWith(result.impactSummary, 'production');
    });

    it('confirmIfNeeded honors user acceptance', async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      const uiGuard = new ProductionGuard({ requestConfirmation: confirm });
      const result = uiGuard.check(createRequest({ orgTier: 'production', operation: 'insert' }));
      await expect(uiGuard.confirmIfNeeded(result, 'production')).resolves.toBe(true);
    });
  });

  describe('largeVolumeThreshold', () => {
    it('is the line past which the check warns of a large volume, per tier', () => {
      expect(largeVolumeThreshold('development')).toBe(50_000);
      expect(largeVolumeThreshold('scratch')).toBe(50_000);
      expect(largeVolumeThreshold('staging')).toBe(10_000);
      // Warned about whatever its volume.
      expect(largeVolumeThreshold('production')).toBeUndefined();
    });

    it('matches the warnings the check gives', () => {
      const line = largeVolumeThreshold('development') ?? 0;
      expect(guard.check(createRequest({ recordCount: line })).warnings).toEqual([]);
      expect(guard.check(createRequest({ recordCount: line + 1 })).warnings).toEqual([
        'Large volume operation: 50001 records on development org',
      ]);
    });
  });

  describe('confirmRun', () => {
    const question: RunConfirmation = {
      stage: 'automation',
      org: 'DEV',
      orgTier: 'development',
      fired: [{ objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome' }],
      firedOnUpdate: [],
      updateSteps: [],
      unread: [],
      bypass: [],
      assign: [],
    };

    it('puts the question to the user and says what they answered', async () => {
      const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const uiGuard = new ProductionGuard({ requestRunConfirmation: ask });

      await expect(uiGuard.confirmRun(question)).resolves.toBe('confirmed');
      await expect(uiGuard.confirmRun(question)).resolves.toBe('declined');
      expect(ask).toHaveBeenCalledWith(question);
    });

    it('never lets a run through when there is nobody to ask', async () => {
      // confirmIfNeeded proceeds on such a host; a run's own question does not.
      await expect(guard.confirmRun(question)).resolves.toBe('unavailable');
    });

    it('is not the production confirmation: the setting that removes that one leaves it', async () => {
      const ask = vi.fn().mockResolvedValue(false);
      const uiGuard = new ProductionGuard({
        isProdConfirmationRequired: () => false,
        requestRunConfirmation: ask,
      });

      await expect(uiGuard.confirmRun(question)).resolves.toBe('declined');
    });
  });
});

describe('the question a confirmation puts', () => {
  it('says what the operation does, to which objects, in the org named by its alias', () => {
    expect(
      confirmationQuestionOf(
        createRequest({ orgTier: 'production', objectName: 'Account, Contact', recordCount: 1 }),
        'Acme Prod',
      ),
    ).toBe('Insert 1 record (Account, Contact) into the production org "Acme Prod".');
    expect(
      confirmationQuestionOf(
        createRequest({
          orgTier: 'production',
          operation: 'upsert',
          recordCount: { atMost: 60 },
          alsoWrites: 'the related records the run adds',
        }),
        'Acme Prod',
      ),
    ).toBe(
      'Insert or update at most 60 records (Account), plus the related records the run adds, ' +
        'in the production org "Acme Prod".',
    );
    expect(
      confirmationQuestionOf(
        createRequest({
          orgTier: 'production',
          operation: 'deploy',
          objectName: 'ApexClass',
          recordCount: 3,
        }),
        'Acme Prod',
      ),
    ).toBe('Deploy 3 components (ApexClass) to the production org "Acme Prod".');
  });

  it('leaves out the name a run of several objects stands under, and names an org nobody named by its id', () => {
    expect(
      confirmationQuestionOf(
        createRequest({ orgTier: 'production', objectName: 'SeedData', recordCount: 'unknown' }),
      ),
    ).toBe('Insert records into the production org org-001.');
  });

  it('is set on a result that asks, by a guard that can name the org, and handed to the modal', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const named = new ProductionGuard({ requestConfirmation, orgNameOf: () => 'Acme Prod' });
    const asks = named.check(createRequest({ orgTier: 'production' }));

    expect(asks.question).toBe('Insert 100 records (Account) into the production org "Acme Prod".');
    expect(named.check(createRequest({ orgTier: 'development' })).question).toBeUndefined();
    await named.confirmIfNeeded(asks, 'production');
    expect(requestConfirmation).toHaveBeenCalledWith(
      asks.impactSummary,
      'production',
      asks.question,
    );

    // A guard that cannot name the org asks with the impact summary, as before.
    const unnamed = new ProductionGuard({ requestConfirmation });
    expect(unnamed.check(createRequest({ orgTier: 'production' })).question).toBeUndefined();
  });
});
