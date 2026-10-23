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

/** An object's fields as a describe names and types them. */
export type FieldsDescribe = (
  objectApiName: string,
) => Promise<{ fields: ReadonlyArray<{ name: string; type?: string }> }>;

/**
 * The classic encrypted fields of an object that the user a connection runs
 * as reads masked: none when it views encrypted data in clear, or when the
 * object has none, or would not describe. Each object is described once, and
 * the permission asked (`viewsEncrypted`) only of one that has such a field:
 * most objects of most orgs have none.
 *
 * A Sync run copied what the source answered for them, `***-**-1234`, into
 * the target, over the real value of a record it updated; and the backup of
 * a DataOps operation kept the masks, which a restore wrote back.
 *
 * @param viewsEncrypted - Whether the user reads them in clear (`viewsEncryptedDataOnce`).
 * @param describe - The object's describe.
 */
export function maskedEncryptedFields(
  viewsEncrypted: () => Promise<boolean>,
  describe: FieldsDescribe,
): (objectApiName: string) => Promise<string[]> {
  const byObject = new Map<string, Promise<string[]>>();
  return (objectApiName) => {
    let fields = byObject.get(objectApiName);
    if (!fields) {
      fields = (async () => {
        let encrypted: string[];
        try {
          const described = await describe(objectApiName);
          encrypted = described.fields
            .filter((field) => field.type === ENCRYPTED_FIELD_TYPE)
            .map((field) => field.name);
        } catch {
          return [];
        }
        return encrypted.length > 0 && !(await viewsEncrypted()) ? encrypted : [];
      })();
      byObject.set(objectApiName, fields);
    }
    return fields;
  };
}
