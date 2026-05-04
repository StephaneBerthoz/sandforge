/** Result of executing an Apex anonymous script */
export interface ScriptResult {
  success: boolean;
  output: string;
  errors: string[];
}

/** Function to execute anonymous Apex in a Salesforce org */
export type ExecuteAnonymousFn = (
  orgId: string,
  script: string,
) => Promise<{
  compiled: boolean;
  success: boolean;
  compileProblem?: string;
  exceptionMessage?: string;
  logs?: string;
}>;

/** Dependencies required by MigrationScript */
export interface MigrationScriptDeps {
  executeAnonymous: ExecuteAnonymousFn;
}

/**
 * Executes pre/post migration Apex anonymous scripts in a Salesforce org.
 * Wraps the Tooling API executeAnonymous call with structured results
 * including compilation errors, runtime exceptions, and debug logs.
 */
export class MigrationScript {
  private readonly deps: MigrationScriptDeps;

  constructor(deps: MigrationScriptDeps) {
    this.deps = deps;
  }

  /**
   * Execute an Apex anonymous script in the specified org.
   * Returns a structured ScriptResult with success status, output, and errors.
   */
  async execute(script: string, orgId: string): Promise<ScriptResult> {
    const trimmedScript = script.trim();
    if (trimmedScript.length === 0) {
      return { success: true, output: '', errors: [] };
    }

    const response = await this.deps.executeAnonymous(orgId, trimmedScript);

    const errors: string[] = [];

    if (!response.compiled && response.compileProblem) {
      errors.push(`Compilation error: ${response.compileProblem}`);
    }

    if (response.compiled && !response.success && response.exceptionMessage) {
      errors.push(`Runtime exception: ${response.exceptionMessage}`);
    }

    return {
      success: response.compiled && response.success,
      output: response.logs ?? '',
      errors,
    };
  }
}
