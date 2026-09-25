import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { MotionProvider } from '../../motion/MotionProvider';
import { Wizard } from './Wizard';
import type { WizardStep } from './Wizard';

const steps: WizardStep[] = [
  { id: 'alpha', labelKey: 'seed.selectOrg', descriptionKey: 'seed.selectOrgDesc' },
  { id: 'beta', labelKey: 'seed.selectObjects' },
  { id: 'gamma', labelKey: 'seed.configureFields', descriptionKey: 'seed.configureFieldsDesc' },
];

describe('Wizard', () => {
  it('should render with default testIdPrefix "wizard"', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard')).toBeDefined();
    expect(screen.getByTestId('wizard-step-indicator')).toBeDefined();
    expect(screen.getByTestId('wizard-step-alpha')).toBeDefined();
    expect(screen.getByTestId('wizard-step-beta')).toBeDefined();
    expect(screen.getByTestId('wizard-step-gamma')).toBeDefined();
    expect(screen.getByTestId('wizard-step-content')).toBeDefined();
  });

  it('should render children content', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>My Wizard Content</div>
      </Wizard>,
    );
    expect(screen.getByText('My Wizard Content')).toBeDefined();
  });

  it('should call onStepChange when next is clicked', () => {
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={onStepChange}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-wizard-next'));
    expect(onStepChange).toHaveBeenCalledWith(1);
  });

  it('should call onStepChange when back is clicked', () => {
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={1} onStepChange={onStepChange}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-wizard-back'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('should disable back button on first step', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-back').getAttribute('aria-disabled')).toBe('true');
  });

  it('should show finish button on last step', () => {
    const onFinish = vi.fn();
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} onFinish={onFinish}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-finish')).toBeDefined();
    fireEvent.click(screen.getByTestId('wizard-wizard-finish'));
    expect(onFinish).toHaveBeenCalled();
  });

  it('should show checkmark for completed steps', () => {
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-check-alpha')).toBeDefined();
    expect(screen.getByTestId('wizard-check-beta')).toBeDefined();
  });

  it('should support custom testIdPrefix', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()} testIdPrefix="custom">
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('custom-wizard')).toBeDefined();
    expect(screen.getByTestId('custom-step-indicator')).toBeDefined();
    expect(screen.getByTestId('custom-step-alpha')).toBeDefined();
    expect(screen.getByTestId('custom-step-content')).toBeDefined();
    expect(screen.getByTestId('custom-wizard-next')).toBeDefined();
    expect(screen.getByTestId('custom-wizard-back')).toBeDefined();
  });

  it('should hide navigation when isFinished is true', () => {
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} isFinished>
        <div>Done</div>
      </Wizard>,
    );
    expect(screen.queryByTestId('wizard-wizard-next')).toBeNull();
    expect(screen.queryByTestId('wizard-wizard-finish')).toBeNull();
    expect(screen.queryByTestId('wizard-wizard-back')).toBeNull();
  });

  it('should disable next when canGoNext is false', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()} canGoNext={false}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('should allow clicking completed steps', () => {
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={onStepChange}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-step-alpha'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('shows completed steps as not clickable while they may not be gone back to', () => {
    // A wizard that ignored the click left them with the hover and the
    // pointer of a step one can go back to.
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={onStepChange} canRevisitSteps={false}>
        <div>Content</div>
      </Wizard>,
    );

    for (const id of ['alpha', 'beta']) {
      const step = screen.getByTestId(`wizard-step-${id}`);
      expect(step).toHaveProperty('disabled', true);
      expect(step.className).not.toContain('cursor-pointer');
      expect(step.className).not.toContain('hover:');
      // Still shown as done.
      expect(screen.getByTestId(`wizard-check-${id}`)).toBeDefined();
    }
    fireEvent.click(screen.getByTestId('wizard-step-alpha'));
    expect(onStepChange).not.toHaveBeenCalled();
  });

  it('should disable future steps', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-step-gamma')).toHaveProperty('disabled', true);
  });

  it('should not render a cancel control when onCancel is omitted', () => {
    render(
      <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.queryByTestId('wizard-wizard-cancel')).toBeNull();
  });

  it('should call onCancel when the cancel control is clicked', () => {
    const onCancel = vi.fn();
    render(
      <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()} onCancel={onCancel}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-wizard-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('should keep the cancel control usable while back and next are disabled', () => {
    const onCancel = vi.fn();
    render(
      <Wizard
        steps={steps}
        currentStep={0}
        onStepChange={vi.fn()}
        canGoNext={false}
        onCancel={onCancel}
      >
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-back').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('wizard-wizard-next').getAttribute('aria-disabled')).toBe('true');
    const cancel = screen.getByTestId('wizard-wizard-cancel');
    expect(cancel).toHaveProperty('disabled', false);
    expect(cancel.getAttribute('aria-disabled')).toBeNull();
  });

  it('should label the cancel control from cancelLabelKey', () => {
    render(
      <Wizard
        steps={steps}
        currentStep={1}
        onStepChange={vi.fn()}
        onCancel={vi.fn()}
        cancelLabelKey="common.cancelRun"
      >
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-cancel').textContent).toBe('Cancel run');
  });

  it('should hide the cancel control once the wizard is finished', () => {
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} onCancel={vi.fn()} isFinished>
        <div>Done</div>
      </Wizard>,
    );
    expect(screen.queryByTestId('wizard-wizard-cancel')).toBeNull();
  });

  it('should show description when descriptionKey is provided', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    // step alpha has descriptionKey, step beta does not
    const alphaButton = screen.getByTestId('wizard-step-alpha');
    expect(alphaButton.querySelectorAll('span').length).toBeGreaterThan(2);
  });

  it('never draws the next step beside the one leaving', async () => {
    // The step that leaves stays in the page while it fades out. Drawn beside
    // it, the next step doubled every control the two share: a click could
    // land on the leaving step, and Seed's relation editor was on screen twice.
    const { rerender } = render(
      <MotionProvider>
        <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
          <button data-testid="alpha-action">Alpha</button>
        </Wizard>
      </MotionProvider>,
    );
    rerender(
      <MotionProvider>
        <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()}>
          <button data-testid="beta-action">Beta</button>
        </Wizard>
      </MotionProvider>,
    );
    expect(screen.queryByTestId('beta-action')).toBeNull();
    await screen.findByTestId('beta-action');
    expect(screen.queryByTestId('alpha-action')).toBeNull();
  });

  describe('a control that cannot be used yet', () => {
    // A focused button that takes the `disabled` attribute hands the focus to
    // the page. Next did under the Enter that asked Autopilot for its scan or
    // its plan: the keyboard started again from the top of the panel.

    it('keeps Next where the focus is while it cannot go on, and ignores it', () => {
      const onStepChange = vi.fn();
      const wizard = (canGoNext: boolean) => (
        <Wizard steps={steps} currentStep={1} onStepChange={onStepChange} canGoNext={canGoNext}>
          <div>Content</div>
        </Wizard>
      );
      const { rerender } = render(wizard(true));
      const next = screen.getByTestId('wizard-wizard-next');
      next.focus();

      rerender(wizard(false));

      expect(screen.getByTestId('wizard-wizard-next')).toBe(next);
      expect(next).toHaveProperty('disabled', false);
      expect(next.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(next);
      fireEvent.click(next);
      expect(onStepChange).not.toHaveBeenCalled();
    });

    it('keeps Back where the focus is while it cannot go back, and ignores it', () => {
      const onStepChange = vi.fn();
      const wizard = (canGoBack: boolean) => (
        <Wizard steps={steps} currentStep={1} onStepChange={onStepChange} canGoBack={canGoBack}>
          <div>Content</div>
        </Wizard>
      );
      const { rerender } = render(wizard(true));
      const back = screen.getByTestId('wizard-wizard-back');
      back.focus();

      rerender(wizard(false));

      expect(back).toHaveProperty('disabled', false);
      expect(back.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(back);
      fireEvent.click(back);
      expect(onStepChange).not.toHaveBeenCalled();
    });

    it('keeps Confirm focusable while the last step cannot finish, and ignores it', () => {
      const onFinish = vi.fn();
      render(
        <Wizard
          steps={steps}
          currentStep={2}
          onStepChange={vi.fn()}
          onFinish={onFinish}
          canGoNext={false}
        >
          <div>Content</div>
        </Wizard>,
      );
      const finish = screen.getByTestId('wizard-wizard-finish');

      expect(finish).toHaveProperty('disabled', false);
      expect(finish.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(finish);
      expect(onFinish).not.toHaveBeenCalled();
    });
  });

  describe('the keyboard on a new step', () => {
    // Left on Next, a second Enter pressed while Seed Clone's preview was
    // prepared ran the clone as soon as the preview came, and on Autopilot,
    // whose last step turns Next into Confirm, started the run once the plan
    // was built. The keyboard goes to the step, which says its name.

    /** The wizard's step, as a screen reader finds it: named after the step it shows. */
    const stepNamed = (name: string): HTMLElement => screen.getByRole('group', { name });

    it('goes to the step Next moves to, off the button', () => {
      const onStepChange = vi.fn();
      const wizard = (currentStep: number) => (
        <Wizard steps={steps} currentStep={currentStep} onStepChange={onStepChange}>
          <div>Content</div>
        </Wizard>
      );
      const { rerender } = render(wizard(0));
      const next = screen.getByTestId('wizard-wizard-next');
      next.focus();
      fireEvent.click(next);

      rerender(wizard(1));

      expect(document.activeElement).toBe(stepNamed(en.seed.selectObjects));
      expect(document.activeElement).toBe(screen.getByTestId('wizard-step-content'));
    });

    it('goes to the first step when Back reaches it, off the button that can no longer be used', () => {
      const wizard = (currentStep: number) => (
        <Wizard steps={steps} currentStep={currentStep} onStepChange={vi.fn()}>
          <div>Content</div>
        </Wizard>
      );
      const { rerender } = render(wizard(1));
      screen.getByTestId('wizard-wizard-back').focus();

      rerender(wizard(0));

      expect(document.activeElement).toBe(stepNamed(en.seed.selectOrg));
    });

    it('goes to the step when what Next waited for has come, off the button', () => {
      // Next on Seed Clone's preview step runs the clone: available once the
      // preview came, it was a keypress away from a write nobody had read.
      const wizard = (canGoNext: boolean) => (
        <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()} canGoNext={canGoNext}>
          <div>Content</div>
        </Wizard>
      );
      const { rerender } = render(wizard(false));
      screen.getByTestId('wizard-wizard-next').focus();

      rerender(wizard(true));

      expect(document.activeElement).toBe(stepNamed(en.seed.selectObjects));
    });

    it('goes to the step from a control the step took off the page', () => {
      // The preview's Execute goes with the preview: the focus it held fell to
      // the page.
      const wizard = (currentStep: number) => (
        <Wizard steps={steps} currentStep={currentStep} onStepChange={vi.fn()}>
          {currentStep === 1 ? <button data-testid="step-action">Execute</button> : <p>Running</p>}
        </Wizard>
      );
      const { rerender } = render(wizard(1));
      screen.getByTestId('step-action').focus();

      rerender(wizard(2));

      expect(document.activeElement).toBe(stepNamed(en.seed.configureFields));
    });

    it('leaves the focus on a control outside the wizard', () => {
      const wizard = (currentStep: number) => (
        <>
          <input aria-label="Elsewhere" data-testid="elsewhere" />
          <Wizard steps={steps} currentStep={currentStep} onStepChange={vi.fn()}>
            <div>Content</div>
          </Wizard>
        </>
      );
      const { rerender } = render(wizard(0));
      const elsewhere = screen.getByTestId('elsewhere');
      elsewhere.focus();

      rerender(wizard(1));

      expect(document.activeElement).toBe(elsewhere);
    });

    it('leaves the focus where it is when the wizard is first drawn', () => {
      render(
        <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()}>
          <div>Content</div>
        </Wizard>,
      );

      expect(document.activeElement).toBe(document.body);
    });

    it('goes to the step it is drawn on when its page brings it back', () => {
      // Autopilot's running view gives the review back when the run did not
      // start, and the focus its heading held went with it.
      render(
        <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} focusStepOnMount>
          <div>Content</div>
        </Wizard>,
      );

      expect(document.activeElement).toBe(stepNamed(en.seed.configureFields));
    });

    it('leaves the focus on a control outside the wizard when its page brings it back', () => {
      const page = (withWizard: boolean) => (
        <>
          <input aria-label="Elsewhere" data-testid="elsewhere" />
          {withWizard && (
            <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} focusStepOnMount>
              <div>Content</div>
            </Wizard>
          )}
        </>
      );
      const { rerender } = render(page(false));
      const elsewhere = screen.getByTestId('elsewhere');
      elsewhere.focus();

      rerender(page(true));

      expect(document.activeElement).toBe(elsewhere);
    });
  });
});
