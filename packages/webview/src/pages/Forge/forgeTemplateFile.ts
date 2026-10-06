/**
 * A Forge template as a file of its own, to hand to someone else or to keep.
 *
 * Sharing a template used to mean committing the workspace's
 * `.sandforge/forge-templates.json`, or exporting a whole profile from
 * Settings. A file holds one template, as the workspace's file holds each:
 * the same JSON, read back through the same schema.
 */
import type { ForgeTemplate } from '@sandforge/shared';
import { forgeTemplateSchema } from '@sandforge/shared';

/**
 * The largest file read as a template. A template with every decision and
 * every field a graph can hold stays well under it; a file past it is not one.
 */
export const TEMPLATE_FILE_MAX_BYTES = 1_000_000;

/** Why a file was not taken as a template. */
export type TemplateFileRefusal =
  | { reason: 'too_large' }
  | { reason: 'not_json' }
  /** `where` names the first part the schema refused, '' for the file as a whole. */
  | { reason: 'not_template'; where: string };

/** A file read as a template, or why it is not one. */
export type TemplateFileReading =
  { ok: true; template: ForgeTemplate } | ({ ok: false } & TemplateFileRefusal);

/** The name a template's file is offered under: its own name, made safe for a path. */
export function templateFileName(template: ForgeTemplate): string {
  const slug = template.name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `forge-template-${slug || template.id}.json`;
}

/** What a template's file holds: the template, as the workspace's file holds it. */
export function templateFileContent(template: ForgeTemplate): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Read `text` as a template, through the schema the extension saves templates
 * with: what it does not name is dropped, and a file it refuses is refused
 * here first, with the part it refused.
 */
export function readTemplateFile(text: string): TemplateFileReading {
  if (text.length > TEMPLATE_FILE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const result = forgeTemplateSchema.safeParse(parsed);
  if (result.success) return { ok: true, template: result.data };
  const where = result.error.issues[0]?.path.map(String).join('.') ?? '';
  return { ok: false, reason: 'not_template', where };
}
