import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { ForgeBypassAssignment } from '@sandforge/shared';
import { BypassAssistant } from './BypassAssistant';

/** A bypass two permission sets hold, the smallest first, and one none holds. */
const ASSIGNMENTS: ForgeBypassAssignment[] = [
  {
    permission: 'Load_Data',
    permissionSet: { name: 'Data_Load', label: 'Data load', grants: 1 },
    others: [{ name: 'Integration', label: 'Integration', grants: 90 }],
  },
  { permission: 'Skip_Rules', others: [] },
];

const TARGET = { alias: 'DEV-SANDBOX', username: 'loader@example.com.dev' };

describe('BypassAssistant', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('names the smallest permission set that holds a bypass, the others, and the command that assigns it', () => {
    render(<BypassAssistant assignments={ASSIGNMENTS} target={TARGET} />);

    const item = screen.getByTestId('bypass-assistant-Load_Data');
    expect(item.textContent).toContain(
      'Data_Load is the smallest permission set of the target org that holds Load_Data.',
    );
    expect(item.textContent).toContain('Integration holds it too.');
    expect(screen.getByTestId('bypass-assistant-command').textContent).toBe(
      'sf org assign permset --name Data_Load --target-org DEV-SANDBOX --on-behalf-of loader@example.com.dev',
    );
    expect(screen.getByTestId('bypass-assistant').textContent).toContain(
      'SandForge shows this command and never runs it',
    );
  });

  it('says when no permission set holds a bypass: an admin creates one', () => {
    render(<BypassAssistant assignments={ASSIGNMENTS} target={TARGET} />);

    expect(screen.getByTestId('bypass-assistant-Skip_Rules').textContent).toBe(
      'No permission set of the target org holds Skip_Rules: an admin creates one that includes it, and assigns it to the user the run writes as.',
    );
  });

  it('copies the command, runs nothing, and says it was copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<BypassAssistant assignments={ASSIGNMENTS} target={TARGET} />);

    const copy = screen.getByTestId('bypass-assistant-copy');
    expect(copy.getAttribute('aria-label')).toBe('Copy the command that assigns Data_Load');
    fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledWith(
      'sf org assign permset --name Data_Load --target-org DEV-SANDBOX --on-behalf-of loader@example.com.dev',
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Command copied'));
  });

  it('shows no command without the org and the user it names', () => {
    render(<BypassAssistant assignments={ASSIGNMENTS} />);

    expect(screen.getByTestId('bypass-assistant-Load_Data').textContent).toContain('Data_Load');
    expect(screen.queryByTestId('bypass-assistant-command')).toBeNull();
    expect(screen.getByTestId('bypass-assistant').textContent).not.toContain('never runs it');
  });

  it('offers to read the target again once the command has run, and only where a command is shown', () => {
    const onReadAgain = vi.fn();
    const { rerender } = render(
      <BypassAssistant assignments={ASSIGNMENTS} target={TARGET} onReadAgain={onReadAgain} />,
    );

    fireEvent.click(screen.getByTestId('bypass-assistant-read-again'));
    expect(onReadAgain).toHaveBeenCalledTimes(1);

    rerender(<BypassAssistant assignments={ASSIGNMENTS} onReadAgain={onReadAgain} />);
    expect(screen.queryByTestId('bypass-assistant-read-again')).toBeNull();
  });

  it('shows nothing when there is no bypass to assign', () => {
    const { container } = render(<BypassAssistant assignments={[]} target={TARGET} />);
    expect(container.textContent).toBe('');
  });

  it('speaks the panel language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(<BypassAssistant assignments={ASSIGNMENTS} target={TARGET} />);

    expect(screen.getByTestId('bypass-assistant-Load_Data').textContent).toContain(
      "Data_Load est le plus petit ensemble d'autorisations de l'org cible qui détient Load_Data.",
    );
  });
});
