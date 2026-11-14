import { describe, expect, it } from 'vitest';
import { SfSessionError, sfDisplayFailure, sfIsMissing } from './sfFailure.js';

/** What `execFileSync` throws when `sf` ran and failed: its streams, as sf wrote them. */
function sfFailed(stdout: string, stderr = ''): Error {
  return Object.assign(new Error('Command failed: sf org display --target-org DEV --json'), {
    status: 1,
    stdout,
    stderr,
  });
}

/** What `execFileSync` throws when there is no `sf` to start. */
function noSf(): Error {
  return Object.assign(new Error('spawnSync sf ENOENT'), {
    code: 'ENOENT',
    syscall: 'spawnSync sf',
    path: 'sf',
  });
}

describe('what sf said when it could not show an org', () => {
  it('names the alias sf does not know, where the orgs it knows are listed and how to add it', () => {
    const refusal = sfDisplayFailure(
      'DEV',
      sfFailed(
        JSON.stringify({
          status: 1,
          name: 'NamedOrgNotFoundError',
          message: 'No authorization information found for DEV.',
          exitCode: 1,
        }),
      ),
    );

    expect(refusal).toBeInstanceOf(SfSessionError);
    // What a command that prints a fault's stack prints of it: its words alone.
    expect(refusal.stack).toBe(refusal.message);
    expect(refusal.message).toBe(
      'sf does not know DEV: "sf org list" names the orgs it knows; "sf org login web --alias ' +
        'DEV" adds it (in a CI job, "sf org login jwt" or "sf org login sfdxurl"). Nothing was ' +
        'read from DEV.',
    );
    expect(refusal.message).not.toMatch(/Command failed/);
  });

  it('reads the document past a warning and colours sf printed before it, or on stderr', () => {
    const document = JSON.stringify({
      status: 1,
      name: 'NamedOrgNotFoundError',
      message: 'No authorization information found for DEV.',
    });
    const warned = sfDisplayFailure(
      'DEV',
      sfFailed(`\u001b[33mWarning: a newer version of sf is out\u001b[39m\n${document}`),
    );
    const onStderr = sfDisplayFailure('DEV', sfFailed('', document));

    expect(warned.reason).toMatch(/^sf does not know DEV:/);
    expect(onStderr.reason).toMatch(/^sf does not know DEV:/);
  });

  it("says any other failure in sf's own words, and Node's only when sf said nothing", () => {
    expect(
      sfDisplayFailure(
        'DEV',
        sfFailed(
          JSON.stringify({
            status: 1,
            name: 'RefreshTokenAuthError',
            message:
              'Error authenticating with the refresh token due to: expired access/refresh token',
          }),
        ),
      ).message,
    ).toBe(
      'sf could not show DEV: Error authenticating with the refresh token due to: expired ' +
        'access/refresh token Nothing was read from DEV.',
    );
    expect(
      sfDisplayFailure('DEV', sfFailed('', 'Error: the config file is damaged\nat …')).reason,
    ).toBe('sf could not show DEV: Error: the config file is damaged');
    expect(sfDisplayFailure('DEV', sfFailed('', '')).reason).toBe(
      'sf could not show DEV: Command failed: sf org display --target-org DEV --json',
    );
  });

  it('says how to install sf where it is missing, rather than spawnSync sf ENOENT', () => {
    const refusal = sfDisplayFailure('DEV', noSf());

    expect(refusal.message).toBe(
      'Salesforce CLI (sf) not found on PATH. SandForge reads each org through the Salesforce ' +
        'CLI: install it with "npm install -g @salesforce/cli" ' +
        '(https://developer.salesforce.com/tools/salesforcecli), sign in to the org with ' +
        '"sf org login web --alias DEV", and run again. Nothing was read from DEV.',
    );
    expect(refusal.message).not.toMatch(/ENOENT/);
  });

  it('knows sf missing on Windows, where cmd.exe starts and knows no sf, and only there', () => {
    const cmdSaid = Object.assign(new Error('Command failed: sf org display'), {
      status: 1,
      stdout: '',
      stderr:
        "'sf' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
    });
    const exited9009 = Object.assign(new Error('Command failed'), { status: 9009, stderr: '' });

    expect(sfIsMissing(noSf(), 'linux')).toBe(true);
    expect(sfIsMissing(cmdSaid, 'win32')).toBe(true);
    expect(sfIsMissing(exited9009, 'win32')).toBe(true);
    expect(sfIsMissing(cmdSaid, 'linux')).toBe(false);
    expect(sfIsMissing(sfFailed('{}'), 'win32')).toBe(false);
    expect(sfDisplayFailure('DEV', cmdSaid, 'win32').reason).toMatch(
      /^Salesforce CLI \(sf\) not found/,
    );
  });
});
