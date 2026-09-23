import type { Connection } from 'jsforce';
import type { MetadataComponentType } from '@sandforge/shared';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';

/**
 * What one read of one org answers: each component's content, normalised, or
 * `null` for a component the org holds but will not show. A name missing from
 * the answer was not read.
 */
export type ReadContent = Map<string, string | null>;

/** Reads what components hold, one batch from one org at a time. */
export interface ContentReader {
  /** How many components of a type one read takes; `undefined` when its content cannot be read. */
  batchSize(componentType: MetadataComponentType): number | undefined;
  /** Read one batch of one type from one org. */
  read(
    orgId: string,
    componentType: MetadataComponentType,
    fullNames: readonly string[],
  ): Promise<ReadContent>;
}

/**
 * How each type Compare lists is read.
 *
 * Apex is read by query, where the body comes back as it was saved: fifty
 * classes a query. Everything else through the Metadata API's readMetadata,
 * which takes ten components a call. Custom settings are listed as
 * CustomObjects and "Other" is no type at all, so neither has anything to read.
 */
const HOW_TO_READ: Record<MetadataComponentType, 'source' | 'metadata' | undefined> = {
  ApexClass: 'source',
  ApexTrigger: 'source',
  CustomObject: 'metadata',
  CustomField: 'metadata',
  RecordType: 'metadata',
  LightningComponentBundle: 'metadata',
  Flow: 'metadata',
  WorkflowRule: 'metadata',
  ValidationRule: 'metadata',
  Profile: 'metadata',
  PermissionSet: 'metadata',
  Layout: 'metadata',
  CustomLabel: 'metadata',
  CustomMetadata: 'metadata',
  StaticResource: 'metadata',
  EmailTemplate: 'metadata',
  Report: 'metadata',
  Dashboard: 'metadata',
  CustomSetting: undefined,
  Other: undefined,
};

const SOURCE_BATCH = 50;
const METADATA_BATCH = 10;

/** The type readMetadata is asked for, as jsforce spells its parameter. */
type ReadableType = Parameters<Connection['metadata']['read']>[0];

/**
 * A reader over the two connections of a comparison.
 *
 * @param connectionFor - The connection that reads a given org.
 * @param signal - The comparison's: once it is aborted, a read sends no
 *   further request and rejects with its reason.
 */
export function createContentReader(
  connectionFor: (orgId: string) => Connection,
  signal?: AbortSignal,
): ContentReader {
  return {
    batchSize(componentType) {
      const how = HOW_TO_READ[componentType];
      if (how === 'source') return SOURCE_BATCH;
      if (how === 'metadata') return METADATA_BATCH;
      return undefined;
    },

    async read(orgId, componentType, fullNames) {
      const conn = connectionFor(orgId);
      const how = HOW_TO_READ[componentType];
      if (how === 'source') return readSource(conn, componentType, fullNames, signal);
      if (how === 'metadata') return readMetadata(conn, componentType, fullNames, signal);
      return new Map();
    },
  };
}

/**
 * Apex bodies, by query.
 *
 * listMetadata names a managed class `ns__Name`, the query knows it as `Name`
 * with its `NamespacePrefix` (an Apex name cannot hold two underscores in a
 * row, so the first pair is the namespace's). A managed class answers `null`:
 * its body reads "(hidden)" in every org, so two of them always look alike.
 */
