import { z } from 'zod';
import {
  PersonaReplySchema,
  SUPPORTED_FAKER_METHODS,
  acceptsGeneratedSentence,
  parseModelJson,
  resolveFakerMethod,
} from '@sandforge/shared';

/** Re-exported from the central AI types module (single source of truth). */
export type { AIProvider } from './types.js';
import type { AIProvider } from './types.js';

/** Describes how a specific field should be generated for a persona. */
export interface PersonaFieldPattern {
  fieldType: string;
  generator: string;
  params?: Record<string, unknown>;
  examples: string[];
}

/** An AI persona that defines data generation patterns for a specific industry/context. */
export interface AIPersona {
  id: string;
  name: string;
  description: string;
  industry: string;
  locale: string;
  dataPatterns: Record<string, PersonaFieldPattern>;
}

/** Built-in persona definitions for common industry use cases. */
const BUILT_IN_PERSONAS: AIPersona[] = [
  {
    id: 'assureur-fr',
    name: 'Assureur français',
    description: "Compagnie d'assurance française avec contrats, sinistres et assurés.",
    industry: 'Insurance',
    locale: 'fr-FR',
    dataPatterns: {
      Name: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'company.name', locale: 'fr' },
        examples: ['AXA Prévoyance', 'Mutuelle du Soleil', 'Groupe Assurancia'],
      },
      FirstName: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.firstName', locale: 'fr' },
        examples: ['Jean', 'Marie', 'Philippe'],
      },
      LastName: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.lastName', locale: 'fr' },
        examples: ['Dupont', 'Martin', 'Lefebvre'],
      },
      SIRET__c: {
        fieldType: 'string',
        generator: 'pattern',
        params: { pattern: '###########00##' },
        examples: ['12345678900012', '98765432100034', '55566677800015'],
      },
      Contract_Type__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Auto', 'Habitation', 'Santé', 'Vie', 'Responsabilité Civile'] },
        examples: ['Auto', 'Habitation', 'Santé'],
      },
      Premium__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 200, max: 5000, currency: 'EUR' },
        examples: ['450.00', '1200.50', '3200.00'],
      },
    },
  },
  {
    id: 'hospital-us',
    name: 'Hôpital américain',
    description: 'Hospital system with patients, procedures, and medical codes.',
    industry: 'Healthcare',
    locale: 'en-US',
    dataPatterns: {
      FirstName: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.firstName', locale: 'en_US' },
        examples: ['James', 'Sarah', 'Michael'],
      },
      LastName: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.lastName', locale: 'en_US' },
        examples: ['Johnson', 'Williams', 'Smith'],
      },
      MRN__c: {
        fieldType: 'string',
        generator: 'sequence',
        params: { prefix: 'MRN-', padLength: 8 },
        examples: ['MRN-00000001', 'MRN-00000002', 'MRN-00000003'],
      },
      ICD10_Code__c: {
        fieldType: 'string',
        generator: 'random_pick',
        params: { values: ['J06.9', 'I10', 'E11.9', 'M54.5', 'J18.9', 'K21.0', 'N39.0'] },
        examples: ['J06.9', 'I10', 'E11.9'],
      },
      CPT_Code__c: {
        fieldType: 'string',
        generator: 'random_pick',
        params: { values: ['99213', '99214', '99215', '99203', '99204', '36415', '71046'] },
        examples: ['99213', '99214', '36415'],
      },
      Insurance_Provider__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: {
          values: ['Blue Cross', 'Aetna', 'UnitedHealth', 'Cigna', 'Medicare', 'Medicaid'],
        },
        examples: ['Blue Cross', 'Aetna', 'Medicare'],
      },
    },
  },
  {
    id: 'ecommerce-b2c',
    name: 'E-commerce B2C',
    description: 'Online retail with products, orders, customers, and reviews.',
    industry: 'Retail',
    locale: 'en-US',
    dataPatterns: {
      Product_Name__c: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'commerce.productName' },
        examples: [
          'Ergonomic Steel Chair',
          'Wireless Bluetooth Headphones',
          'Organic Cotton T-Shirt',
        ],
      },
      SKU__c: {
        fieldType: 'string',
        generator: 'sequence',
        params: { prefix: 'SKU-', padLength: 6 },
        examples: ['SKU-000001', 'SKU-000002', 'SKU-000003'],
      },
      Price__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 9.99, max: 999.99, currency: 'USD' },
        examples: ['29.99', '149.50', '499.00'],
      },
      Order_Status__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: {
          values: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Returned', 'Cancelled'],
        },
        examples: ['Pending', 'Shipped', 'Delivered'],
      },
      Rating__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 1, max: 5 },
        examples: ['4', '5', '3'],
      },
      Review_Text__c: {
        fieldType: 'textarea',
        generator: 'ai_generate',
        params: { prompt: 'Product review, 1-3 sentences, realistic tone' },
        examples: [
          'Great product, fast shipping!',
          'Good quality but runs small.',
          'Exactly as described.',
        ],
      },
    },
  },
  {
    id: 'banque-eu',
    name: 'Banque européenne',
    description: 'European bank with accounts, transactions, IBAN/BIC codes.',
    industry: 'Banking',
    locale: 'fr-FR',
    dataPatterns: {
      IBAN__c: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'finance.iban', locale: 'fr' },
        examples: [
          'FR7630006000011234567890189',
          'DE89370400440532013000',
          'ES9121000418450200051332',
        ],
      },
      BIC__c: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'finance.bic' },
        examples: ['BNPAFRPPXXX', 'DEUTDEFFXXX', 'BBVAESMMXXX'],
      },
      Transaction_Amount__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: -10000, max: 50000, currency: 'EUR' },
        examples: ['1250.00', '-450.75', '15000.00'],
      },
      Transaction_Type__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Virement', 'Prélèvement', 'Carte', 'Chèque', 'Espèces'] },
        examples: ['Virement', 'Carte', 'Prélèvement'],
      },
      Account_Type__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Courant', 'Épargne', 'PEL', 'Titre', 'Professionnel'] },
        examples: ['Courant', 'Épargne', 'PEL'],
      },
      Risk_Score__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 0, max: 100 },
        examples: ['15', '42', '78'],
      },
    },
  },
  {
    id: 'startup-saas',
    name: 'Startup SaaS',
    description: 'SaaS company with subscriptions, MRR metrics, churn tracking.',
    industry: 'Technology',
    locale: 'en-US',
    dataPatterns: {
      Company_Name__c: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'company.name' },
        examples: ['Acme Cloud', 'DataSync Pro', 'NeuralFlow AI'],
      },
      Plan__c: {
        fieldType: 'picklist',
        generator: 'weighted_pick',
        params: { values: { Free: 0.4, Starter: 0.25, Pro: 0.2, Enterprise: 0.15 } },
        examples: ['Free', 'Pro', 'Enterprise'],
      },
      MRR__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 0, max: 25000, currency: 'USD' },
        examples: ['0.00', '499.00', '12500.00'],
      },
      Churn_Risk__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Low', 'Medium', 'High', 'Critical'] },
        examples: ['Low', 'Medium', 'High'],
      },
      Active_Users__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 1, max: 500 },
        examples: ['12', '85', '250'],
      },
      NPS_Score__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: -100, max: 100 },
        examples: ['72', '-15', '45'],
      },
    },
  },
  {
    id: 'immobilier',
    name: 'Immobilier',
    description: 'Agence immobilière avec biens, mandats et visites.',
    industry: 'Real Estate',
    locale: 'fr-FR',
    dataPatterns: {
      Property_Type__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: {
          values: ['Appartement', 'Maison', 'Studio', 'Loft', 'Terrain', 'Local commercial'],
        },
        examples: ['Appartement', 'Maison', 'Studio'],
      },
      Surface__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 15, max: 300, unit: 'm²' },
        examples: ['45', '120', '85'],
      },
      Price__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 50000, max: 2000000, currency: 'EUR' },
        examples: ['185000', '450000', '1200000'],
      },
      City__c: {
        fieldType: 'string',
        generator: 'random_pick',
        params: {
          values: ['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Toulouse', 'Nantes', 'Lille'],
        },
        examples: ['Paris', 'Lyon', 'Bordeaux'],
      },
      Mandate_Type__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Exclusif', 'Simple', 'Semi-exclusif'] },
        examples: ['Exclusif', 'Simple', 'Semi-exclusif'],
      },
      DPE__c: {
        fieldType: 'picklist',
        generator: 'weighted_pick',
        params: { values: { A: 0.05, B: 0.1, C: 0.2, D: 0.3, E: 0.2, F: 0.1, G: 0.05 } },
        examples: ['C', 'D', 'B'],
      },
    },
  },
  {
    id: 'education',
    name: 'Éducation',
    description: 'Educational institution with students, courses, and grades.',
    industry: 'Education',
    locale: 'fr-FR',
    dataPatterns: {
      Student_ID__c: {
        fieldType: 'string',
        generator: 'sequence',
        params: { prefix: 'STU-', padLength: 6 },
        examples: ['STU-000001', 'STU-000002', 'STU-000003'],
      },
      FirstName: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.firstName', locale: 'fr' },
        examples: ['Léa', 'Hugo', 'Emma'],
      },
      LastName: {
        fieldType: 'string',
        generator: 'faker',
        params: { method: 'person.lastName', locale: 'fr' },
        examples: ['Bernard', 'Petit', 'Robert'],
      },
      Course_Name__c: {
        fieldType: 'string',
        generator: 'random_pick',
        params: {
          values: [
            'Mathématiques',
            'Physique',
            'Histoire',
            'Anglais',
            'Informatique',
            'Philosophie',
          ],
        },
        examples: ['Mathématiques', 'Physique', 'Informatique'],
      },
      Grade__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 0, max: 20, precision: 1 },
        examples: ['14.5', '8.0', '17.5'],
      },
      Semester__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] },
        examples: ['S1', 'S2', 'S3'],
      },
    },
  },
  {
    id: 'logistique',
    name: 'Logistique',
    description: 'Logistics company with parcels, warehouses, and shipment tracking.',
    industry: 'Logistics',
    locale: 'fr-FR',
    dataPatterns: {
      Tracking_Number__c: {
        fieldType: 'string',
        generator: 'sequence',
        params: { prefix: 'TRK-', padLength: 10 },
        examples: ['TRK-0000000001', 'TRK-0000000002', 'TRK-0000000003'],
      },
      Status__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: {
          values: ['En préparation', 'Expédié', 'En transit', 'En livraison', 'Livré', 'Retourné'],
        },
        examples: ['Expédié', 'En transit', 'Livré'],
      },
      Weight__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 0.1, max: 500, unit: 'kg' },
        examples: ['2.5', '15.0', '125.0'],
      },
      Warehouse__c: {
        fieldType: 'string',
        generator: 'random_pick',
        params: {
          values: ['Paris-Nord', 'Lyon-Est', 'Marseille-Port', 'Bordeaux-Sud', 'Lille-Centre'],
        },
        examples: ['Paris-Nord', 'Lyon-Est', 'Marseille-Port'],
      },
      Carrier__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Colissimo', 'Chronopost', 'DHL', 'FedEx', 'UPS', 'GLS'] },
        examples: ['Colissimo', 'Chronopost', 'DHL'],
      },
      Delivery_Date__c: {
        fieldType: 'date',
        generator: 'relative_date',
        params: { minDaysFromNow: 1, maxDaysFromNow: 14 },
        examples: ['2026-03-01', '2026-03-05', '2026-03-12'],
      },
    },
  },
  {
    id: 'rh',
    name: 'Ressources humaines',
    description: 'HR department with employees, leaves, payroll, and performance.',
    industry: 'Human Resources',
    locale: 'fr-FR',
    dataPatterns: {
      Employee_ID__c: {
        fieldType: 'string',
        generator: 'sequence',
        params: { prefix: 'EMP-', padLength: 5 },
        examples: ['EMP-00001', 'EMP-00002', 'EMP-00003'],
      },
      Department__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['R&D', 'Marketing', 'Ventes', 'RH', 'Finance', 'Support', 'Direction'] },
        examples: ['R&D', 'Marketing', 'Finance'],
      },
      Contract_Type__c: {
        fieldType: 'picklist',
        generator: 'weighted_pick',
        params: { values: { CDI: 0.6, CDD: 0.2, Stage: 0.1, Alternance: 0.1 } },
        examples: ['CDI', 'CDD', 'Stage'],
      },
      Salary__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 25000, max: 120000, currency: 'EUR' },
        examples: ['35000', '55000', '85000'],
      },
      Leave_Type__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: {
          values: ['Congés payés', 'RTT', 'Maladie', 'Sans solde', 'Maternité', 'Formation'],
        },
        examples: ['Congés payés', 'RTT', 'Maladie'],
      },
      Leave_Days__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 0.5, max: 25 },
        examples: ['1', '5', '12'],
      },
    },
  },
  {
    id: 'ong',
    name: 'ONG/Association',
    description: 'Non-profit organization with donors, campaigns, and volunteers.',
    industry: 'Non-Profit',
    locale: 'fr-FR',
    dataPatterns: {
      Donor_Type__c: {
        fieldType: 'picklist',
        generator: 'weighted_pick',
        params: { values: { Particulier: 0.7, Entreprise: 0.2, Fondation: 0.1 } },
        examples: ['Particulier', 'Entreprise', 'Fondation'],
      },
      Donation_Amount__c: {
        fieldType: 'currency',
        generator: 'range',
        params: { min: 5, max: 50000, currency: 'EUR' },
        examples: ['25.00', '150.00', '5000.00'],
      },
      Campaign_Name__c: {
        fieldType: 'string',
        generator: 'ai_generate',
        params: { prompt: 'Charity campaign name, inspiring and concise' },
        examples: ['Solidarité Hiver 2026', 'Course pour la Vie', 'Un Toit Pour Tous'],
      },
      Volunteer_Status__c: {
        fieldType: 'picklist',
        generator: 'random_pick',
        params: { values: ['Actif', 'Inactif', 'En formation', 'Suspendu'] },
        examples: ['Actif', 'En formation', 'Inactif'],
      },
      Hours_Volunteered__c: {
        fieldType: 'number',
        generator: 'range',
        params: { min: 1, max: 200 },
        examples: ['8', '40', '120'],
      },
      Tax_Receipt__c: {
        fieldType: 'boolean',
        generator: 'weighted_pick',
        params: { values: { true: 0.8, false: 0.2 } },
        examples: ['true', 'false', 'true'],
      },
    },
  },
];

