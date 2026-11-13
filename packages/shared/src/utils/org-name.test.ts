import { describe, expect, it } from 'vitest';
import { isOwnAlias, orgDisplayName } from './org-name.js';

const ORG_ID = '00D000000000001AAA';

describe('orgDisplayName', () => {
  it('names an org by its own alias', () => {
    expect(
      orgDisplayName({ alias: 'qa-sandbox', username: 'someone@example.com', orgId: ORG_ID }),
    ).toBe('qa-sandbox');
  });

  it('never names an org by the username the registry keeps as its alias when it had none', () => {
    const name = orgDisplayName({
      alias: 'someone@example.com',
      username: 'someone@example.com',
      organizationName: 'Example Workspace',
      orgId: ORG_ID,
    });
    expect(name).toBe('Example Workspace');
    expect(name).not.toContain('@');
  });

  it('takes an alias that differs from the username by case or spaces alone for the username', () => {
    expect(
      orgDisplayName({
        alias: ' Someone@Example.com ',
        username: 'someone@example.com',
        orgId: ORG_ID,
      }),
    ).toBe(ORG_ID);
  });

  it('takes an alias shaped as a username for one, whoever it names', () => {
    expect(
      orgDisplayName({
        alias: 'other@example.org',
        username: 'someone@example.com',
        orgId: ORG_ID,
      }),
    ).toBe(ORG_ID);
  });

  it('names an org known by no alias and no name by its Organization Id', () => {
    expect(orgDisplayName({ alias: '', username: 'someone@example.com', orgId: ORG_ID })).toBe(
      ORG_ID,
    );
  });

  it("never takes a name that is the username, or shaped as one, for the org's name", () => {
    expect(
      orgDisplayName({
        username: 'someone@example.com',
        organizationName: 'someone@example.com',
        orgId: ORG_ID,
      }),
    ).toBe(ORG_ID);
  });

  it('names a checkpoint kept of an org with no alias by the Organization Id it kept', () => {
    expect(orgDisplayName({ username: 'someone@example.com', organizationId: ORG_ID })).toBe(
      ORG_ID,
    );
  });

  it('gives the fallback for no org, or one known by its username alone, and never the username', () => {
    expect(orgDisplayName(undefined, 'the target')).toBe('the target');
    expect(orgDisplayName({ username: 'someone@example.com' }, 'the target')).toBe('the target');
    expect(orgDisplayName({ username: 'someone@example.com' })).toBe('');
  });
});

describe('isOwnAlias', () => {
  it('holds an alias of its own, and neither an empty one, the username nor one shaped as it', () => {
    expect(isOwnAlias('dev-1', 'someone@example.com')).toBe(true);
    expect(isOwnAlias('dev-1', undefined)).toBe(true);
    expect(isOwnAlias('   ', 'someone@example.com')).toBe(false);
    expect(isOwnAlias(undefined, 'someone@example.com')).toBe(false);
    expect(isOwnAlias('someone@example.com', 'someone@example.com')).toBe(false);
    expect(isOwnAlias('other@example.org', 'someone@example.com')).toBe(false);
  });
});
