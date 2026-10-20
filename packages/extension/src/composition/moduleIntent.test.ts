import { describe, expect, it } from 'vitest';
import { intentMessageFor, moduleIntentSchema } from './moduleIntent';

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