/**
 * Manages AI personas that define industry-specific data generation patterns.
 * Provides built-in personas for common industries and allows creating
 * custom personas via AI.
 */
export class AIPersonaManager {
  private readonly customPersonas: Map<string, AIPersona> = new Map();
  private customCounter = 0;

  /**
   * Get all built-in personas.
   * @returns Array of 10 predefined personas
   */
  getBuiltInPersonas(): AIPersona[] {
    return [...BUILT_IN_PERSONAS];
  }

  /**
   * Get a persona by its ID (built-in or custom).
   * @param id - The persona identifier
   * @returns The persona or undefined if not found
   */
  getPersona(id: string): AIPersona | undefined {
    const builtIn = BUILT_IN_PERSONAS.find((p) => p.id === id);
    if (builtIn) return builtIn;
    return this.customPersonas.get(id);
  }

  /**
   * Create a custom persona from a text description using AI.
   * The AI generates field patterns based on the industry description.
   * @param description - Free-text description of the desired persona
   * @param provider - AI provider function to generate field patterns
   * @returns The newly created persona
   */
  async createCustomPersona(description: string, provider: AIProvider): Promise<AIPersona> {
    const prompt = buildCustomPersonaPrompt(description);
    const raw = await provider(prompt);
    const parsed = parsePersonaResponse(raw);

    this.customCounter += 1;
    const id = `custom-${Date.now()}-${this.customCounter}`;

    const persona: AIPersona = {
      id,
      name: parsed.name,
      description: parsed.description,
      industry: parsed.industry,
      locale: parsed.locale,
      dataPatterns: parsed.dataPatterns,
    };

    this.customPersonas.set(id, persona);
    return persona;
  }

