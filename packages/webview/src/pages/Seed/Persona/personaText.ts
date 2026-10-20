import type { TFunction, i18n as I18n } from 'i18next';
import type { PersonaMsg } from '@sandforge/shared';

/**
 * A persona's name and description in the interface language.
 *
 * The built-in personas carry their name and description as the extension
 * wrote them — eight names in French, seven descriptions in English — and
 * every card showed them as they came, the two languages side by side
 * whatever the interface was in. A built-in persona is now read from the
 * catalogue by its id; a persona someone created keeps the words it was
 * created with.
 */
function personaText(
  persona: Pick<PersonaMsg, 'id'>,
  part: 'name' | 'description',
  t: TFunction,
  i18n: Pick<I18n, 'exists'>,
): string | undefined {
  const key = `seed.persona.builtIn.${persona.id}.${part}`;
  return i18n.exists(key) ? t(`seed.persona.builtIn.${persona.id}.${part}`) : undefined;
}

/** A persona's name in the interface language: see {@link personaText}. */
export function personaName(
  persona: Pick<PersonaMsg, 'id' | 'name'>,
  t: TFunction,
  i18n: Pick<I18n, 'exists'>,
): string {
  return personaText(persona, 'name', t, i18n) ?? persona.name;
}

/** A persona's description in the interface language: see {@link personaText}. */
export function personaDescription(
  persona: Pick<PersonaMsg, 'id' | 'description'>,
  t: TFunction,
  i18n: Pick<I18n, 'exists'>,
): string {
  return personaText(persona, 'description', t, i18n) ?? persona.description;
}
