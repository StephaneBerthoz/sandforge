import { describe, expect, it, vi } from 'vitest';
import { viewsEncryptedData, viewsEncryptedDataOnce } from './encryptedFields';

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
