import { describe, expect, it, vi } from 'vitest';
import {
  maskedEncryptedFields,
  viewsEncryptedData,
  viewsEncryptedDataOnce,
} from './encryptedFields';

describe('viewsEncryptedData', () => {
  it('reads the running user’s View Encrypted Data permission', async () => {
    const query = vi.fn(async () => [{ PermissionsViewEncryptedData: true }]);

    expect(await viewsEncryptedData(query)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      'SELECT PermissionsViewEncryptedData FROM UserPermissionAccess',
    );
    expect(await viewsEncryptedData(async () => [{ PermissionsViewEncryptedData: false }])).toBe(
      false,
    );
  });

  it('takes an org that will not say for one whose user reads them masked', async () => {
    expect(
      await viewsEncryptedData(async () => {
        throw new Error('INVALID_FIELD');
      }),
    ).toBe(false);
    expect(await viewsEncryptedData(async () => [])).toBe(false);
  });

  it('asks once, however many calls write an encrypted field', async () => {
    const query = vi.fn(async () => [{ PermissionsViewEncryptedData: true }]);
    const views = viewsEncryptedDataOnce(query);

    await views();
    await views();

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('maskedEncryptedFields', () => {
  /** A contact with one classic encrypted field among plain ones. */
  const contact = async () => ({
    fields: [
      { name: 'LastName', type: 'string' },
      { name: 'SSN__c', type: 'encryptedstring' },
      { name: 'Email', type: 'email' },
    ],
  });

  it('names the encrypted fields of an object its user reads masked, each object described once', async () => {
    const describe = vi.fn(contact);
    const masked = maskedEncryptedFields(
      viewsEncryptedDataOnce(async () => []),
      describe,
    );

    expect(await masked('Contact')).toEqual(['SSN__c']);
    expect(await masked('Contact')).toEqual(['SSN__c']);
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('names none when its user reads them in clear', async () => {
    const masked = maskedEncryptedFields(
      viewsEncryptedDataOnce(async () => [{ PermissionsViewEncryptedData: true }]),
      contact,
    );

    expect(await masked('Contact')).toEqual([]);
  });

  it('asks nothing of the permission for an object that has no encrypted field', async () => {
    const permission = vi.fn(async () => [{ PermissionsViewEncryptedData: false }]);
    const masked = maskedEncryptedFields(viewsEncryptedDataOnce(permission), async () => ({
      fields: [{ name: 'Name', type: 'string' }],
    }));

    expect(await masked('Account')).toEqual([]);
    expect(permission).not.toHaveBeenCalled();
  });

  it('names none of an object that would not describe', async () => {
    const masked = maskedEncryptedFields(
      async () => false,
      async () => {
        throw new Error('NOT_FOUND');
      },
    );

    expect(await masked('Contact')).toEqual([]);
  });
});
