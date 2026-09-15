/**
 * Attacks thrown at the AI Assistant rules of `product-claims.test.mjs`, kept
 * so every run replays them.
 *
 * Three kinds: code that hands the model tools again, promises a translator or
 * a writer would plausibly ship, and honest sentences the rules must keep
 * accepting. Replaying an attack by mutating the tree needs a clean tree and a
 * minute per attack; here each attack is the piece of source or the sentence
 * alone, and the gate's own scan and match read it in memory.
 *
 * Held once rather than as recorded: a sentence tried under two locale keys —
 * the `tools` label and a neutral one — since the match reads the text and not
 * the key, and an attack made of two independent edits, held as its two halves.
 * The CDC, Grappe, Production Guard and automatic error resolution rules keep
 * their attacks in their own fixture tests, not here.
 *
 * A verdict is what the gate does, not what it should do:
 *  - code: `found` — the scan reports it; `unseen` — it does not;
 *  - prose: `refused` — a mined wording matches; `passes` — none does.
 * Every `unseen` or `passes` on an attack that sells or wires tools is a limit
 * the gate declares in its header, and its `why` names that limit. An attack
 * whose verdict changes fails the replay, whichever way it moves.
 *
 * Not replayed here, because a single piece of source cannot show them: the
 * attacks on import coverage — a tool loop in a `fixtures/`, `__mocks__/` or
 * `__tests__/` directory imported by shipped code, the composition root
 * renamed, and `composition/` added to the directories the gate skips, which
 * edits the gate itself. The coverage control reads those on the real tree
 * every run.
 *
 * Not a test file: it holds no `test()` call.
 */

const TOOL =
  "{ name: 'query_records', description: 'Run a SOQL query', input_schema: { type: 'object', properties: {} } }";

const ORG_TOOLS = [
  'export const ORG_TOOLS = [',
  `  ${TOOL},`,
  "  { name: 'describe_object', description: 'Describe an sObject', input_schema: { type: 'object', properties: {} } },",
  '];',
].join('\n');

const lines = (...l) => l.join('\n');

/**
 * Code, as `{ source, shape?, root?, verdict, why }`; `shape` defaults to `ts`,
 * `root` — `extension`, `shared`, `webview` or `composition` — to `extension`.
 */
