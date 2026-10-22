import { describe, expect, it } from 'vitest';
import { intentMessageFor, isPageMountedMessage, moduleIntentSchema } from './moduleIntent';

describe('isPageMountedMessage', () => {
  it("takes the page's enveloped route for its mounting, and nothing else", () => {
    expect(
      isPageMountedMessage({ protocolVersion: 1, payload: { type: 'panel:route', id: 'r' } }),
    ).toBe(true);
    expect(
      isPageMountedMessage({ protocolVersion: 1, payload: { type: 'i18n:locale', id: 'l' } }),
    ).toBe(false);
    expect(isPageMountedMessage({ type: 'panel:route' })).toBe(false);
    expect(isPageMountedMessage({ payload: null })).toBe(false);
    expect(isPageMountedMessage(null)).toBe(false);
    expect(isPageMountedMessage('panel:route')).toBe(false);
  });

  it('is self-contained, so a browser test can rebuild it from its source', () => {
    const rebuilt = new Function(`return (${isPageMountedMessage.toString()})`)() as (
      raw: unknown,
    ) => boolean;
    expect(rebuilt({ payload: { type: 'panel:route' } })).toBe(true);
    expect(rebuilt({ payload: { type: 'org:list' } })).toBe(false);
  });
});

describe('intentMessageFor', () => {
  it('hands the page the start it was asked for, named after the page', () => {
    const message = intentMessageFor('orgs', { orgAction: 'import-cli' }, 'intent-1');

    expect(message).toMatchObject({
      id: 'intent-1',
      type: 'navigation:intent',
      payload: { route: 'orgs', orgAction: 'import-cli' },
    });
  });

  it('hands nothing when the command was run without an argument, as the palette runs it', () => {
    expect(intentMessageFor('orgs', undefined, 'intent-2')).toBeUndefined();
  });

  it('refuses an action it does not know, and any other key', () => {
    expect(intentMessageFor('orgs', { orgAction: 'delete-all' }, 'intent-3')).toBeUndefined();
    expect(
      intentMessageFor('orgs', { orgAction: 'login-web', url: 'https://x.invalid' }, 'intent-4'),
    ).toBeUndefined();
    expect(intentMessageFor('orgs', 'login-web', 'intent-5')).toBeUndefined();
  });

  it('lets the browser sign-in through', () => {
    expect(moduleIntentSchema.safeParse({ orgAction: 'login-web' }).success).toBe(true);
  });
});
