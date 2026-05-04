/** Valid CLI command names */
export type CliCommandName =
  | 'seed'
  | 'sync'
  | 'compare'
  | 'backup'
  | 'pipeline'
  | 'anonymize'
  | 'health'
  | 'grappe';

/** Parsed CLI command structure */
export interface CliCommand {
  /** Primary command name */
  command: string;
  /** Secondary command (e.g., 'run' for pipeline, 'status' for grappe) */
  subCommand?: string;
  /** Key-value options extracted from --key value pairs */
  options: Record<string, string>;
  /** Boolean flags extracted from --flag-name (no value) */
  flags: string[];
}

/** Result of validating a parsed CLI command */
export interface ValidationResult {
  /** Whether the command is valid */
  valid: boolean;
  /** List of validation error messages */
  errors: string[];
}

/** All valid command names */
const VALID_COMMANDS: ReadonlySet<string> = new Set<string>([
  'seed',
  'sync',
  'compare',
  'backup',
  'pipeline',
  'anonymize',
  'health',
  'grappe',
]);

/** Commands that accept sub-commands */
const SUBCOMMAND_COMMANDS: ReadonlySet<string> = new Set<string>(['pipeline', 'grappe']);

/** Known boolean flags that never take a value */
const KNOWN_FLAGS: ReadonlySet<string> = new Set<string>([
  'dry-run',
  'verbose',
  'help',
  'version',
  'quiet',
  'force',
  'no-color',
]);

/** Required options per command, validated by `validate()` */
const REQUIRED_OPTIONS: Readonly<Record<string, { options: string[]; subCommand?: string }>> = {
  seed: { options: ['template', 'org'] },
  sync: { options: ['config'] },
  compare: { options: ['source', 'target'] },
  backup: { options: ['org'] },
  pipeline: { options: ['config'], subCommand: 'run' },
  anonymize: { options: ['org', 'template'] },
  health: { options: ['org'] },
  grappe: { options: ['operation-id'], subCommand: 'status' },
};

/** Valid output format values */
const VALID_FORMATS: ReadonlySet<string> = new Set<string>(['json', 'table', 'csv', 'html']);

/**
 * Parses raw CLI argument arrays into structured {@link CliCommand} objects
 * and validates them against per-command requirements.
 */
export class CliParser {
  /**
   * Parse a raw argument array into a structured CLI command.
   *
   * @param args - Raw CLI arguments (without the binary name)
   * @returns Parsed command structure
   * @throws Error if no arguments are provided
   */
  parse(args: string[]): CliCommand {
    if (args.length === 0) {
      throw new Error(
        'No arguments provided. Usage: sandforge <command> [options]. Run "sandforge --help" for available commands.',
      );
    }

    const command = args[0];
    const options: Record<string, string> = {};
    const flags: string[] = [];
    let subCommand: string | undefined;

    let argIndex = 1;

    // Check for sub-command: the next positional arg (if it exists and is not a flag)
    if (
      SUBCOMMAND_COMMANDS.has(command) &&
      argIndex < args.length &&
      !args[argIndex].startsWith('--')
    ) {
      subCommand = args[argIndex];
      argIndex++;
    }

    // Parse remaining args as options and flags
    while (argIndex < args.length) {
      const arg = args[argIndex];

      if (arg.startsWith('--')) {
        const key = arg.slice(2);

        if (KNOWN_FLAGS.has(key)) {
          flags.push(key);
          argIndex++;
          continue;
        }

        // Check if next arg exists and is not another flag
        if (argIndex + 1 < args.length && !args[argIndex + 1].startsWith('--')) {
          options[key] = args[argIndex + 1];
          argIndex += 2;
        } else {
          // Treat as a flag if no value follows
          flags.push(key);
          argIndex++;
        }
      } else {
        // Positional argument after the command/sub-command — skip
        argIndex++;
      }
    }

    const result: CliCommand = {
      command,
      options,
      flags,
    };

    if (subCommand !== undefined) {
      result.subCommand = subCommand;
    }

    return result;
  }

  /**
   * Validate a parsed command against the requirements for that command type.
   *
   * @param command - The parsed CLI command to validate
   * @returns Validation result with error messages if invalid
   */
  validate(command: CliCommand): ValidationResult {
    const errors: string[] = [];

    // Check help flag — always valid
    if (command.flags.includes('help')) {
      return { valid: true, errors: [] };
    }

    // Check that the command is known
    if (!VALID_COMMANDS.has(command.command)) {
      errors.push(`Unknown command: '${command.command}'`);
      return { valid: false, errors };
    }

    const requirements = REQUIRED_OPTIONS[command.command];
    if (!requirements) {
      return { valid: true, errors: [] };
    }

    // Check required sub-command
    if (requirements.subCommand) {
      if (!command.subCommand) {
        errors.push(
          `Command '${command.command}' requires sub-command '${requirements.subCommand}'`,
        );
      } else if (command.subCommand !== requirements.subCommand) {
        errors.push(
          `Unknown sub-command '${command.subCommand}' for '${command.command}'. Expected '${requirements.subCommand}'`,
        );
      }
    }

    // Check required options
    for (const opt of requirements.options) {
      if (!(opt in command.options)) {
        errors.push(`Missing required option '--${opt}' for command '${command.command}'`);
      }
    }

    // Validate --format if present
    if ('format' in command.options) {
      if (!VALID_FORMATS.has(command.options['format'])) {
        errors.push(
          `Invalid format '${command.options['format']}'. Valid formats: ${[...VALID_FORMATS].join(', ')}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check whether a given string is a valid command name.
   *
   * @param name - The command name to check
   * @returns true if the name is a recognised command
   */
  isValidCommand(name: string): boolean {
    return VALID_COMMANDS.has(name);
  }

  /**
   * Return the list of all valid command names.
   *
   * @returns Array of valid command name strings
   */
  getValidCommands(): string[] {
    return [...VALID_COMMANDS];
  }
}