async function readSource(
  conn: Connection,
  componentType: MetadataComponentType,
  fullNames: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadContent> {
  const names = [...new Set(fullNames.map(nameWithoutNamespace))];
  // Each page of the answer is a request of its own: none is asked for once
  // the comparison is stopped.
  const rows = await queryAll<{ NamespacePrefix: string | null; Name: string; Body: string }>(
    conn,
    `SELECT NamespacePrefix, Name, Body FROM ${componentType} WHERE Name IN (${names.map(soqlString).join(', ')})`,
    undefined,
    signal,
  );
  checkApiLimits(conn.limitInfo, `compare:content ${componentType}`);

  const wanted = new Set(fullNames);
  const out: ReadContent = new Map();
  for (const row of rows) {
    const fullName = row.NamespacePrefix ? `${row.NamespacePrefix}__${row.Name}` : row.Name;
    if (!wanted.has(fullName)) continue;
    out.set(fullName, row.NamespacePrefix ? null : normalizeLineEndings(row.Body));
  }
  return out;
}

/**
 * Everything else, through readMetadata.
 *
 * A layout from a managed package is listed as `ns__Object__c-Name` and read
 * only as `ns__Object__c-ns__Name`: one that did not come back under its
 * listed name is asked for once more under that one.
 */
async function readMetadata(
  conn: Connection,
  componentType: MetadataComponentType,
  fullNames: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadContent> {
  const out = await readRecords(conn, componentType, fullNames, signal);
  if (componentType !== 'Layout') return out;

  const retry = new Map<string, string>();
  for (const name of fullNames) {
    const namespaced = out.has(name) ? undefined : namespacedLayoutName(name);
    if (namespaced) retry.set(namespaced, name);
  }
  if (retry.size === 0) return out;
  const readAgain = await readRecords(conn, componentType, [...retry.keys()], signal);
  for (const [asked, content] of readAgain) {
    out.set(retry.get(asked) ?? asked, content);
  }
  return out;
}

/**
 * One readMetadata call. The answer holds one record per name asked, in the
 * order asked; a component the org does not return comes back as a record
 * without a `fullName`, and is left out. A report in a subfolder comes back
 * named by its whole folder path where the listing named it by the last
 * folder only, so a record in a name's place whose path ends with that name
 * is the one asked for.
 */
async function readRecords(
  conn: Connection,
  componentType: MetadataComponentType,
  fullNames: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadContent> {
  signal?.throwIfAborted();
  const answer: unknown = await conn.metadata.read(componentType as ReadableType, [...fullNames]);
  checkApiLimits(conn.limitInfo, `compare:content ${componentType}`);
  const records = (Array.isArray(answer) ? answer : [answer]).filter(isRecord);

  const out: ReadContent = new Map();
  fullNames.forEach((name, index) => {
    const inPlace = records.length === fullNames.length ? records[index] : undefined;
    const record =
      records.find((r) => r.fullName === name) ??
      (typeof inPlace?.fullName === 'string' && inPlace.fullName.endsWith(`/${name}`)
        ? inPlace
        : undefined);
    if (record) out.set(name, canonicalMetadata(componentType, record));
  });
  return out;
}

/** `ns__Object__c-Name` as `ns__Object__c-ns__Name`; `undefined` for a layout of no package. */
function namespacedLayoutName(fullName: string): string | undefined {
  const dash = fullName.indexOf('-');
  if (dash < 0) return undefined;
  const object = fullName.slice(0, dash);
  const layout = fullName.slice(dash + 1);
  const namespace = /^([A-Za-z][A-Za-z0-9]*)__[A-Za-z0-9_]+__[a-z]+$/.exec(object)?.[1];
  if (!namespace || layout.startsWith(`${namespace}__`)) return undefined;
  return `${object}-${namespace}__${layout}`;
}

function nameWithoutNamespace(fullName: string): string {
  const at = fullName.indexOf('__');
  return at > 0 ? fullName.slice(at + 2) : fullName;
}

function soqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Line endings as LF: a body saved from Windows is not a different body. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Salesforce record id, 15 or 18 characters, of the given key prefix. */
function isRecordId(value: unknown, keyPrefix: string): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith(keyPrefix) &&
    /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value)
  );
}

/**
 * Fields that name something only the component's own org has, dropped
 * before comparing. Found by reading the same components from two sandboxes:
 * each of these differed on components that were otherwise identical.
 */
function withoutOrgSpecifics(
  componentType: MetadataComponentType,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  if (componentType === 'Dashboard') {
    // The user a dashboard runs as, by username. A username is unique across
    // every org, so the same person has a different one in each sandbox; the
    // automated process user's even carries the org id.
    delete copy.runningUser;
    delete copy.owner;
  }
  if (componentType === 'Layout' && isRecord(copy.summaryLayout)) {
    // The summary layout's label reads as the layout's own record id, which
    // every org assigns for itself.
    const { masterLabel, ...summary } = copy.summaryLayout;
    copy.summaryLayout = isRecordId(masterLabel, '00h') ? summary : copy.summaryLayout;
  }
  if (componentType === 'Profile' || componentType === 'PermissionSet') {
    // A profile lists every class, page, object and field of its org, each
    // with its flags, granted or not. Six test classes that one sandbox alone
    // held made all 26 of its profiles differ from the other's by an entry
    // granting nothing. Such an entry says what its absence says.
    for (const [key, value] of Object.entries(copy)) {
      if (Array.isArray(value)) copy[key] = value.filter(grantsSomething);
    }
  }
  return copy;
}

/** An entry of a permission list with no flag at all, or with one flag on. */
function grantsSomething(entry: unknown): boolean {
  if (!isRecord(entry)) return true;
  const flags = Object.values(entry).filter((value) => typeof value === 'boolean');
  return flags.length === 0 || flags.some(Boolean);
}

