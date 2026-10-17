/**
 * What a discovery of the source found, kept in the sas for the next step.
 *
 * Selection and extraction each discovered the root object's graph again:
 * the describes a discovery makes are held by the process that made them,
 * and every step of the command line is a process of its own. Counted on the
 * Developer Edition source, a selection sent 420 requests and the extraction
 * after it 409, two hundred describes and nearly as many counts each time —
 * the same graph twice.
 *
 * The graph is kept with the describes the step read through it and the
 * key prefixes of the org, under the source org, the root object and the cap
 * it was discovered at, and with the org's own clock when it began — the
 * stamp a later step asks the org whether its schema changed since. Kept a
 * day at most: the graph counts whole tables, and an object empty when it was
 * discovered is left out of it.
 *
 * The file is written by the extension and read back as external input: an
 * envelope it does not recognise is no graph kept.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { ForgeGraph } from '@sandforge/shared';
import type { ObjectDescribe } from '../forge/GraphDiscoveryService.js';
import { SasPathGuard } from './SasPathGuard.js';

/** File name of the kept discovery inside the sas directory. */
export const DISCOVERY_FILE_NAME = 'discovery.json';

/** How long a kept graph is reused at most, whatever the org says of its schema. */
export const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60_000;

/** The steps that discover a graph. */
export type DiscoveringStep = 'select' | 'extract';

/** A discovery kept in the sas. */
export interface KeptDiscovery {
  /** Envelope format version. */
  fileVersion: 1;
  /** The registered id of the org the graph is of. */
  sourceOrgId: string;
  /** The root object it was discovered from. */
  rootObject: string;
  /** The object cap it was discovered at. */
  maxNodes: number;
  /** The step that discovered it. */
  step: DiscoveringStep;
  /** When the step discovered it, by this machine's clock, ISO 8601. */
  discoveredAt: string;
  /**
   * The org's own clock as the discovery began, ISO 8601: what a later step
   * asks the org whether its schema changed since. Absent when the org did
   * not say, and the graph is then not reused.
   */
  schemaStamp?: string;
  /** The graph as discovery answered it, before the configuration's exclusions. */
  graph: ForgeGraph;
  /** The describes the step read, by object. */
  describes: Record<string, ObjectDescribe>;
  /** The objects of the org and the key prefix of each. */
  objects: Array<{ name: string; keyPrefix: string | null }>;
}

const describeSchema = z
  .object({
    name: z.string(),
    fields: z.array(
      z.object({ name: z.string(), type: z.string(), referenceTo: z.array(z.string()) }).loose(),
    ),
    childRelationships: z.array(
      z
        .object({ childSObject: z.string(), field: z.string(), relationshipName: z.string() })
        .loose(),
    ),
  })
  .loose();

const keptDiscoverySchema = z.object({
  fileVersion: z.literal(1),
  sourceOrgId: z.string().min(1),
  rootObject: z.string().min(1),
  maxNodes: z.number().int().positive(),
  step: z.enum(['select', 'extract']),
  discoveredAt: z.iso.datetime(),
  schemaStamp: z.iso.datetime().optional(),
  graph: z
    .object({
      nodes: z.array(z.object({ objectApiName: z.string(), included: z.boolean() }).loose()),
      edges: z.array(z.object({ sourceObject: z.string(), targetObject: z.string() }).loose()),
    })
    .loose(),
  describes: z.record(z.string(), describeSchema),
  objects: z.array(z.object({ name: z.string(), keyPrefix: z.string().nullable() })),
});

/** What reading the kept discovery gave: the discovery, or why there is none to reuse. */
export type KeptDiscoveryRead = { kept: KeptDiscovery } | { none: string };

/**
 * Write a discovery to `<sasDir>/discovery.json`, in place of the one kept.
 *
 * @returns The absolute path written.
 */
export async function writeDiscoveryToSas(
  sasDir: string,
  kept: KeptDiscovery,
  guard: SasPathGuard = new SasPathGuard(),
): Promise<string> {
  const dir = guard.assertOutsideRepo(sasDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = guard.assertOutsideRepo(path.join(dir, DISCOVERY_FILE_NAME));
  await fs.writeFile(filePath, `${JSON.stringify(kept)}\n`, 'utf8');
  return filePath;
}

/** Read the discovery kept in the sas, or say why there is none to reuse. */
export async function readDiscoveryFromSas(
  sasDir: string,
  guard: SasPathGuard = new SasPathGuard(),
): Promise<KeptDiscoveryRead> {
  const filePath = guard.assertOutsideRepo(path.join(sasDir, DISCOVERY_FILE_NAME));
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return { none: 'no graph kept in the sas' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { none: 'the graph kept in the sas could not be read' };
  }
  const parsed = keptDiscoverySchema.safeParse(payload);
  if (!parsed.success) return { none: 'the graph kept in the sas could not be read' };
  // Checked above as far as a reuse reads it; the rest is the graph and the
  // describes the extension wrote.
  return { kept: parsed.data as unknown as KeptDiscovery };
}

/**
 * Why a kept discovery would not do for a step, or `undefined` when it would
 * as far as the sas tells: of the same org, root object and cap, younger than
 * {@link DISCOVERY_MAX_AGE_MS}, and stamped with the org's clock — whether the
 * schema changed since is the org's to say.
 */
export function whyNotReused(
  kept: KeptDiscovery,
  wanted: { sourceOrgId: string; rootObject: string; maxNodes: number },
  now: Date = new Date(),
): string | undefined {
  if (kept.sourceOrgId !== wanted.sourceOrgId) return 'the graph kept is of another org';
  if (kept.rootObject !== wanted.rootObject) {
    return `the graph kept is of ${kept.rootObject}, not ${wanted.rootObject}`;
  }
  if (kept.maxNodes !== wanted.maxNodes) {
    return `the graph kept was discovered at a cap of ${kept.maxNodes}, not ${wanted.maxNodes}`;
  }
  const age = now.getTime() - Date.parse(kept.discoveredAt);
  if (!(age >= 0 && age <= DISCOVERY_MAX_AGE_MS)) {
    return `the graph kept was discovered on ${kept.discoveredAt}, more than a day ago`;
  }
  if (!kept.schemaStamp) {
    return 'the org did not give its clock when the graph kept was discovered';
  }
  return undefined;
}

/**
 * The stamp of a discovery from the org's clock as it began: to the second
 * below, and a second before it. The org compares a schema change with it to
 * the second, and a change in the second the discovery began may have come
 * after it: taken for one before, the graph would be reused without it.
 */
export function schemaStampOf(orgTime: string): string | undefined {
  const at = Date.parse(orgTime);
  if (Number.isNaN(at)) return undefined;
  return new Date(Math.floor(at / 1000) * 1000 - 1000).toISOString();
}
