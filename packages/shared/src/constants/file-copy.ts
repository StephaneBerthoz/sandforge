/**
 * How a Forge run copies the files of the records it clones.
 *
 * A file goes across in one call each way: its content read from the source,
 * then written to the target as the base64 value of a JSON body. Salesforce
 * takes 50 MB of text in such a body, 37.5 MB of file once base64 has added
 * its third. Thirty-five whole megabytes stay under that whichever way the
 * megabyte is counted, with room for the fields sent beside the content. A
 * larger file would need a multipart request, which the run does not send:
 * it leaves such a file out and lists it, and never cuts one short.
 */

/** Bytes in a megabyte, as Salesforce counts file storage. */
export const BYTES_PER_MB = 1_048_576;

/** The largest file a run copies unless the user sets another size, in MB. */
export const FILE_COPY_DEFAULT_MAX_MB = 10;

/** The largest file one call carries, in MB: the most the size can be set to. */
export const FILE_COPY_CEILING_MB = 35;

/**
 * The type a describe gives a field that holds a file's content.
 *
 * Read through the data API, such a field comes back as the address of its
 * content, never as the content: a copy that writes the value it read writes
 * that address in the file's place. The files stage reads a Salesforce File's
 * version and an attachment's body from their own address, and every other
 * field of the type is left out of a copy.
 */
const FILE_CONTENT_FIELD_TYPE = 'base64';

/** Whether a field holds a file's content, by the type its describe gives it. */
export function isFileContentField(field: { readonly type?: string }): boolean {
  return field.type === FILE_CONTENT_FIELD_TYPE;
}

/**
 * Why a run that copies files may not start, or null when it may.
 *
 * The content of a file cannot be anonymized: a run that anonymizes its
 * records and copies files writes those files as the source holds them. That
 * is refused unless the user accepted it, in a confirmation of its own, rather
 * than letting the anonymization of the records suggest it covers the files.
 *
 * @param anonymizes - Whether the run anonymizes its records.
 * @param acceptedAsIs - Whether the user accepted that files are copied as they are.
 */
export function fileCopyRefusal(anonymizes: boolean, acceptedAsIs: boolean): string | null {
  if (!anonymizes || acceptedAsIs) return null;
  return (
    'This run anonymizes its records, and the content of a file cannot be anonymized: ' +
    'files are copied only once you accept that they are copied as they are. ' +
    'Nothing was read or written.'
  );
}
