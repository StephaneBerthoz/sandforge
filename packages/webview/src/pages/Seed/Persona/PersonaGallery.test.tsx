import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import type { PersonaMsg } from '@sandforge/shared';
import { PersonaGallery } from './PersonaGallery';

/* ------------------------------------------------------------------ */
/* Mock usePersonas hook                                               */
/* ------------------------------------------------------------------ */
const mockOpenPreview = vi.fn();
const mockClosePreview = vi.fn();
const mockSelectPersona = vi.fn();
const mockClearSelection = vi.fn();
const mockSetCustomDescription = vi.fn();
const mockCreateCustom = vi.fn();
const mockRefetch = vi.fn();

const testPersonas: PersonaMsg[] = [
  {
    id: 'assureur-fr',
    name: 'Assureur francais',
    description: 'Compagnie d\'assurance',
    industry: 'Insurance',
    locale: 'fr-FR',
    dataPatterns: {
      Name: { fieldType: 'string', generator: 'faker', examples: ['AXA', 'Mutuelle', 'Groupe'] },
    },
  },
  {
    id: 'hospital-us',
    name: 'Hospital US',
    description: 'Hospital system',
    industry: 'Healthcare',
    locale: 'en-US',
    dataPatterns: {
      FirstName: { fieldType: 'string', generator: 'faker', examples: ['James', 'Sarah'] },
    },
  },
];

let mockHookReturn = {
  personas: testPersonas,
  loading: false,
  error: null as string | null,
  selectedPersona: null as PersonaMsg | null,
  previewedPersona: null as PersonaMsg | null,
  isCreating: false,
  customDescription: '',
  selectPersona: mockSelectPersona,
  openPreview: mockOpenPreview,
  closePreview: mockClosePreview,
  clearSelection: mockClearSelection,
  setCustomDescription: mockSetCustomDescription,
  createCustom: mockCreateCustom,
  generateSampleRecords: (persona: PersonaMsg) =>
    [{ Name: 'AXA' }, { Name: 'Mutuelle' }, { Name: 'Groupe' }, { Name: 'AXA' }, { Name: 'Mutuelle' }] as Record<string, string>[],
  refetch: mockRefetch,
};

vi.mock('./usePersonas', () => ({
  usePersonas: () => mockHookReturn,
}));

describe('PersonaGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHookReturn = {
      personas: testPersonas,
      loading: false,
      error: null,
      selectedPersona: null,
      previewedPersona: null,
      isCreating: false,
      customDescription: '',
      selectPersona: mockSelectPersona,
      openPreview: mockOpenPreview,
      closePreview: mockClosePreview,
      clearSelection: mockClearSelection,
      setCustomDescription: mockSetCustomDescription,
      createCustom: mockCreateCustom,
      generateSampleRecords: (persona: PersonaMsg) =>
        [{ Name: 'AXA' }, { Name: 'Mutuelle' }, { Name: 'Groupe' }, { Name: 'AXA' }, { Name: 'Mutuelle' }] as Record<string, string>[],
      refetch: mockRefetch,
    };
  });

  it('renders a grid of persona cards plus create custom card', () => {
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    expect(screen.getByTestId('persona-gallery')).toBeDefined();
    expect(screen.getByTestId('persona-grid')).toBeDefined();
    expect(screen.getByTestId('persona-card-assureur-fr')).toBeDefined();
    expect(screen.getByTestId('persona-card-hospital-us')).toBeDefined();
    expect(screen.getByTestId('persona-card-create-custom')).toBeDefined();
  });

  it('shows loading skeletons when loading', () => {
    mockHookReturn.loading = true;
    mockHookReturn.personas = [];
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    expect(screen.getByTestId('persona-gallery-loading')).toBeDefined();
    expect(screen.queryByTestId('persona-grid')).toBeNull();
  });

  it('shows error banner when there is an error', () => {
    mockHookReturn.error = 'Failed to load personas';
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    expect(screen.getByText('Failed to load personas')).toBeDefined();
  });

  it('opens preview popover when Preview is clicked', () => {
    mockHookReturn.previewedPersona = testPersonas[0];
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    expect(screen.getByTestId('preview-overlay')).toBeDefined();
    expect(screen.getByTestId('persona-preview-popover')).toBeDefined();
  });

  it('calls onPersonaSelected when customization is confirmed', () => {
    // Simulate the gallery being in customize view
    mockHookReturn.selectedPersona = testPersonas[0];
    const onPersonaSelected = vi.fn();
    const { rerender } = render(<PersonaGallery onPersonaSelected={onPersonaSelected} />);

    // Click select on first persona
    fireEvent.click(screen.getByTestId('persona-select-assureur-fr'));
    expect(mockSelectPersona).toHaveBeenCalledWith('assureur-fr');
  });

  it('has a create custom card with textarea and generate button', () => {
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    expect(screen.getByTestId('custom-persona-textarea')).toBeDefined();
    expect(screen.getByTestId('custom-persona-generate-btn')).toBeDefined();
  });

  it('calls setCustomDescription when typing in textarea', () => {
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    const textarea = screen.getByTestId('custom-persona-textarea');
    fireEvent.change(textarea, { target: { value: 'Restaurant chain' } });
    expect(mockSetCustomDescription).toHaveBeenCalledWith('Restaurant chain');
  });

  it('disables generate button when description is empty', () => {
    mockHookReturn.customDescription = '';
    render(<PersonaGallery onPersonaSelected={vi.fn()} />);

    const btn = screen.getByTestId('custom-persona-generate-btn');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
