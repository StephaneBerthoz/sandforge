/**
 * Translates raw Salesforce API error messages from ForgeExecutionError
 * samples into user-friendly explanations + an actionable hint.
 *
 * Each translator entry takes the raw error string (typically
 * `STATUS_CODE: details`) and returns a structured summary the wizard
 * displays inline next to the technical message. When no rule matches
 * the original message is shown as-is.
 */

/** Translated form of a Salesforce error message. */
export interface TranslatedError {
  /** STATUS_CODE detected (or `'UNKNOWN'`). */
  code: string;
  /** Human-readable explanation. */
  explanation: string;
  /** Suggested next step for the user — short imperative sentence. */
  action: string;
  /** Severity hint for the UI badge. */
  severity: 'info' | 'warning' | 'error';
}

interface Rule {
  /** Salesforce status code or substring matched against the raw message. */
  match: RegExp;
  build: (raw: string, captures: RegExpMatchArray) => TranslatedError;
}

const RULES: Rule[] = [
  {
    match: /^([A-Z_]+):\s*(.*?)(?:\.|$)/,
    build: (_raw, m) => {
      const code = m[1];
      const detail = m[2];
      switch (code) {
        case 'DUPLICATE_VALUE':
          return {
            code,
            explanation:
              "Un record avec la même clé d'unicité existe déjà sur la sandbox cible (probablement cloné lors d'un run précédent).",
            action: 'Supprime le record existant ou change le mode en upsert (à venir).',
            severity: 'warning',
          };
        case 'INVALID_CROSS_REFERENCE_KEY':
          return {
            code,
            explanation:
              "Une référence (Owner, Manager, …) pointe vers un User qui n'existe pas sur la sandbox cible. Le champ a été mis à null automatiquement.",
            action: "Salesforce assignera le User courant. Pas d'action requise sauf si le record nécessite un Owner spécifique.",
            severity: 'info',
          };
        case 'REQUIRED_FIELD_MISSING':
          return {
            code,
            explanation: `Un champ requis est manquant : ${detail}.`,
            action: 'Augmente la profondeur (depth) ou ajoute manuellement le parent référencé au scope.',
            severity: 'error',
          };
        case 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST':
          return {
            code,
            explanation:
              "La valeur source d'un picklist n'existe pas sur la sandbox cible (config divergente).",
            action: 'Aligne les picklists via Salesforce Setup ou laisse le strip automatique faire son travail (silent skip).',
            severity: 'warning',
          };
        case 'INVALID_FIELD_FOR_INSERT_UPDATE':
          return {
            code,
            explanation:
              'Un champ ne peut pas être set à la création (auto-computed, FLS, ou inexistant côté target).',
            action: 'Vérifie la sécurité de champs (FLS) sur ton profile cible, ou aligne le schéma source/target.',
            severity: 'error',
          };
        case 'FIELD_INTEGRITY_EXCEPTION':
          return {
            code,
            explanation: `Contrainte d'intégrité Salesforce non respectée : ${detail}.`,
            action: 'Lis le détail — Salesforce indique souvent le champ ou la règle métier en cause.',
            severity: 'error',
          };
        case 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY':
          return {
            code,
            explanation:
              "Cette table est en lecture seule (audit/history/system). Salesforce n'accepte pas l'insertion.",
            action: 'Cet objet est désormais skipped automatiquement par le scope (isObjectCreatable).',
            severity: 'info',
          };
        case 'INSUFFICIENT_ACCESS_OR_READONLY':
        case 'INSUFFICIENT_ACCESS':
          return {
            code,
            explanation:
              "Ton profile sur la sandbox cible n'a pas les droits suffisants.",
            action: 'Demande à un admin de te donner les droits ou switche vers un User admin.',
            severity: 'error',
          };
        case 'STORAGE_LIMIT_EXCEEDED':
          return {
            code,
            explanation: "La sandbox cible n'a plus de stockage disponible.",
            action: 'Nettoie des données obsolètes ou demande une augmentation de quota Salesforce.',
            severity: 'error',
          };
        case 'INVALID_TYPE':
          return {
            code,
            explanation: "Le type d'objet n'existe pas (probablement supprimé du target).",
            action: 'Aligne les schémas source/target, ou exclus cet objet du scope.',
            severity: 'error',
          };
        case 'NOT_FOUND':
          return {
            code,
            explanation: "Le record source n'a pas été trouvé.",
            action: "Vérifie le record ID et l'org source.",
            severity: 'warning',
          };
        case 'STRING_TOO_LONG':
          return {
            code,
            explanation: `Une valeur dépasse la longueur max du champ : ${detail}.`,
            action: 'Tronque la valeur source ou aligne la longueur des champs entre orgs.',
            severity: 'warning',
          };
        default:
          return {
            code,
            explanation: detail || 'Erreur Salesforce non catégorisée.',
            action: "Consulte la doc Salesforce sur ce code d'erreur ou copie le message au support.",
            severity: 'error',
          };
      }
    },
  },
  {
    match: /Cycle FK '([^']+)' could not be resolved/,
    build: (_raw, m) => ({
      code: 'CYCLE_FK_UNRESOLVED',
      explanation: `Le champ '${m[1]}' référence un parent qui n'a jamais été cloué. Le record a été inséré sans ce lien.`,
      action: 'Augmente la profondeur (depth) pour inclure le parent, ou accepte le record disconnecté.',
      severity: 'warning',
    }),
  },
  {
    match: /no parent in cache and not the root/,
    build: () => ({
      code: 'OUT_OF_SCOPE',
      explanation: "Cet objet n'a aucun chemin vers le record racine — pas de parent dans le scope.",
      action: 'Ajoute manuellement cet objet en mode SOQL custom, ou ignore (probablement reference data isolée).',
      severity: 'info',
    }),
  },
];

/**
 * Translate a raw error message into a structured user-friendly form.
 * Returns `null` when no rule matches — the caller falls back to the
 * raw message in that case.
 */
export function translateForgeError(raw: string): TranslatedError | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const rule of RULES) {
    const m = trimmed.match(rule.match);
    if (m) {
      return rule.build(trimmed, m);
    }
  }
  return null;
}