/**
 * Text a component stores base64-encoded: a bundle's files and a template's
 * body. Decoded, a difference shows as the lines that differ, and line
 * endings compare as they do in Apex. A static resource may be an image, so it
 * stays encoded, unless it is a zip archive: then it is the files it holds.
 */
function decodeText(componentType: MetadataComponentType, record: Record<string, unknown>): void {
  if (componentType === 'EmailTemplate' && typeof record.content === 'string') {
    record.content = Buffer.from(record.content, 'base64').toString('utf8');
  }
  if (componentType === 'StaticResource' && typeof record.content === 'string') {
    const files = archiveFiles(Buffer.from(record.content, 'base64'));
    if (files) record.content = { archive: files };
  }
  if (componentType === 'LightningComponentBundle' && isRecord(record.lwcResources)) {
    const files = record.lwcResources.lwcResource;
    for (const file of Array.isArray(files) ? files : [files]) {
      if (isRecord(file) && typeof file.source === 'string') {
        file.source = Buffer.from(file.source, 'base64').toString('utf8');
      }
    }
  }
}

/**
 * The files a zip archive holds, by name, with the checksum and size of each,
 * read from its central directory; `undefined` for anything else.
 *
 * An archive carries the date each file was last packed, and one package
 * installed in two sandboxes at two dates held the same stylesheet, byte for
 * byte, in two archives that differed only there. Two archives listing the
 * same files with the same checksums hold the same files.
 */
function archiveFiles(
  bytes: Buffer,
): Array<{ file: string; crc32: string; size: number }> | undefined {
  // The end-of-central-directory record: 22 bytes, then a comment of at most 65,535.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0 || bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return undefined;

  const files: Array<{ file: string; crc32: string; size: number }> = [];
  let at = bytes.readUInt32LE(end + 16);
  for (let entry = 0; entry < bytes.readUInt16LE(end + 10); entry += 1) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return undefined;
    const nameLength = bytes.readUInt16LE(at + 28);
    files.push({
      file: bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      crc32: bytes
        .readUInt32LE(at + 16)
        .toString(16)
        .padStart(8, '0'),
      size: bytes.readUInt32LE(at + 24),
    });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * The order a list's own entries state, when they state one.
 *
 * Two orgs can list the same entries in two orders: a layout's actions, each
 * carrying its `sortOrder`, and a bundle's files came back shuffled from two
 * sandboxes holding the same ones. Entries that say where they go are put
 * there; any other list keeps the order it came in, since a list of fields or
 * of picklist values means its order.
 */
function inStatedOrder(items: unknown[]): unknown[] {
  if (items.length > 1 && items.every((item) => isRecord(item) && item.sortOrder !== undefined)) {
    return [...items].sort(
      (a, b) =>
        Number((a as Record<string, unknown>).sortOrder) -
        Number((b as Record<string, unknown>).sortOrder),
    );
  }
  if (
    items.length > 1 &&
    items.every((item) => isRecord(item) && typeof item.filePath === 'string')
  ) {
    return [...items].sort((a, b) =>
      String((a as Record<string, unknown>).filePath).localeCompare(
        String((b as Record<string, unknown>).filePath),
      ),
    );
  }
  return items;
}

/**
 * A readMetadata record as comparable text: one `path: value` line per value,
 * keys in order, empty values left out, line endings as LF, and a string of
 * several lines written as an indented block. Two orgs holding the same
 * component give the same text, and where they differ, the first differing
 * line says which value.
 */
export function canonicalMetadata(
  componentType: MetadataComponentType,
  record: Record<string, unknown>,
): string {
  const copy = withoutOrgSpecifics(componentType, structuredClone(record));
  decodeText(componentType, copy);
  const lines: string[] = [];
  writeValue(lines, '', copy);
  return lines.join('\n');
}

function writeValue(lines: string[], path: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${path}: []`);
      return;
    }
    inStatedOrder(value).forEach((item, index) => writeValue(lines, `${path}[${index}]`, item));
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== null && value[key] !== undefined)
      .sort();
    if (keys.length === 0) {
      lines.push(`${path}: {}`);
      return;
    }
    for (const key of keys) writeValue(lines, path ? `${path}.${key}` : key, value[key]);
    return;
  }
  if (typeof value === 'string') {
    const text = normalizeLineEndings(value);
    if (text.includes('\n')) {
      lines.push(`${path}: |`);
      for (const line of text.split('\n')) lines.push(`  ${line}`);
    } else {
      lines.push(`${path}: ${JSON.stringify(text)}`);
    }
    return;
  }
  lines.push(`${path}: ${String(value)}`);
}