export const CODE_ATTACKS = [
  {
    source: lines(
      'const base = { model, max_tokens: 4096, messages };',
      `const extra = { tools: [${TOOL}] };`,
      'await client.messages.create({ ...base, ...extra });',
    ),
    verdict: 'found',
    why: 'tools in an object built beforehand and spread into the request',
  },
  {
    source: lines(
      'const extra: Record<string, unknown> = {};',
      `extra.tools = [${TOOL}];`,
      'await client.messages.create({ model, max_tokens: 4096, messages, ...extra });',
    ),
    verdict: 'found',
    why: 'tools assigned onto an object after it was built',
  },
  {
    source: lines(
      'class Adapter {',
      '  private request(client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming) {',
      '    return client.messages.create(params);',
      '  }',
      '  async chat() {',
      `    await this.request(client, { model, max_tokens: 1024, messages, tools: [${TOOL}] });`,
      '  }',
      '}',
    ),
    verdict: 'found',
    why: 'tools handed to a helper that makes the request',
  },
  {
    source: lines(
      `const tools: Anthropic.Tool[] = [${TOOL}];`,
      'const stream = client.messages.stream({ model, max_tokens: 4096, messages, tools });',
    ),
    verdict: 'found',
    why: 'tools as a shorthand member of a streaming request',
  },
  {
    source: "await client['messages']['create']({ model, max_tokens: 16, messages, tools: [] });",
    verdict: 'found',
    why: 'tools in a request reached through element access',
  },
  {
    source: lines(
      'const api = client.messages;',
      `await api.create({ model, max_tokens: 1024, messages, tools: [${TOOL}] });`,
    ),
    verdict: 'found',
    why: 'tools in a request made through an alias of the messages API',
  },
  {
    source: lines(
      '// Second turn: lets the model look records up before it answers.',
      'export function followUp(client, model, messages) {',
      `  return client.messages.create({ model, max_tokens: 1024, messages, tools: [${TOOL}] });`,
      '}',
    ),
    shape: 'js',
    verdict: 'found',
    why: 'tools in plain JavaScript beside the TypeScript sources',
  },
  {
    source: lines(
      '/** Runs the model until it stops asking for a tool. */',
      'export async function runToolLoop(step: () => Promise<boolean>): Promise<number> {',
      '  let turns = 0;',
      '  while (await step()) turns++;',
      '  return turns;',
      '}',
      'export const warmUp = (): Promise<number> => runToolLoop(async () => false);',
    ),
    verdict: 'unseen',
    why: 'declared limit: a tool factory whose name carries on past the word, like createToolRegistry, is not caught by name',
  },
  {
    source: lines(
      "const { BetaToolRunner } = await import('@anthropic-ai/sdk/lib/tools/BetaToolRunner.js');",
      'await new BetaToolRunner(client, { model, max_tokens: 1024, messages }).runUntilDone();',
    ),
    verdict: 'found',
    why: 'the SDK tool runner, imported lazily from its sub-path',
  },
  {
    source: lines(
      "const { mcpTools } = await import('@anthropic-ai/sdk/helpers/beta/mcp.js');",
      'const orgTools = mcpTools(listing, mcpClient);',
    ),
    verdict: 'found',
    why: 'the SDK MCP helper',
  },
  {
    source: lines(
      "import { betaTool as defineTool } from '@anthropic-ai/sdk/helpers/beta/json-schema.js';",
      "const lookup = defineTool({ name: 'lookup', description: 'x', inputSchema: { type: 'object' }, run: () => '' });",
    ),
    verdict: 'found',
    why: 'an SDK tool helper imported under another name',
  },
  {
    source: lines(
      "import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod.js';",
      "const lookup = betaZodTool({ name: 'query_records', description: 'Run a SOQL query', inputSchema: {} as never, run: () => '' });",
    ),
    verdict: 'found',
    why: 'the zod tool helper, from a sub-path that also exports structured output',
  },
  {
    source: lines(
      "const calls = resp.content.filter((b): b is Anthropic.ToolUseBlock => 'input' in b);",
      'for (const call of calls) await execute(call);',
    ),
    verdict: 'found',
    why: 'tool calls read through the SDK type name',
  },
  {
    source: lines(
      'for (const block of resp.content) {',
      "  if (['end_turn', 'tool_use'].includes(block.type)) await execute(block);",
      '}',
    ),
    verdict: 'found',
    why: "tool calls read through the 'tool_use' literal",
  },
  {
    source: lines('switch (resp.stop_reason) {', "  case 'tool_use':", '    break;', '}'),
    verdict: 'found',
    why: "a branch on the 'tool_use' stop reason",
  },
  {
    source: lines(
      'class ToolRequest {',
      `  tools = [${TOOL}];`,
      '}',
      'const extra = { ...new ToolRequest() };',
    ),
    verdict: 'found',
    why: 'tools as an initialised class field',
  },
  {
    source: lines('const req: Record<string, unknown> = { model };', `req['tools'] = [${TOOL}];`),
    verdict: 'found',
    why: 'tools written through element access',
  },
  {
    source: lines(
      'const org = await client.beta.messages.create({',
      '  model,',
      '  max_tokens: 1024,',
      '  messages,',
      "  betas: ['mcp-client-2025-04-04'],",
      "  mcp_servers: [{ type: 'url', url: mcpUrl, name: 'salesforce' }],",
      '});',
    ),
    verdict: 'found',
    why: 'a remote MCP connector, which hands over a tool set without a tools key',
  },
  {
    source: lines(
      "import { query } from '@anthropic-ai/claude-agent-sdk';",
      'for await (const step of query({',
      '  prompt,',
      "  options: { allowedTools: ['mcp__salesforce__soql_query'], permissionMode: 'bypassPermissions' },",
      '})) {',
      '  void step;',
      '}',
    ),
    verdict: 'found',
    why: 'the Agent SDK, a second package from the same publisher',
  },
  {
    source: lines(
      "import * as vscode from 'vscode';",
      'export class OrgLookupTool implements vscode.LanguageModelTool<{ soql: string }> {',
      '  async invoke(options: vscode.LanguageModelToolInvocationOptions<{ soql: string }>) {',
      '    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(options.input.soql)]);',
      '  }',
      '}',
      'export const lookupOrg = (soql: string, token: vscode.CancellationToken) =>',
      "  vscode.lm.invokeTool('sandforge_org_lookup', { input: { soql }, toolInvocationToken: undefined }, token);",
    ),
    verdict: 'found',
    why: "a tool written to the editor's own model API",
  },
  {
    source: lines(
      "import * as vscode from 'vscode';",
      'const register = vscode.lm.registerTool.bind(vscode.lm);',
      "export const registration = register('sandforge_org_lookup', tool);",
    ),
    verdict: 'found',
    why: "the editor's tool API reached through a bound alias",
  },
  {
    source: lines(
      "import * as vscode from 'vscode';",
      'const { registerTool } = vscode.lm;',
      "export const registration = registerTool('sandforge_org_lookup', tool);",
    ),
    verdict: 'found',
    why: "the editor's tool API destructured off the namespace",
  },
  {
    source: lines(
      "import * as vscode from 'vscode';",
      "export const models = () => vscode.lm.selectChatModels({ vendor: 'copilot' });",
    ),
    verdict: 'unseen',
    why: "a chat model picked through the editor's model API, with no tool in reach",
  },
  {
    source: lines(
      "const extra = Object.fromEntries([['tools', ORG_TOOLS]]);",
      'await client.messages.create({ model, max_tokens: 1024, messages, ...extra });',
      ORG_TOOLS,
    ),
    verdict: 'unseen',
    why: 'declared limit: a key computed at runtime hides tools from the scan',
  },
  {
    source: lines(
      'await client.messages.create({',
      '  model,',
      '  max_tokens: 4096,',
      '  messages,',
      '  ...((opts as { providerOptions?: Record<string, unknown> }).providerOptions ?? {}),',
      '});',
    ),
    verdict: 'unseen',
    why: 'declared limit: provider options handed through from outside the code carry a tools key written nowhere in the repository',
  },
  {
    source: lines(
      'const resp = await client.messages.create({',
      '  model,',
      '  max_tokens: 4096,',
      '  system: `Available read-only lookups: ${JSON.stringify(ORG_TOOLS)}. Reply CALL <name> <json> to use one.`,',
      '  messages,',
      '});',
      'const call = /^CALL (\\w+) (.*)$/m.exec(text);',
      'if (call) await runOrgLookup(call[1], call[2]);',
      ORG_TOOLS,
    ),
    verdict: 'unseen',
    why: 'declared limit: a tool catalogue written into the prompt, whose reply is parsed by hand',
  },
  {
    source: lines(
      "if (resp.stop_reason !== 'end_turn') await continueWithTools(client, opts);",
      'async function continueWithTools(client: Anthropic, opts: AIChatOpts) {',
      '  await client.beta.messages.create({',
      '    model,',
      '    max_tokens: 1024,',
      '    messages: opts.messages,',
      "    mcp_servers: [{ type: 'url', url: mcpUrl, name: 'salesforce' }],",
      '  });',
      '}',
    ),
    verdict: 'found',
    why: 'a second turn driven by the stop reason, through a verb of the tool family',
  },
  {
    source: lines(ORG_TOOLS, 'await dispatchTools(ORG_TOOLS);'),
    verdict: 'found',
    why: 'a verb of the tool family outside the first seven the scan listed',
  },
  {
    source: lines(ORG_TOOLS, 'export const KNOWN_LOOKUPS = ORG_TOOLS.length;'),
    verdict: 'unseen',
    why: 'tool definitions that are never sent: nothing gives the model tools',
  },
  {
    source:
      '{ "tools": [{ "name": "query_records", "description": "Run a SOQL query", "input_schema": { "type": "object", "properties": {} } }] }',
    shape: 'json',
    verdict: 'found',
    why: 'tool definitions in a data file read at run time and spread into a request',
  },
  {
    source: lines(
      '/**',
      ' * Sends no tools. Wiring them back would take `runTools(registry)` and a',
      ' * request shaped like `client.messages.create({ tools: readOnlyTools })`,',
      ' * then a handler for every `tool_use` block in the reply.',
      ' */',
      'export async function chat() {',
      '  // runTools(this.registry); client.messages.stream({ messages, tools: [] })',
      '  return client.messages.create({ model, max_tokens: 4096, messages });',
      '}',
    ),
    verdict: 'unseen',
    why: 'the same words in comments, which are not code',
  },
  {
    source:
      "export const toolFree: { tools?: never; tool_choice?: never } = {};\nexport type StopReasonProbe = 'end_turn' | 'tool_use';",
    verdict: 'unseen',
    why: 'types that name the keys and the block type send nothing',
  },
  {
    source: "logger.debug({ tools: 0, tool_choice: 'none' }, 'chat sent without tools');",
    verdict: 'found',
    why: 'declared false positive: a log field named tools is refused like a request; rename it',
  },
  {
    source: lines(
      'const params = { model, max_tokens: 4096, system, messages };',
      'const resp = await client.messages.create(params);',
    ),
    verdict: 'unseen',
    why: 'a request built in a variable, with no tools in it',
  },
  {
    source: lines(
      "import Anthropic from '@anthropic-ai/sdk';",
      'export type Draft = Anthropic.MessageCreateParams;',
    ),
    root: 'webview',
    verdict: 'found',
    why: 'the panel importing the SDK, to compose a request the extension would send',
  },
  {
    source: lines(
      'export function askWithOrgTools(post: (m: unknown) => void, question: string) {',
      "  post({ type: 'ai:chat', payload: { question, providerOptions: { tools: [] } } });",
      '}',
    ),
    root: 'webview',
    verdict: 'found',
    why: 'the panel putting a tools key into a payload an adapter could spread into its request',
  },
  {
    source: lines(
      "export const sections = [{ id: 'tools', label: 'Tools' }, { id: 'org', label: 'Org' }];",
      "export const isToolsSection = (id: string) => id === 'tools';",
    ),
    root: 'webview',
    verdict: 'unseen',
    why: 'the panel naming its Tools section: a value, not a key',
  },
  {
    source: lines(
      'const chat = services.aiClient().chat.bind(services.aiClient());',
      'const result = await chat({ messages });',
    ),
    root: 'composition',
    verdict: 'found',
    why: 'the composition root taking chat without calling it, so what that route sends is out of sight',
  },
  {
    source: 'await client.beta.messages.toolRunner({ model, max_tokens: 16, messages });',
    verdict: 'found',
    why: 'the SDK tool runner reached as a method of the beta messages API',
  },
  {
    source: lines(
      'const resp = await client.messages.create(',
      `  { model, max_tokens: 4096, system, messages, tools: [${TOOL}] },`,
      '  { signal },',
      ');',
    ),
    verdict: 'found',
    why: 'tools written into the request itself, beside a request option',
  },
  {
    source: lines(
      'class Adapter {',
      '  async chat() {',
      '    this.buildReadOnlyTools();',
      '    return client.messages.create({ model, max_tokens: 4096, messages });',
      '  }',
      '  private buildReadOnlyTools(): unknown[] {',
      '    return [];',
      '  }',
      '}',
    ),
    verdict: 'found',
    why: 'a method named for building tools, called before the request',
  },
  {
    source: lines(
      'export const SHIPPED = buildAllReadOnlyTools();',
      'function buildAllReadOnlyTools(): unknown[] {',
      '  return [];',
      '}',
    ),
    root: 'shared',
    verdict: 'found',
    why: 'a tool factory exported from the shared package',
  },
  {
    source: lines(
      'for (const block of resp.content) {',
      "  if (block.type === 'tool_use') continue;",
      '}',
    ),
    verdict: 'found',
    why: "a comparison with the 'tool_use' block type, even one that skips the block",
  },
  {
    source: lines(
      '// client.messages.create({ tools: [] })',
      "// if (block.type === 'tool_use') { runTools(); }",
      'const resp = await client.messages.create({ model, max_tokens: 4096, messages });',
    ),
    verdict: 'unseen',
    why: 'the same calls in line comments above an honest request',
  },
  {
    source: lines(
      'class Adapter {',
      '  async chat() {',
      `    const params = { tools: [${TOOL}] };`,
      '    return client.messages.create({ model, max_tokens: 4096, messages, ...params });',
      '  }',
      '  async countTokens() {',
      '    const params = { model, messages };',
      '    return client.messages.countTokens(params);',
      '  }',
      '}',
    ),
    verdict: 'found',
    why: 'tools spread from a local whose name a later method declares again',
  },
  {
    source: "export const loadSdk = () => import('@anthropic-ai/sdk');",
    verdict: 'unseen',
    why: 'the lazy SDK import moved into a loader of its own',
  },
  {
    source: lines(
      'const org = await client.beta.messages.create({',
      '  model,',
      '  max_tokens: 1024,',
      '  messages,',
      "  betas: ['mcp-client-2025-04-04'],",
      "  mcp_servers: [{ type: 'url', url: mcpUrl, name: 'salesforce' }],",
      '  tools: [],',
      '});',
    ),
    verdict: 'found',
    why: 'the remote MCP connector with an explicit tools key beside it',
  },
];

