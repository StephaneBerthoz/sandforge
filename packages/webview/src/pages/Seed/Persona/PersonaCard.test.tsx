import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import type { PersonaMsg } from '@sandforge/shared';
import { PersonaCard, getIndustryIcon } from './PersonaCard';

const mockPersona: PersonaMsg = {
  id: 'assureur-fr',
  name: 'Assureur francais',
  description: "Compagnie d'assurance francaise avec contrats et sinistres.",
  industry: 'Insurance',
  locale: 'fr-FR',
  dataPatterns: {
    Name: { fieldType: 'string', generator: 'faker', examples: ['AXA'] },
    Contract_Type__c: { fieldType: 'picklist', generator: 'random_pick', examples: ['Auto'] },
    Premium__c: { fieldType: 'currency', generator: 'range', examples: ['450.00'] },
  },
};

describe('PersonaCard', () => {
  it('renders persona name, description, and badges', () => {
    render(<PersonaCard persona={mockPersona} onSelect={vi.fn()} onPreview={vi.fn()} />);

    expect(screen.getByText('Assureur francais')).toBeDefined();
    expect(screen.getByText(/Compagnie d'assurance/)).toBeDefined();
    expect(screen.getByTestId('persona-card-assureur-fr')).toBeDefined();
  });

  it('calls onSelect when Select button is clicked', () => {
    const onSelect = vi.fn();
    render(<PersonaCard persona={mockPersona} onSelect={onSelect} onPreview={vi.fn()} />);

    fireEvent.click(screen.getByTestId('persona-select-assureur-fr'));
    expect(onSelect).toHaveBeenCalledWith('assureur-fr');
  });

  it('calls onPreview when Preview button is clicked', () => {
    const onPreview = vi.fn();
    render(<PersonaCard persona={mockPersona} onSelect={vi.fn()} onPreview={onPreview} />);

    fireEvent.click(screen.getByTestId('persona-preview-assureur-fr'));
    expect(onPreview).toHaveBeenCalledWith('assureur-fr');
  });

  it('displays locale badge with flag emoji', () => {
    render(<PersonaCard persona={mockPersona} onSelect={vi.fn()} onPreview={vi.fn()} />);

    // The locale badge should contain the locale code
    expect(screen.getByText(/fr-FR/)).toBeDefined();
  });

  it('shows custom badge when isCustom is true', () => {
    render(<PersonaCard persona={mockPersona} onSelect={vi.fn()} onPreview={vi.fn()} isCustom />);

    expect(screen.getByText(/Custom/i)).toBeDefined();
  });
});

describe('getIndustryIcon', () => {
  it('returns a component for known industries', () => {
    const Icon = getIndustryIcon('Insurance');
    expect(Icon).toBeDefined();
    expect(typeof Icon).toBe('object'); // Lucide icons are forwardRef objects
  });

  it('returns fallback icon for unknown industries', () => {
    const Icon = getIndustryIcon('Unknown Industry');
    expect(Icon).toBeDefined();
  });

  it('returns different icons for different industries', () => {
    const insuranceIcon = getIndustryIcon('Insurance');
    const healthcareIcon = getIndustryIcon('Healthcare');
    expect(insuranceIcon).not.toBe(healthcareIcon);
  });
});
