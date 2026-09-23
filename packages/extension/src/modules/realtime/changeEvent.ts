/**
 * Change Data Capture events as the Streaming API delivers them over CometD.
 *
 * A first subscription on a live sandbox showed the shape this reads, which is
 * not the one the Pub/Sub API documents:
 *
 * - the message is `{ schema, payload, event: { replayId } }`, and `payload`
 *   holds the `ChangeEventHeader` beside the field values;
 * - a cleared field arrives as an explicit `null` and is listed in
 *   `changedFields`; there is no `nulledFields` list on this transport;
 * - a compound field arrives as an object of its changed parts —
 *   `Name: { FirstName }`, `Address: { Street }` — and `changedFields` names
 *   the parts with a dot: `Name.FirstName`, `Address.Street`;
 * - an UPDATE carries only what changed, `LastModifiedDate` included; a DELETE
 *   carries no field at all.
 *
 * A write needs real field names, so the compound parts are flattened here to
 * the fields they stand for (`Address.Street` on a Lead is `Street`,
 * `BillingAddress.City` on an Account is `BillingCity`).
 */

import { z } from 'zod';

/** One change, read off a CometD message. */
export interface ChangeEvent {
  /** The channel it arrived on, e.g. `/data/LeadChangeEvent`. */
  channel: string;
  /** Position in the channel's stream; a subscription resumes after it. */
  replayId: number;
  /** API name of the object that changed. */
  objectApiName: string;
  /** CREATE, UPDATE, DELETE, UNDELETE, or one of their GAP_ forms, or GAP_OVERFLOW. */
  changeType: string;
  /** The records the change applies to — one transaction can change several alike. */
  recordIds: string[];
  /** When the source org committed the change, epoch milliseconds. */
  commitTimestamp: number;
  /** Id of the user who made the change. */
  commitUser: string;
  /** Groups the events of one transaction. */
  transactionKey: string;
  /**
   * The API and client that made the change, e.g.
   * `com/salesforce/api/rest/66.0;client=SandForgeRealtime`; empty for a change
   * made in the UI.
   */
  changeOrigin: string;
  /** Changed fields as the header lists them, compound parts flattened. */
  changedFieldNames: string[];
  /** The field values the event carries, compound parts flattened; `null` is a cleared field. */
  values: Record<string, unknown>;
}

/** The header every change event carries. */
const changeEventHeaderSchema = z
  .object({
    entityName: z.string().min(1),
    changeType: z.string().min(1),
    recordIds: z.array(z.string()),
    commitTimestamp: z.number(),
    commitUser: z.string().optional(),
    transactionKey: z.string().optional(),
    changeOrigin: z.string().optional(),
    changedFields: z.array(z.string()).optional(),
    nulledFields: z.array(z.string()).optional(),
  })
  .passthrough();

/** A change event message as it comes off the wire. */
const changeEventMessageSchema = z
  .object({
    event: z.object({ replayId: z.number() }).passthrough(),
    payload: z.object({ ChangeEventHeader: changeEventHeaderSchema }).passthrough(),
  })
  .passthrough();

/** Suffix of the event entity of every object that publishes change events. */
const CHANGE_EVENT_SUFFIX = 'ChangeEvent';

/**
 * The CometD channel carrying an object's change events.
 *
 * `Lead` publishes on `/data/LeadChangeEvent`, a custom object `Foo__c` on
 * `/data/Foo__ChangeEvent`.
 */
export function changeEventChannel(objectApiName: string): string {
  const base = objectApiName.endsWith('__c') ? objectApiName.slice(0, -1) : objectApiName;
  return `/data/${base}${CHANGE_EVENT_SUFFIX}`;
}

/**
 * The object a change event entity stands for: `LeadChangeEvent` is `Lead`,
 * `Foo__ChangeEvent` is `Foo__c`. `null` when the name is not a change event.
 */
export function objectOfChangeEntity(entity: string): string | null {
  if (!entity.endsWith(CHANGE_EVENT_SUFFIX) || entity === CHANGE_EVENT_SUFFIX) return null;
  const base = entity.slice(0, -CHANGE_EVENT_SUFFIX.length);
  return base.endsWith('__') ? `${base}c` : base;
}

/**
 * The field a part of a compound field is written to.
 *
 * The parts of `Name` are fields of their own (`FirstName`, `LastName`); an
 * address prefixes its parts with what precedes `Address` (`BillingAddress`
 * → `BillingCity`, and a Lead's plain `Address` → `City`); a custom address or
 * geolocation field `Foo__c` names them `Foo__City__s`.
 */
export function compoundPartField(compound: string, part: string): string {
  if (compound.endsWith('__c')) return `${compound.slice(0, -3)}__${part}__s`;
  if (compound.endsWith('Address')) return `${compound.slice(0, -'Address'.length)}${part}`;
  return part;
}

/** A field name as the header lists it, compound parts flattened. */
function flattenFieldName(name: string): string {
  const dot = name.indexOf('.');
  return dot < 0 ? name : compoundPartField(name.slice(0, dot), name.slice(dot + 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a change event off a CometD message.
 *
 * @param channel - The channel the message arrived on.
 * @param message - The message as the transport handed it over.
 * @throws {Error} Naming what is missing, when the message is not a change event.
 */
export function parseChangeEvent(channel: string, message: unknown): ChangeEvent {
  const parsed = changeEventMessageSchema.safeParse(message);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `A message on ${channel} is not a change event (${issue.path.join('.') || 'message'}: ` +
        `${issue.message}).`,
    );
  }
  const { ChangeEventHeader: header, ...fields } = parsed.data.payload;

  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (isPlainObject(value)) {
      for (const [part, partValue] of Object.entries(value)) {
        values[compoundPartField(name, part)] = partValue;
      }
    } else {
      values[name] = value;
    }
  }
  // Another transport lists the cleared fields apart instead of sending null.
  for (const name of header.nulledFields ?? []) {
    values[flattenFieldName(name)] = null;
  }

  return {
    channel,
    replayId: parsed.data.event.replayId,
    objectApiName: header.entityName,
    changeType: header.changeType,
    recordIds: header.recordIds,
    commitTimestamp: header.commitTimestamp,
    commitUser: header.commitUser ?? '',
    transactionKey: header.transactionKey ?? '',
    changeOrigin: header.changeOrigin ?? '',
    changedFieldNames: (header.changedFields ?? []).map(flattenFieldName),
    values,
  };
}

/** The client id SandForge's real-time writes announce in `Sforce-Call-Options`. */
export const REALTIME_CLIENT_ID = 'SandForgeRealtime';

/**
 * Whether a change was made by a real-time session's own write.
 *
 * The org records the client a write announced in the event's `changeOrigin`
 * (`…;client=SandForgeRealtime`). With source and target the same org, or two
 * sessions writing each other's way, applying such a change again would write
 * it back and receive it back, forever.
 */
export function isOwnWrite(event: Pick<ChangeEvent, 'changeOrigin'>): boolean {
  return event.changeOrigin
    .split(';')
    .some((part) => part.trim() === `client=${REALTIME_CLIENT_ID}`);
}
