import type { SeedTemplate } from './seed.types.js';

/**
 * A scenario pack: a business scenario written once — what the company does,
 * the subjects its customers write about, the article that answers each, the
 * cases its customers opened and how they were resolved, and what a customer
 * would say to its agent — from which the records, their links, the articles
 * and the agent's tests are all compiled. Nothing is drawn at random but the
 * customers' names, which a seed fixes, so the same pack gives the same data
 * and the same tests every time, with no AI call: an agent's test that failed
 * is run again on the data it failed on.
 *
 * Version 1. A pack is reviewed as code and kept in the workspace as a file,
 * so every bound of it is held by its schema (`scenarioPackSchema`), and a
 * pack out of bounds is refused with the field that is.
 */
export interface ScenarioPack {
  version: 1;
  /** Names the pack, in lower-case words joined by hyphens: the prefix of every key it compiles to. */
  id: string;
  name: string;
  /**
   * The language of its texts, as Salesforce writes one (`en_US`): the
   * language its articles are written in, which the org's Knowledge base has
   * to have, and the one the agent is spoken to in.
   */
  language: string;
  /** What the company does and who its customers are, in two or three sentences. */
  businessContext: string;
  /** The companies that write to it: how many, and their industry. */
  customers: ScenarioCustomers;
  /** The subjects its customers write about, each with its article, cases and utterances. */
  topics: ScenarioTopic[];
  /**
   * An article close to one topic that does not answer it: a test the agent
   * passes by citing the right article, not the nearest.
   */
  decoy: ScenarioDecoyArticle;
  /** What a customer may say that none of the topics covers, which the agent should decline. */
  outOfScope: ScenarioUtterance[];
}

/** The companies of a pack, one account each, with one contact who writes to the company. */
export interface ScenarioCustomers {
  /** How many, unless the run asks for another number: at least one per topic. */
  count: number;
  /** Their industry, as the account's `Industry` picklist holds it. */
  industry: string;
}

/** A subject customers write about. */
export interface ScenarioTopic {
  /** Names the topic in its pack, in lower-case words joined by hyphens. */
  key: string;
  label: string;
  /** The Knowledge article that answers it. */
  article: ScenarioArticle;
  /** The cases customers open on it: each case of the topic is written from one of them, in turn. */
  caseTemplates: ScenarioCaseTemplate[];
  /** What a customer says to the agent about it, each said by a customer whose open case is on it. */
  utterances: ScenarioUtterance[];
}

/** A Knowledge article, in plain text. */
export interface ScenarioArticle {
  title: string;
  summary: string;
  /** Plain text in paragraphs, which the agent answers from. */
  body: string;
  /**
   * What an answer drawn from the article has to say, each stated by the body
   * word for word: a fact the body does not state is one no agent can cite.
   */
  facts: string[];
}

/** The article close to a topic that does not answer it. */
export interface ScenarioDecoyArticle {
  title: string;
  summary: string;
  body: string;
  /** The topic it looks like, by its key. */
  resembles: string;
}

/**
 * A case customers open on a topic. Its texts can name the customer with
 * the placeholders `SCENARIO_PLACEHOLDERS` lists, filled with the
 * customer's own when the case is written.
 */
export interface ScenarioCaseTemplate {
  subject: string;
  description: string;
  /** One of the values a new org's `Case.Priority` has. */
  priority: 'High' | 'Medium' | 'Low';
  /** One of the values a new org's `Case.Origin` has. */
  origin: 'Phone' | 'Email' | 'Web';
  /** What the customer writes again while the case is open: the comment of an open case. */
  followUp: string;
  /** How the case was resolved, step by step: the comments of a closed case, one a step. */
  resolution: string[];
}

/**
 * What a customer says to the agent, and what the agent should do, in plain
 * words. Said on a topic, its texts can name the customer and the subject of
 * the open case the utterance is said about.
 */
export interface ScenarioUtterance {
  text: string;
  expectedOutcome: string;
}

/**
 * How a pack is compiled: the run's own choices, none of which the pack
 * makes. Each has a default (`SCENARIO_COMPILE_DEFAULTS`).
 */
export interface ScenarioCompileOptions {
  /**
   * Draws the customers' names, companies and addresses. The same seed gives
   * the same names; another gives other names and the same records, keys and
   * links. It is part of the articles' URL names, so that two runs with two
   * seeds can both be in one org.
   */
  seed?: number;
  /** How many customers, in place of the pack's: at least one per topic. */
  customers?: number;
  /** The closed cases each customer has, beside its open one: its history. */
  historyPerCustomer?: number;
  /** The `Case.Status` values an open case and a closed one are written with: the org's own. */
  caseStatus?: { open: string; closed: string };
  /**
   * The field of `Knowledge__kav` an article's body is written to, the org's
   * own; absent, no body is written, and the summary is all the article says.
   */
  articleBodyField?: string;
}

/** A pack compiled: the seed template that writes it, and the tests its utterances make. */
export interface CompiledScenario {
  packId: string;
  /** The seed it was compiled with. */
  seed: number;
  /** Rows of their own for every object, children placed under their parent rows by key. */
  template: SeedTemplate;
  /** One per utterance of the pack, in the pack's order, the out-of-scope ones last. */
  tests: ScenarioTestCase[];
  /**
   * Each closed case, by its row key, and the article of its topic, by its
   * row's: what a case is linked to once both are written, the history an
   * agent reads of how such a case was resolved.
   */
  closedCaseArticles: Array<{ caseKey: string; articleKey: string }>;
}

/**
 * What an agent is asked and should do, with the records it is asked about
 * by their row keys: what a test file is written from, once the run has
 * given each row an id and the topics have been matched to the agent's.
 */
export interface ScenarioTestCase {
  /** Names the test among its pack's. */
  key: string;
  /** The topic it is on, by its key; null for an utterance none of the topics covers. */
  topicKey: string | null;
  utterance: string;
  expectedOutcome: string;
  /** The article that answers it: its row's key, its title and what the answer has to say. */
  article?: { key: string; title: string; facts: string[] };
  /** The open case it is said about, and who opened it. */
  openCase?: {
    caseKey: string;
    contactKey: string;
    subject: string;
    contactEmail: string;
  };
}
