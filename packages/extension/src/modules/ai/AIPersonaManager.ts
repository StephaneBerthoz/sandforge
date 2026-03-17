/** Function signature for calling an AI model. */
export type AIProvider = (prompt: string) => Promise<string>;

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
    description: 'Compagnie d\'assurance française avec contrats, sinistres et assurés.',
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
        params: { values: ['Blue Cross', 'Aetna', 'UnitedHealth', 'Cigna', 'Medicare', 'Medicaid'] },
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
        examples: ['Ergonomic Steel Chair', 'Wireless Bluetooth Headphones', 'Organic Cotton T-Shirt'],
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
        params: { values: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Returned', 'Cancelled'] },
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
        examples: ['Great product, fast shipping!', 'Good quality but runs small.', 'Exactly as described.'],
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
        examples: ['FR7630006000011234567890189', 'DE89370400440532013000', 'ES9121000418450200051332'],
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
        params: { values: ['Appartement', 'Maison', 'Studio', 'Loft', 'Terrain', 'Local commercial'] },
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
        params: { values: ['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Toulouse', 'Nantes', 'Lille'] },
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
        params: { values: ['Mathématiques', 'Physique', 'Histoire', 'Anglais', 'Informatique', 'Philosophie'] },
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
        params: { values: ['En préparation', 'Expédié', 'En transit', 'En livraison', 'Livré', 'Retourné'] },
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
        params: { values: ['Paris-Nord', 'Lyon-Est', 'Marseille-Port', 'Bordeaux-Sud', 'Lille-Centre'] },
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
        params: { values: ['Congés payés', 'RTT', 'Maladie', 'Sans solde', 'Maternité', 'Formation'] },
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
   * Apply a persona to a specific field, returning the matching pattern if one exists.
   * Matches by exact field name (case-insensitive key lookup).
   * @param persona - The persona to apply
   * @param _objectName - The Salesforce object API name (reserved for future per-object patterns)
   * @param fieldName - The field API name to match
   * @returns The matching field pattern or undefined
   */
  applyPersona(persona: AIPersona, _objectName: string, fieldName: string): PersonaFieldPattern | undefined {
    return persona.dataPatterns[fieldName];
  }

  /**
   * Get all custom personas.
   * @returns Array of user-created personas
   */
  getCustomPersonas(): AIPersona[] {
    return Array.from(this.customPersonas.values());
  }
}

/**
 * Build the AI prompt for generating a custom persona from a description.
 */
function buildCustomPersonaPrompt(description: string): string {
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
    '      "generator": "faker|random_pick|sequence|range|ai_generate|pattern|weighted_pick",',
    '      "params": { "...": "..." },',
    '      "examples": ["example1", "example2", "example3"]',
    '    }',
    '  }',
    '}',
    '',
    'Include at least 5 relevant field patterns for the described industry.',
  ];

  return lines.join('\n');
}

/**
 * Parse the AI response into a partial AIPersona structure.
 * Handles responses wrapped in markdown code blocks.
 */
function parsePersonaResponse(
  response: string,
): Omit<AIPersona, 'id'> {
  const trimmed = response.trim();
  const jsonContent = extractJsonFromMarkdown(trimmed);
  const parsed: unknown = JSON.parse(jsonContent);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI response is not a valid JSON object. The AI model returned an unexpected format — try again or check the AI provider configuration.');
  }

  const obj = parsed as Record<string, unknown>;
  const name = typeof obj['name'] === 'string' ? obj['name'] : 'Custom Persona';
  const description = typeof obj['description'] === 'string' ? obj['description'] : '';
  const industry = typeof obj['industry'] === 'string' ? obj['industry'] : 'General';
  const locale = typeof obj['locale'] === 'string' ? obj['locale'] : 'en-US';

  const dataPatterns: Record<string, PersonaFieldPattern> = {};
  if (typeof obj['dataPatterns'] === 'object' && obj['dataPatterns'] !== null) {
    const rawPatterns = obj['dataPatterns'] as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawPatterns)) {
      if (typeof value === 'object' && value !== null) {
        const p = value as Record<string, unknown>;
        dataPatterns[key] = {
          fieldType: typeof p['fieldType'] === 'string' ? p['fieldType'] : 'string',
          generator: typeof p['generator'] === 'string' ? p['generator'] : 'faker',
          params: typeof p['params'] === 'object' && p['params'] !== null
            ? p['params'] as Record<string, unknown>
            : undefined,
          examples: Array.isArray(p['examples'])
            ? (p['examples'] as unknown[]).filter((e): e is string => typeof e === 'string')
            : [],
        };
      }
    }
  }

  return { name, description, industry, locale, dataPatterns };
}

/**
 * Extract JSON content from a string that may be wrapped in markdown code blocks.
 */
function extractJsonFromMarkdown(text: string): string {
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return text;
}