/** Prose, as `{ text, verdict, why }`, matched against the mined AI Assistant wordings. */
export const PROSE_ATTACKS = [
  // Honest sentences the rules must keep accepting, in six languages.
  {
    text: 'Unlike SFDMU, SandForge does not ship an agent with ten read-only org tools.',
    verdict: 'passes',
    why: 'a competitor comparison that promises nothing',
  },
  {
    text: 'Diagnostics: Monitor and Compare are two read-only tools for inspecting a failed Sync run.',
    verdict: 'passes',
    why: 'two modules with no write access, and no assistant',
  },
  {
    text: 'Monitor et Compare sont deux outils en lecture seule pour analyser une exécution en échec.',
    verdict: 'passes',
    why: 'the same, in French',
  },
  {
    text: 'Die Diagnose fehlgeschlagener Jobs über zehn schreibgeschützte Werkzeuge wurde in Version 1.20 entfernt.',
    verdict: 'passes',
    why: 'a removal note whose verb follows the noun, in German',
  },
  {
    text: 'El diagnóstico de trabajos fallidos con diez herramientas de solo lectura se eliminó en la versión 1.20.',
    verdict: 'passes',
    why: 'the same removal note, in Spanish',
  },
  {
    text: 'O diagnóstico de jobs com falha usando dez ferramentas somente leitura foi removido na versão 1.20.',
    verdict: 'passes',
    why: 'the same removal note, in Portuguese',
  },
  {
    text: 'AIアシスタントの読み取り専用ツールによる診断は廃止されました',
    verdict: 'passes',
    why: 'a removal said with a verb of abolition, in Japanese',
  },
  {
    text: 'Der KI-Assistent führt zehn schreibgeschützte Werkzeuge nicht mehr aus.',
    verdict: 'passes',
    why: 'a negation placed after the object, in German',
  },
  {
    text: "L'assistant IA ne propose plus le diagnostic des jobs en échec par dix outils en lecture seule.",
    verdict: 'passes',
    why: 'a split negation far from the noun, in French',
  },
  {
    text: 'The assistant can explain a failed job, but it has no read-only tools.',
    verdict: 'passes',
    why: 'a denial',
  },
  {
    text: 'El asistente de IA ya no ejecuta diez herramientas de solo lectura.',
    verdict: 'passes',
    why: 'a denial, in Spanish',
  },
  {
    text: 'Read-only mode prevents writes to production',
    verdict: 'passes',
    why: 'security vocabulary any module may use',
  },
  {
    text: "Diagnostiquer une erreur de connexion à l'org",
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant',
  },
  {
    text: 'In a production org, Production Guard keeps only the read-only\ntools enabled and hides the ones that write.',
    verdict: 'passes',
    why: 'a wrapped paragraph about the guard',
  },
  {
    text: 'Connection error: check the login URL, then diagnose the org from the Organizations page.',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant',
  },

  // Quotations of what shipped: refused on purpose, like the promise.
  {
    text: 'Version 1.20 removed failed-job diagnosis over ten read-only tools from the AI Assistant.',
    verdict: 'refused',
    why: 'declared: any quotation of a published wording is refused; a changelog is where the quote belongs',
  },
  {
    text: 'Enable the AI Assistant: failed-job diagnosis over 10 read-only tools (requires API key in secrets)',
    verdict: 'refused',
    why: 'the published wording, put back into a setting description the gate now reads',
  },

  // Promises nobody published, in new words: they pass, and the header says so.
  {
    text: 'Chat, NL2SOQL, and read-only Salesforce tools that answer questions about your org',
    verdict: 'passes',
    why: 'declared limit: prose refuses published wording, whole; a new sentence passes',
  },
  {
    text: 'Chat, NL2SOQL, and ten read-only Salesforce tools that answer questions about your org',
    verdict: 'passes',
    why: 'declared limit: the same new sentence with a count',
  },
  {
    text: 'The AI Assistant queries your org with {{count}} read-only tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence, with the count interpolated',
  },
  {
    text: 'The assistant answers your questions with ten read-only sandbox tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence',
  },
  {
    text: 'Zehn schreibgeschützte KI-Werkzeuge beantworten Fragen zu Ihrer Org.',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: "L'assistant IA interroge votre org avec dix outils de consultation.",
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'El asistente de IA responde con diez herramientas de consulta.',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'O assistente de IA consulta sua org com dez ferramentas de leitura.',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'AIアシスタントが参照専用ツールでお答えします',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: '### Ten read-only Salesforce tools\n\nThe AI Assistant uses them to explain why a Seed run failed.',
    verdict: 'passes',
    why: 'declared limit: a new sentence split across a heading and a paragraph',
  },
  {
    text: 'Ten read-only actions: it looks up records and explains why a job failed',
    verdict: 'passes',
    why: 'declared limit: a synonym for the tools',
  },
  {
    text: 'The AI Assistant diagnoses failed jobs with ten read-only org tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence, and the diagnosis inflected',
  },
  {
    text: '![The AI Assistant diagnosing a failed job with ten read-only tools](assets/screenshots/home.png)',
    verdict: 'passes',
    why: 'declared limit: a new sentence in image alt text',
  },
  {
    text: 'Análisis de trabajos fallidos con 10 herramientas de solo consulta',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'Diagnose gescheiterter Jobs über zehn Werkzeuge, die nur lesen',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: '| **AI Assistant** | Ask why a run broke: the assistant looks it up with ten read‑only org tools |',
    verdict: 'passes',
    why: 'declared limit: a new sentence in a table row',
  },
  {
    text: 'The assistant looks up why a Seed or Sync run broke with ten read-only\nSalesforce tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence, wrapped',
  },
  {
    text: 'The assistant diagnoses failed jobs with read-only Salesforce tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence',
  },
  {
    text: "L'assistant IA diagnostique les jobs en échec avec des outils en lecture seule",
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'AIアシスタントが読み取り専用ツールで失敗したジョブを診断します',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'Optional AI assistant, powered by Anthropic (Claude): it diagnoses failed jobs with ten read-only tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence on a walkthrough page',
  },
  {
    text: '| **AI Assistant**   | NL2SOQL and failed-job diagnosis over 10 read-only tools |',
    verdict: 'refused',
    why: 'the published README row put back',
  },
  {
    text: '| **AI Assistant**   | Diagnoses failing jobs across 10 read-only Salesforce tools |',
    verdict: 'passes',
    why: 'declared limit: a new sentence in a table row',
  },
  {
    text: 'Diagnostic des jobs en échec via 10 outils en lecture seule',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'ジョブの失敗を10個の読み取り専用ツールで診断します',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'Diagnóstico de tareas con errores mediante diez herramientas que no modifican nada',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'Ursachenanalyse für abgebrochene Jobs mit 10 Werkzeugen ohne Schreibzugriff',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: '| **AI Assistant**   | Answers org questions with ten read-*only* Salesforce tools |',
    verdict: 'passes',
    why: 'declared limit: a new sentence in a table row, with emphasis inside a word',
  },
  {
    text: 'The assistant looks up why a Seed or Sync run broke with ten read-only Salesforce tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence, on one line',
  },
  {
    text: '- **AI Assistant**: looks up records with ten read-only\n  Salesforce tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence in a wrapped list item',
  },
  {
    text: '> The AI Assistant answers with 10 read-only\n> org tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence in a wrapped blockquote',
  },
  {
    text: 'Der KI-Assistent prüft Ihre Org mit zehn schreibgeschützten Werkzeugen',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'El asistente de IA diagnostica trabajos fallidos con herramientas de solo lectura',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'Diagnóstico de jobs com falha usando 10 ferramentas somente leitura',
    verdict: 'passes',
    why: 'declared limit: a translation',
  },
  {
    text: 'The AI Assistant queries your org with 10 read-only tools.',
    verdict: 'passes',
    why: 'declared limit: a new sentence, with a literal count',
  },

  // Honest sentences that name read-only, tools or a diagnosis without the assistant's claim.
  {
    text: 'Monitor and Compare are two read-only tools for inspecting a failed Sync run.',
    verdict: 'passes',
    why: 'two modules with no write access, with no word about AI',
  },
  {
    text: 'Diagnose why an operation failed from the log panel',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant',
  },
  {
    text: 'Read-only orgs hide the write tools',
    verdict: 'passes',
    why: 'security vocabulary any module may use',
  },
  {
    text: 'In a production org, only read-only tools stay enabled.',
    verdict: 'passes',
    why: 'the guard, not the assistant',
  },
  {
    text: 'Monitor and Compare are two read-only tools: they never write to an org.',
    verdict: 'passes',
    why: 'two modules with no write access',
  },
  {
    text: 'Read-only tools in the toolbar stay available while the AI Assistant is off.',
    verdict: 'passes',
    why: 'toolbar tools named beside the assistant, not given to it',
  },
  {
    text: 'The diagnostics panel shows why the last Sync run failed.',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant',
  },
  {
    text: 'While AI is on, every failed Seed run sends its error message to the model for a fix suggestion.',
    verdict: 'passes',
    why: 'the automatic error resolution, said as it is',
  },
  {
    text: 'The AI Assistant does not use read-only tools or diagnose failed jobs.',
    verdict: 'passes',
    why: 'a denial',
  },
  {
    text: "Le mode lecture seule masque les outils d'écriture.",
    verdict: 'passes',
    why: 'security vocabulary, in French',
  },
  {
    text: 'En production, seuls les outils en lecture seule restent actifs.',
    verdict: 'passes',
    why: 'the guard, in French',
  },
  {
    text: 'Le panneau de diagnostic affiche la dernière exécution en échec.',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant, in French',
  },
  {
    text: 'Im schreibgeschützten Modus sind die Schreibwerkzeuge ausgeblendet.',
    verdict: 'passes',
    why: 'security vocabulary, in German',
  },
  {
    text: 'Im Schutzmodus bleiben nur zwei Werkzeuge ohne Schreibzugriff aktiv.',
    verdict: 'passes',
    why: 'the guard, in German',
  },
  {
    text: 'Der KI-Assistent erklärt Fehler, führt aber keine Werkzeuge aus.',
    verdict: 'passes',
    why: 'a denial, in German',
  },
  {
    text: 'El modo de solo lectura oculta las herramientas de escritura.',
    verdict: 'passes',
    why: 'security vocabulary, in Spanish',
  },
  {
    text: 'En producción solo quedan activas las herramientas de solo lectura.',
    verdict: 'passes',
    why: 'the guard, in Spanish',
  },
  {
    text: 'Diagnosticar un error de conexión con la org',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant, in Spanish',
  },
  {
    text: 'O modo somente leitura oculta as ferramentas de escrita.',
    verdict: 'passes',
    why: 'security vocabulary, in Portuguese',
  },
  {
    text: 'O painel de diagnóstico mostra a última execução com falha.',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant, in Portuguese',
  },
  {
    text: '読み取り専用モードでは書き込みツールが非表示になります',
    verdict: 'passes',
    why: 'security vocabulary, in Japanese',
  },
  {
    text: '診断パネルに失敗したジョブの一覧が表示されます',
    verdict: 'passes',
    why: 'a diagnosis that is not the assistant, in Japanese',
  },
  {
    text: '- The AI Assistant is read-only: it never writes to an org.\n- Ten tools in the toolbar are read-only and stay on in production.',
    verdict: 'passes',
    why: 'two list items, one about the assistant and one about the toolbar',
  },
];
