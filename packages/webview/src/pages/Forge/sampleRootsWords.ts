import type { TFunction } from 'i18next';
import type { ForgeSampleWindow, WholeOrgSampleRoots } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';

/*
 * How a sample's roots were chosen, in the words of the Forge page itself:
 * its history says them as the simulation and the results do, and loads no
 * English of Review, the run or the results to say them.
 */

/**
 * An instant of a window, in UTC as the window holds it, in the interface
 * language: the date and the time, said as UTC. One that does not read is
 * said as written.
 */
export function windowInstantWords(instant: string): string {
  const time = Date.parse(instant);
  if (!Number.isFinite(time)) return instant;
  const said = new Date(time).toLocaleString(uiLocale(), {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${said} UTC`;
}

/**
 * The dates a sample's roots were drawn in, as a list of what chose them
 * says it: made or last modified, from, to before, or within the last days —
 * the instant those days started at beside them when the draw resolved it.
 */
export function windowWords(t: TFunction, window: ForgeSampleWindow): string {
  const made = t(
    window.field === 'LastModifiedDate'
      ? 'forge.sampleRoots.window.modified'
      : 'forge.sampleRoots.window.created',
  );
  if (window.lastDays !== undefined) {
    const last = t('forge.sampleRoots.window.last', {
      made,
      count: window.lastDays,
      days: window.lastDays.toLocaleString(uiLocale()),
    });
    return window.from !== undefined
      ? t('forge.sampleRoots.window.lastFrom', { last, from: windowInstantWords(window.from) })
      : last;
  }
  const from = window.from !== undefined ? windowInstantWords(window.from) : undefined;
  const to = window.to !== undefined ? windowInstantWords(window.to) : undefined;
  if (from !== undefined && to !== undefined) {
    return t('forge.sampleRoots.window.between', { made, from, to });
  }
  if (from !== undefined) return t('forge.sampleRoots.window.from', { made, from });
  return t('forge.sampleRoots.window.to', { made, to: to ?? '' });
}

/**
 * How a sample's roots were chosen, as a sentence lists it: the window, each
 * filter of an object's roots — by its text where the plan keeps it, by the
 * object's name alone where only that is kept —, and each object's stratum,
 * or the fields stratified. Empty for a draw among every root.
 */
export function rootsChosenWords(
  t: TFunction,
  roots: Pick<WholeOrgSampleRoots, 'window' | 'where' | 'strata'> & {
    whereObjects?: readonly string[];
    strataFields?: readonly string[];
  },
): string {
  const said: string[] = [];
  if (roots.window) said.push(windowWords(t, roots.window));
  for (const { objectApiName, where } of roots.where ?? []) {
    said.push(t('forge.sampleRoots.where', { object: objectApiName, where }));
  }
  if (roots.where === undefined && roots.whereObjects && roots.whereObjects.length > 0) {
    said.push(t('forge.sampleRoots.whereObjects', { objects: roots.whereObjects.join(', ') }));
  }
  for (const { objectApiName, field } of roots.strata ?? []) {
    said.push(t('forge.sampleRoots.stratum', { object: objectApiName, field }));
  }
  if (roots.strata === undefined && roots.strataFields && roots.strataFields.length > 0) {
    said.push(t('forge.sampleRoots.strataFields', { fields: roots.strataFields.join(', ') }));
  }
  return said.join('; ');
}