  /**
   * Get all custom personas.
   * @returns Array of user-created personas
   */
  getCustomPersonas(): AIPersona[] {
    return Array.from(this.customPersonas.values());
  }
}

/** A number, or a numeric string as a model often writes one. */
const numericParam = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length > 0 ? Number(value) : value),
  z.number().finite(),
);
const optionalNumber = numericParam.optional().catch(undefined);
const optionalText = z.string().min(1).optional().catch(undefined);

/**
 * The params each generator reads, as Zod schemas. A pattern whose params do
 * not fit is dropped; keys no generator reads are stripped. The model used to
 * be shown `"params": { "...": "..." }`, so it guessed the keys, and whatever it
 * wrote was stored as is: an unknown faker method stopped the run, an unknown
 * generator became a faker rule with no method.
 */
const PERSONA_PARAM_SCHEMAS = {
  faker: z.object({
    method: z.string().transform((method, ctx) => {
      const resolved = resolveFakerMethod(method);
      if (!resolved) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown faker method ${method}` });
        return z.NEVER;
      }
      return resolved;
    }),
    locale: optionalText,
  }),
  random_pick: z.object({
    values: z.array(z.union([z.string(), z.number(), z.boolean()]).transform(String)).min(1),
  }),
  weighted_pick: z.object({
    values: z.record(numericParam).refine((values) => Object.keys(values).length > 0),
  }),
  range: z.object({ min: optionalNumber, max: optionalNumber, currency: optionalText }),
  sequence: z.object({
    prefix: optionalText,
    start: optionalNumber,
    step: optionalNumber,
    padLength: optionalNumber,
  }),
  pattern: z.object({ pattern: z.string().min(1) }),
  ai_generate: z.object({ prompt: z.string().min(1) }),
  relative_date: z.object({ minDaysFromNow: optionalNumber, maxDaysFromNow: optionalNumber }),
} as const;

/** How the prompt describes the params of each generator. */
const PERSONA_PARAM_DESCRIPTIONS: Record<keyof typeof PERSONA_PARAM_SCHEMAS, string> = {
  faker: '{ "method": one of the faker methods below, "locale" (optional): e.g. "fr_FR" }',
  random_pick: '{ "values": ["value1", "value2"] }',
  weighted_pick: '{ "values": { "value1": 0.7, "value2": 0.3 } }',
  range: '{ "min": number, "max": number, "currency" (optional): e.g. "EUR" }',
  sequence: '{ "prefix": "INV-", "start" (optional): integer, "step" (optional): integer }',
  pattern: '{ "pattern": a mask where # stands for a digit, e.g. "FR-#####" }',
  ai_generate: '{ "prompt": what to write in the field }, only on string and textarea fields',
  relative_date: '{ "minDaysFromNow": integer, "maxDaysFromNow": integer, negative for the past }',
};

/**
 * Build the AI prompt for generating a custom persona from a description.
 */
function buildCustomPersonaPrompt(description: string): string {
  const generators = Object.keys(PERSONA_PARAM_SCHEMAS) as Array<
    keyof typeof PERSONA_PARAM_SCHEMAS
  >;
  const lines = [
    'You are a data generation expert. Based on the following description, create a data generation persona for Salesforce.',
    '',
    `Description: ${description}`,
    '',
    'Respond with ONLY a JSON object in this exact format (no markdown, no extra text):',
    '{',
    '  "name": "Persona name",',
    '  "description": "Brief description",',
    '  "industry": "Industry name",',
    '  "locale": "locale code (e.g. en-US, fr-FR)",',
    '  "dataPatterns": {',
    '    "FieldApiName": {',
    '      "fieldType": "string|number|picklist|currency|date|boolean|textarea",',
    `      "generator": "${generators.join('|')}",`,
    '      "params": the params of that generator, listed below,',
    '      "examples": ["example1", "example2", "example3"]',
    '    }',
    '  }',
    '}',
    '',
    'Params of each generator:',
    ...generators.map((generator) => `- ${generator}: ${PERSONA_PARAM_DESCRIPTIONS[generator]}`),
    '',
    `Faker methods: ${SUPPORTED_FAKER_METHODS.join(', ')}.`,
    'A pattern that uses another generator, another faker method or other params is discarded.',
    '',
    'Include at least 5 relevant field patterns for the described industry.',
  ];

  return lines.join('\n');
}

/** The pattern with its params normalised, or null when Seed cannot generate it. */
function normalisePattern(raw: Record<string, unknown>): PersonaFieldPattern | null {
  const generator = raw['generator'];
  if (typeof generator !== 'string' || !Object.hasOwn(PERSONA_PARAM_SCHEMAS, generator)) {
    return null;
  }
  const schema = PERSONA_PARAM_SCHEMAS[generator as keyof typeof PERSONA_PARAM_SCHEMAS];
  const params = schema.safeParse(raw['params'] ?? {});
  if (!params.success) {
    return null;
  }
  const fieldType = typeof raw['fieldType'] === 'string' ? raw['fieldType'] : 'string';
  // AI generation writes text, and a sentence in a date or number field fails the insert.
  if (generator === 'ai_generate' && !acceptsGeneratedSentence(fieldType)) {
    return null;
  }
  return {
    fieldType,
    generator,
    params: params.data as Record<string, unknown>,
    examples: Array.isArray(raw['examples'])
      ? (raw['examples'] as unknown[]).filter((e): e is string => typeof e === 'string')
      : [],
  };
}

/**
 * Parse the AI response into a partial AIPersona structure.
 * Handles responses wrapped in markdown code blocks.
 */
function parsePersonaResponse(response: string): Omit<AIPersona, 'id'> {
  let reply: z.output<typeof PersonaReplySchema>;
  try {
    reply = parseModelJson(PersonaReplySchema, response);
  } catch {
    throw new Error(
      'AI response is not a valid JSON object. The AI model returned an unexpected format — try again or check the AI provider configuration.',
    );
  }

  const dataPatterns: Record<string, PersonaFieldPattern> = {};
  for (const [key, value] of Object.entries(reply.dataPatterns)) {
    if (typeof value === 'object' && value !== null) {
      const pattern = normalisePattern(value as Record<string, unknown>);
      if (pattern) {
        dataPatterns[key] = pattern;
      }
    }
  }

  const { name, description, industry, locale } = reply;
  return { name, description, industry, locale, dataPatterns };
}
