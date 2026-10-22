/**
 * Whether the user a connection runs as reads classic encrypted fields
 * (`encryptedstring`) in clear: the View Encrypted Data permission, read from
 * `UserPermissionAccess`, which answers for the running user.
 *
 * Without it the API answers every such field masked (`***-**-1234`). The
 * values a Sync run wrote over were kept as the target answered them: a mask
 * was kept as the value from before, written back by the run's removal — or
 * compared with the mask the field still answered, counted given back, and
 * not written — and the removal said the value was back.
 */

/** Reads the target with SOQL: every row a statement returns. */
export type RowsQuery = (soql: string) => Promise<Array<Record<string, unknown>>>;

/** The field type of a classic encrypted field, as a describe names it. */
export const ENCRYPTED_FIELD_TYPE = 'encryptedstring';

/**
 * Whether the running user reads encrypted fields in clear. An org that will
 * not say is taken for one that does not: a field read masked and kept as
 * the value from before writes the mask back.
 */
export async function viewsEncryptedData(query: RowsQuery): Promise<boolean> {
  try {
    const [row] = await query('SELECT PermissionsViewEncryptedData FROM UserPermissionAccess');
    return row?.PermissionsViewEncryptedData === true;
  } catch {
    return false;
  }
}

/**
 * {@link viewsEncryptedData}, asked once, the first time a call writes an
 * encrypted field, and answered from then on without asking again.
 */
export function viewsEncryptedDataOnce(query: RowsQuery): () => Promise<boolean> {
  let asked: Promise<boolean> | undefined;
  return () => {
    asked ??= viewsEncryptedData(query);
    return asked;
  };
}
